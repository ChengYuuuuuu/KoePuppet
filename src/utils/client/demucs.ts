import * as ort from 'onnxruntime-web/wasm';
import { DemucsProcessor } from 'demucs-web';
import { fetchWithProgress, DEMUCS_MODEL_SIZE } from './onnxLoader';

ort.env.wasm.wasmPaths = '/ort-wasm/';

const DEMUCS_MODEL_PATH = 'https://pub-73fe157bf73b4d7c9382639fac8a7451.r2.dev/htdemucs_ft_vocals_safe16.onnx';

let processor: DemucsProcessor | null = null;
let demucsLoaded = false;

export async function loadDemucs(
  onProgress?: (loaded: number, total: number) => void,
): Promise<void> {
  if (demucsLoaded) return;
  const buffer = await fetchWithProgress(DEMUCS_MODEL_PATH, onProgress, DEMUCS_MODEL_SIZE);
  processor = new DemucsProcessor({
    ort,
    sessionOptions: {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'basic',
    },
  });
  await processor.loadModel(buffer);
  demucsLoaded = true;
}

export async function separateVocals(audio: Float32Array): Promise<Float32Array> {
  if (!processor) throw new Error('Demucs 模型未加载');
  const result = await processor.separate(audio, audio);
  const v = result.vocals;
  const n = Math.min(v.left.length, audio.length);
  const mono = new Float32Array(n);
  let nan = 0;
  for (let i = 0; i < n; i++) {
    const a = Number.isFinite(v.left[i]) ? v.left[i] : 0;
    const b = Number.isFinite(v.right[i]) ? v.right[i] : 0;
    if (!Number.isFinite(v.left[i]) || !Number.isFinite(v.right[i])) nan++;
    mono[i] = (a + b) / 2;
  }
  if (nan > 0) console.warn(`[demucs] 分离输出含 ${nan} 个非有限值，已置 0`);
  return mono;
}

export function disposeDemucs(): void {
  processor = null;
  demucsLoaded = false;
}
