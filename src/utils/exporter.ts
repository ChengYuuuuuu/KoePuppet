import { Muxer, ArrayBufferTarget } from 'mp4-muxer';
import {
  type MouthPoint,
  type LyricLine,
  type UIConfig,
  type AssetTransform,
  type LyricAssignment,
  type CharacterAssets,
  type MouthShape,
  type BounceState,
  type SwayState,
} from '../types/index';
import { renderFrame } from './renderer';
import { updateBounce, computeSway } from './audio';
import { getCurrentLyric } from './api';
import { CanvasLyricOverlay } from './exportLyrics';

export const EXPORT_WIDTH = 1280;
export const EXPORT_HEIGHT = 720;
export const EXPORT_FPS = 30;

export interface ExportInput {
  audioBuffer: AudioBuffer | null;
  timeline: MouthPoint[];
  beatTimes: number[];
  lyrics: LyricLine[];
  charAssignments: Record<string, LyricAssignment>;
  config: UIConfig;
  transforms: Record<string, AssetTransform>;
  assets: CharacterAssets;
  assets2: CharacterAssets;
  baseImage: HTMLImageElement | null;
  mouthImages: Record<string, HTMLImageElement | null>;
  eyeImages: Record<string, HTMLImageElement | null>;
  baseImage2: HTMLImageElement | null;
  mouthImages2: Record<string, HTMLImageElement | null>;
  eyeImages2: Record<string, HTMLImageElement | null>;
  title: string;
}

export interface ExportCallbacks {
  onStatus: (text: string) => void;
  onProgress: (percent: number) => void;
  isCancelled: () => boolean;
}

export interface ExportUiState {
  status: 'idle' | 'exporting' | 'done' | 'error';
  progress: number;
  message: string;
}

const VIDEO_CODECS = ['avc1.42E01E', 'avc1.42001f', 'avc1.4d401f', 'avc1.64001f'];
const VIDEO_BITRATE = 5_000_000;
const AUDIO_BITRATE = 128_000;
const AAC_BLOCK = 1024;

