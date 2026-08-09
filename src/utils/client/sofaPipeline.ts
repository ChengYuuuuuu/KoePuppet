import type { ChunkEvent, StreamingCallbacks } from '../streamingSofa';
import { downloadAndDecodeAudio, audioBufferToFloat32 } from './audioDecoder';
import { loadSofaModel, runSofaInference, SOFA_MODEL_SIZE, DEMUCS_MODEL_SIZE } from './onnxLoader';
import { loadDemucs, separateVocals, disposeDemucs } from './demucs';
import { decodePhonemes, edgePredStats } from './viterbi';
import { detectBeats } from './beatDetector';
import { lyricsToPhonemes } from './g2p';
import { setAnalysisState, type AnalysisStage } from './analysisDiag';

const SOFA_MODEL_PATH = 'https://pub-73fe157bf73b4d7c9382639fac8a7451.r2.dev/sofa_mandarin_simplified.onnx';

export const TOTAL_MODEL_SIZE = SOFA_MODEL_SIZE + DEMUCS_MODEL_SIZE;

export interface ModelProgress {
  loaded: number;
  total: number;
  label: string;
}

const FRAME_LENGTH = 512 / (44100 * 4);

interface PipelineState {
  modelLoaded: boolean;
  demucsLoaded: boolean;
  sofaSession: Awaited<ReturnType<typeof loadSofaModel>> | null;
}

let state: PipelineState = { modelLoaded: false, demucsLoaded: false, sofaSession: null };
let currentStage: AnalysisStage = 'audio';

function setStage(stage: AnalysisStage): void {
  currentStage = stage;
  setAnalysisState({ status: 'running', stage });
}

export function getSofaSession(): Awaited<ReturnType<typeof loadSofaModel>> | null {
  return state.sofaSession;
}

export async function loadModels(
  onProgress?: (progress: ModelProgress) => void,
  useVocalSeparation = false,
): Promise<void> {
  const total = useVocalSeparation ? TOTAL_MODEL_SIZE : SOFA_MODEL_SIZE;
  if (!state.sofaSession) {
    state.sofaSession = await loadSofaModel(SOFA_MODEL_PATH, (loaded, _t) =>
      onProgress?.({ loaded, total, label: 'SOFA' })
    );
  }
  state.modelLoaded = true;

  if (useVocalSeparation && !state.demucsLoaded) {
    await loadDemucs((loaded, _t) =>
      onProgress?.({ loaded: SOFA_MODEL_SIZE + loaded, total, label: 'Demucs' })
    );
    state.demucsLoaded = true;
  }
}

function extractChunksFromLRC(
  lyrics: string,
  audioDuration: number,
  minChunk = 40,
  minRemaining = 15,
): Array<{ text: string; start: number; end: number }> {
  const timeRegex = /\[(\d{2}):(\d{2})[.:](\d{2,3})\]/g;
  const lines = lyrics.trim().split('\n');
  const entries: Array<{ time: number; text: string }> = [];

  for (const line of lines) {
    const matches = [...line.matchAll(timeRegex)];
    if (matches.length === 0) continue;
    const text = line.replace(timeRegex, '').replace(/[（(][^）)]*[）)]/g, '').trim();
    if (!text) continue;
    const m = matches[matches.length - 1];
    const minutes = parseInt(m[1]);
    const seconds = parseInt(m[2]);
    let millis = parseInt(m[3]);
    if (m[3].length === 2) millis *= 10;
    entries.push({ time: minutes * 60 + seconds + millis / 1000, text });
  }

  entries.sort((a, b) => a.time - b.time);
  if (entries.length === 0) return [];

  const chunks: Array<{ text: string; start: number; end: number }> = [];
  let chunkStart = 0;
  let chunkStartIdx = 0;

  for (let i = 0; i < entries.length; i++) {
    const t = entries[i].time;
    const dur = t - chunkStart;
    const remaining = audioDuration - t;
    if (dur >= minChunk && remaining > minRemaining) {
      const text = entries.slice(chunkStartIdx, i).map((e) => e.text).join(' ');
      chunks.push({ text, start: chunkStart, end: t });
      chunkStart = t;
      chunkStartIdx = i;
    }
  }

  if (chunkStartIdx < entries.length) {
    const text = entries.slice(chunkStartIdx).map((e) => e.text).join(' ');
    const tailDur = audioDuration - chunkStart;
    if (chunks.length > 0 && tailDur <= minRemaining) {
      const last = chunks[chunks.length - 1];
      last.end = audioDuration;
      last.text = last.text + ' ' + text;
    } else {
      chunks.push({ text, start: chunkStart, end: audioDuration });
    }
  }

  return chunks;
}