function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForEncoder(encoder: VideoEncoder | AudioEncoder): Promise<void> {
  while (encoder.encodeQueueSize > 4) {
    await yieldToUI();
  }
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildBlinkSchedule(duration: number, frequency: number): Array<[number, number]> {
  if (frequency <= 0) return [];
  const rand = mulberry32(20240817);
  const minInterval = 0.5;
  const maxInterval = 10;
  const interval = maxInterval - (frequency / 100) * (maxInterval - minInterval);
  const schedule: Array<[number, number]> = [];
  let t = interval * (0.5 + rand());
  while (t < duration) {
    schedule.push([t, Math.min(t + 0.15, duration)]);
    t += interval * (0.5 + rand());
  }
  return schedule;
}

function prepareChannels(buffer: AudioBuffer | null): { data: Float32Array[]; channels: number } {
  if (!buffer) return { data: [], channels: 0 };
  const src = buffer.numberOfChannels;
  if (src === 1) {
    return { data: [buffer.getChannelData(0)], channels: 1 };
  }
  return {
    channels: 2,
    data: [buffer.getChannelData(0), buffer.getChannelData(1)],
  };
}

function frameEnergy(buffer: AudioBuffer | null, t: number, step: number): number {
  if (!buffer) return 0;
  const sr = buffer.sampleRate;
  const start = Math.floor(t * sr);
  const len = Math.max(1, Math.floor(step * sr));
  const ch = buffer.getChannelData(0);
  let sum = 0;
  const end = Math.min(start + len, ch.length);
  for (let i = start; i < end; i++) {
    sum += ch[i] * ch[i];
  }
  const rms = Math.sqrt(sum / (end - start || 1));
  return Math.min(255, Math.round(rms * 800));
}

async function pickVideoCodec(width: number, height: number, fps: number): Promise<string> {
  for (const codec of VIDEO_CODECS) {
    try {
      const s = await VideoEncoder.isConfigSupported({
        codec,
        width,
        height,
        bitrate: VIDEO_BITRATE,
        framerate: fps,
      });
      if (s.supported) return codec;
    } catch {
      // try next codec
    }
  }
  throw new Error('当前浏览器不支持 H.264 视频编码');
}

function extractAvcC(data: Uint8Array): Uint8Array | null {
  let sps: Uint8Array | null = null;
  let pps: Uint8Array | null = null;
  let off = 0;
  while (off + 4 <= data.length) {
    const len = (data[off] << 24) | (data[off + 1] << 16) | (data[off + 2] << 8) | data[off + 3];
    if (len <= 0 || off + 4 + len > data.length) break;
    const nalType = data[off + 4] & 0x1f;
    if (nalType === 7) sps = data.slice(off + 4, off + 4 + len);
    else if (nalType === 8) pps = data.slice(off + 4, off + 4 + len);
    if (sps && pps) break;
    off += 4 + len;
  }
  if (!sps || !pps) return null;

  const record = new Uint8Array(1 + 1 + 1 + 1 + 2 + 1 + 2 + sps.length + 1 + 2 + pps.length);
  record[0] = 1; // configurationVersion
  record[1] = sps[0]; // AVCProfileIndication
  record[2] = sps[1]; // profile_compatibility
  record[3] = sps[2]; // AVCLevelIndication
  record[4] = 0xff; // reserved(6) + lengthSizeMinusOne(2) = 4-byte NAL length
  record[5] = 0xe1; // reserved(3) + numOfSPS(5)
  record[6] = (sps.length >> 8) & 0xff;
  record[7] = sps.length & 0xff;
  record.set(sps, 8);
  const ppsOffset = 8 + sps.length;
  record[ppsOffset] = 1; // numOfPPS
  record[ppsOffset + 1] = (pps.length >> 8) & 0xff;
  record[ppsOffset + 2] = pps.length & 0xff;
  record.set(pps, ppsOffset + 3);
  return record;
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function exportToMP4(input: ExportInput, cb: ExportCallbacks): Promise<void> {
  if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined') {
    throw new Error('此浏览器不支持 WebCodecs 导出，请使用 Chrome/Edge 94+ 或 Safari 17+');
  }

  const width = EXPORT_WIDTH;
  const height = EXPORT_HEIGHT;
  const fps = EXPORT_FPS;
  const step = 1 / fps;
  const duration = input.audioBuffer ? input.audioBuffer.duration : 0;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建导出画布');

  const audioChannels = prepareChannels(input.audioBuffer);

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width, height, frameRate: fps },
    audio: input.audioBuffer
      ? {
          codec: 'aac',
          numberOfChannels: audioChannels.channels,
          sampleRate: input.audioBuffer.sampleRate,
        }
      : undefined,
    fastStart: 'in-memory',
  });

  let encodeError: Error | null = null;
  const fail = (e: Error) => {
    if (!encodeError) encodeError = e;
  };

  const videoCodec = await pickVideoCodec(width, height, fps);
  cb.onStatus('初始化视频编码器…');
  let videoDecoderConfig: VideoDecoderConfig | null = null;
  let firstChunkData: Uint8Array | null = null;
  const videoEncoder = new VideoEncoder({
    output: (chunk, meta) => {
      if (!videoDecoderConfig) {
        if (meta?.decoderConfig) {
          videoDecoderConfig = meta.decoderConfig;
        } else if (!firstChunkData) {
          firstChunkData = new Uint8Array(chunk.byteLength);
          chunk.copyTo(firstChunkData);
          const avcC = extractAvcC(firstChunkData);
          if (avcC) {
            videoDecoderConfig = {
              codec: videoCodec,
              codedWidth: width,
              codedHeight: height,
              description: avcC,
              colorSpace: { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: true },
            };
          }
        }
      }
      muxer.addVideoChunk(chunk, videoDecoderConfig ? { decoderConfig: videoDecoderConfig } : meta);
    },
    error: fail,
  });
  videoEncoder.configure({
    codec: videoCodec,
    width,
    height,
    bitrate: VIDEO_BITRATE,
    framerate: fps,
  });

  let audioEncoder: AudioEncoder | null = null;
  const audioBuffer = input.audioBuffer;
  if (audioBuffer) {
    try {
      const audioSupport = await AudioEncoder.isConfigSupported({
        codec: 'mp4a.40.2',
        sampleRate: audioBuffer.sampleRate,
        numberOfChannels: audioChannels.channels,
        bitrate: AUDIO_BITRATE,
      });
      if (!audioSupport.supported) throw new Error('AAC 音频编码不受支持');
    } catch (err) {
      videoEncoder.close();
      muxer.finalize();
      throw new Error(`音频编码初始化失败：${err instanceof Error ? err.message : String(err)}`);
    }
    cb.onStatus('初始化音频编码器…');
    audioEncoder = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: fail,
    });
    audioEncoder.configure({
      codec: 'mp4a.40.2',
      sampleRate: audioBuffer.sampleRate,
      numberOfChannels: audioChannels.channels,
      bitrate: AUDIO_BITRATE,
    });
  }

  if (encodeError) {
    videoEncoder.close();
    audioEncoder?.close();
    muxer.finalize();
    throw encodeError;
  }

  let bounceState: BounceState = { phase: 'idle', currentBeatIndex: -1, triggerTime: 0, scaleX: 1, scaleY: 1 };
  let swayState: SwayState = { currentBeatIndex: -1, angle: 0 };
  const blinkSchedule = buildBlinkSchedule(duration, input.config.blinkFrequency);
  let blinkIdx = 0;
  let tlIdx = 0;
  const timeline = input.timeline;
  const overlay = new CanvasLyricOverlay();

  cb.onStatus('渲染视频帧…');
  let t = 0;
  let frameIndex = 0;
  const totalFrames = Math.ceil(duration * fps);
  while (t < duration) {
    if (cb.isCancelled()) {
      videoEncoder.close();
      audioEncoder?.close();
      muxer.finalize();
      throw new Error('导出已取消');
    }

    while (blinkIdx < blinkSchedule.length && blinkSchedule[blinkIdx][1] <= t) blinkIdx++;
    const isBlinking =
      blinkIdx < blinkSchedule.length && t >= blinkSchedule[blinkIdx][0] && t < blinkSchedule[blinkIdx][1];

    while (tlIdx < timeline.length - 1 && t >= timeline[tlIdx].end) tlIdx++;
    let mouth: MouthShape = 'closed';
    if (tlIdx < timeline.length && t >= timeline[tlIdx].start && t <= timeline[tlIdx].end) {
      mouth = timeline[tlIdx].mouth;
    }

    const currentLyric = getCurrentLyric(input.lyrics, t, input.config.lyricOffset);
    const energy = frameEnergy(audioBuffer, t, step);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    bounceState = updateBounce(bounceState, t, input.beatTimes, input.config.bounceIntensity);
    swayState = computeSway(swayState, t, input.beatTimes, input.config.swayIntensity, step);
    const bounce = bounceState;
    const sway = swayState;

    renderFrame({
      ctx,
      width,
      height,
      time: t,
      energy,
      mouthShape: mouth,
      bounceScale: bounce,
      swayAngle: sway.angle,
      currentLyric,
      assets: input.assets,
      config: input.config,
      mouthImagesLoaded: input.mouthImages,
      eyeImagesLoaded: input.eyeImages,
      isBlinking,
      baseImageLoaded: input.baseImage,
      assets2: input.assets2,
      baseImageLoaded2: input.baseImage2,
      mouthImagesLoaded2: input.mouthImages2,
      eyeImagesLoaded2: input.eyeImages2,
      prevLyric: null,
      lyricTransition: 1,
      transforms: input.transforms,
      editMode: false,
      selectedAsset: null,
      visibleBounds: {},
      charAssignments: input.charAssignments,
      showHUD: false,
    });

    overlay.update(ctx, t, currentLyric, input.charAssignments);
    overlay.draw(ctx, width, height, input.transforms);

    const frameInit = {
      timestamp: Math.round(t * 1_000_000),
      duration: Math.round(step * 1_000_000),
    };
    let frame: VideoFrame;
    try {
      const bitmap = await createImageBitmap(canvas);
      try {
        frame = new VideoFrame(bitmap, frameInit);
      } finally {
        bitmap.close();
      }
    } catch {
      frame = new VideoFrame(canvas, frameInit);
    }
    videoEncoder.encode(frame);
    frame.close();

    t += step;
    frameIndex++;
    if (frameIndex % 20 === 0) {
      const pct = Math.round((frameIndex / Math.max(1, totalFrames)) * 85);
      cb.onProgress(Math.min(85, pct));
      await yieldToUI();
      if (encodeError) break;
    }
    await waitForEncoder(videoEncoder);
    if (encodeError) break;
  }

  if (!encodeError) await videoEncoder.flush();
  if (encodeError) {
    videoEncoder.close();
    audioEncoder?.close();
    muxer.finalize();
    throw encodeError;
  }

  if (audioEncoder && audioBuffer) {
    cb.onStatus('编码音频…');
    const sampleRate = audioBuffer.sampleRate;
    const totalFrames2 = audioBuffer.length;
    const channelData = audioChannels.data;
    const channels = audioChannels.channels;

    let offset = 0;
    let micros = 0;
    while (offset < totalFrames2) {
      if (cb.isCancelled()) {
        audioEncoder.close();
        videoEncoder.close();
        muxer.finalize();
        throw new Error('导出已取消');
      }
      const n = Math.min(AAC_BLOCK, totalFrames2 - offset);
      const planar = new Float32Array(n * channels);
      for (let ch = 0; ch < channels; ch++) {
        planar.set(channelData[ch].subarray(offset, offset + n), ch * n);
      }
      const data = new AudioData({
        format: 'f32-planar',
        sampleRate,
        numberOfFrames: n,
        numberOfChannels: channels,
        timestamp: micros,
        data: planar.buffer,
      });
      audioEncoder.encode(data);
      data.close();
      offset += n;
      micros += Math.round((n / sampleRate) * 1_000_000);
      if (offset % (AAC_BLOCK * 16) === 0) {
        cb.onProgress(85 + Math.round((offset / totalFrames2) * 11));
        await yieldToUI();
      }
      await waitForEncoder(audioEncoder);
      if (encodeError) break;
    }
    if (!encodeError) await audioEncoder.flush();
  }

  if (encodeError) {
    videoEncoder.close();
    audioEncoder?.close();
    muxer.finalize();
    throw encodeError;
  }

  cb.onStatus('合成 MP4…');
  cb.onProgress(97);
  await yieldToUI();
  muxer.finalize();

  videoEncoder.close();
  audioEncoder?.close();

  const buffer = muxer.target.buffer;
  const blob = new Blob([buffer], { type: 'video/mp4' });
  const safeTitle = (input.title || '对口型动画').replace(/[\\/:*?"<>|]/g, '_').trim() || '对口型动画';
  const filename = `${safeTitle}.mp4`;
  cb.onProgress(100);
  cb.onStatus('完成');
  downloadBlob(blob, filename);
}