async function processChunk(
  audio: Float32Array,
  sampleRate: number,
  lyricsText: string,
  chunkIndex: number,
  offset: number,
  callbacks: StreamingCallbacks,
  useVocalSeparation = false,
): Promise<void> {
  setStage('g2p');
  const g2pResult = await lyricsToPhonemes(lyricsText);
  console.log(`[g2p] chunk ${chunkIndex}: ${g2pResult.ph_seq.length} phones, seq=${g2pResult.ph_seq.join(' ')}`);

  let feed = audio;
  if (useVocalSeparation) {
    setStage('separate');
    try {
      feed = await separateVocals(audio);
    } catch (err) {
      console.warn(`[sep] chunk ${chunkIndex} 分离异常，回退原始音频:`, err);
      feed = audio;
    }
  }

  const waveform = new Float32Array(feed.length);
  waveform.set(feed);

  const paddedLen = Math.ceil(waveform.length / 512) * 512;
  const padded = new Float32Array(paddedLen);
  padded.set(waveform);

  callbacks.onChunkStart?.(chunkIndex, offset, offset + audio.length / sampleRate);

  setStage('infer');
  const result = await runSofaInference(state.sofaSession!, padded);
  const es = edgePredStats(result.phEdgeLogits);
  console.log(
    `[edge] chunk ${chunkIndex}: mean=${es.mean.toFixed(4)} max=${es.max.toFixed(4)} <0.1占比=${(es.lt01 * 100).toFixed(1)}%`
  );
  setStage('decode');
  const { phonemes, confidence } = decodePhonemes(
    new Int32Array(g2pResult.ph_seq_id),
    result.phFrameLogits,
    result.phEdgeLogits,
    g2pResult.ph_seq,
    FRAME_LENGTH,
    65,
  );

  const offsetPhonemes = phonemes.map((p) => ({
    ph: p.ph,
    start: p.start + offset,
    end: p.end + offset,
  }));

  const event: ChunkEvent = {
    type: 'chunk_complete',
    index: chunkIndex,
    start: offset,
    end: offset + audio.length / sampleRate,
    success: true,
    phonemes: offsetPhonemes,
    confidence,
  };
  callbacks.onChunkComplete?.(chunkIndex, event);
}

export async function runPipelineOnAudio(
  audioBuffer: AudioBuffer,
  lyricsText: string,
  callbacks: StreamingCallbacks,
  useVocalSeparation: boolean,
  controller: AbortController,
): Promise<void> {
  try {
    const audio = audioBufferToFloat32(audioBuffer, 44100);
    const chunks = extractChunksFromLRC(lyricsText, audio.length / 44100);

    if (chunks.length === 0) {
      await processChunk(audio, 44100, lyricsText, 0, 0, callbacks, useVocalSeparation);
    } else {
      for (let i = 0; i < chunks.length; i++) {
        if (controller.signal.aborted) break;
        const chunkStart = Math.floor(chunks[i].start * 44100);
        const chunkEnd = Math.min(Math.ceil(chunks[i].end * 44100), audio.length);
        const chunkAudio = audio.slice(chunkStart, chunkEnd);
        await processChunk(chunkAudio, 44100, chunks[i].text, i, chunks[i].start, callbacks, useVocalSeparation);
      }
    }

    if (!controller.signal.aborted) {
      const beats = await detectBeats(audio, 44100);
      callbacks.onBpm?.(beats.bpm, beats.beats);
      callbacks.onComplete?.();
    }
    setAnalysisState({ status: 'done' });
  } catch (err: any) {
    if (err?.name !== 'AbortError') {
      setAnalysisState({
        status: 'error',
        stage: currentStage,
        message: err?.message ?? String(err),
      });
      callbacks.onError?.(err.message ?? String(err));
      callbacks.onComplete?.();
    }
  }
}

export async function runPipeline(
  audioUrl: string,
  lyricsText: string,
  callbacks: StreamingCallbacks,
  useVocalSeparation = false,
): Promise<AbortController> {
  const controller = new AbortController();

  try {
    setStage('audio');
    const audioBuffer = await downloadAndDecodeAudio(audioUrl);
    if (!audioBuffer || controller.signal.aborted) {
      callbacks.onError?.('音频下载失败');
      callbacks.onComplete?.();
      return controller;
    }

    await runPipelineOnAudio(audioBuffer, lyricsText, callbacks, useVocalSeparation, controller);
  } catch (err: any) {
    if (err?.name !== 'AbortError') {
      setAnalysisState({
        status: 'error',
        stage: currentStage,
        message: err?.message ?? String(err),
      });
      callbacks.onError?.(err.message ?? String(err));
      callbacks.onComplete?.();
    }
  }

  return controller;
}

export function disposePipeline(): void {
  state.modelLoaded = false;
  state.demucsLoaded = false;
  state.sofaSession = null;
  disposeDemucs();
}
