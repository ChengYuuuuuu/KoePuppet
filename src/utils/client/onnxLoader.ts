import * as ort from 'onnxruntime-web';

ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.27.0/dist/';
ort.env.wasm.proxy = false;

if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
  console.log('[ort] WebGPU 可用，当前使用 wasm CPU EP 推理');
} else {
  console.log('[ort] WebGPU 不可用，使用 wasm CPU EP 推理');
}

export const SOFA_MODEL_SIZE = 406634124;
export const DEMUCS_MODEL_SIZE = 87695109;

let sofaSession: ort.InferenceSession | null = null;
let demucsSession: ort.InferenceSession | null = null;

const MODEL_CACHE_NAME = 'lip-sync-models-v1';

if (typeof navigator !== 'undefined' && typeof navigator.storage?.persist === 'function') {
  navigator.storage.persist().catch(() => {});
}

async function getModelCache(): Promise<Cache | null> {
  try {
    if (typeof caches === 'undefined') return null;
    return await caches.open(MODEL_CACHE_NAME);
  } catch {
    return null;
  }
}

export async function fetchWithProgress(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
  fallbackTotal?: number,
): Promise<ArrayBuffer> {
  const cache = await getModelCache();
  if (cache) {
    try {
      const cached = await cache.match(url);
      if (cached) {
        const buf = await cached.arrayBuffer();
        const t = fallbackTotal || 1;
        onProgress?.(t, t);
        return buf;
      }
    } catch {
      // 缓存读取失败时回退到网络下载
    }
  }

  const res = await fetch(url);
  if (!res.ok) throw new Error(`模型下载失败: ${res.status} ${res.statusText}`);
  const total = Number(res.headers.get('Content-Length')) || fallbackTotal || 0;

  const reader = res.body?.getReader();
  if (!reader) {
    const buf = await res.arrayBuffer();
    if (total > 0) onProgress?.(buf.byteLength, total);
    if (cache) {
      try {
        await cache.put(url, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } }));
      } catch {
        // 缓存写入失败（如配额不足）不影响本次加载
      }
    }
    return buf;
  }

  const chunks: Uint8Array[] = [];
  let loaded = 0;
  let lastReportedPct = -1;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      loaded += value.byteLength;
      if (total > 0) {
        const pct = Math.floor((loaded / total) * 100);
        if (pct !== lastReportedPct) {
          lastReportedPct = pct;
          onProgress?.(loaded, total);
        }
      } else {
        onProgress?.(loaded, total);
      }
    }
  }
  if (total > 0 && lastReportedPct < 100) {
    onProgress?.(loaded, total);
  }

  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }

  if (cache) {
    try {
      await cache.put(url, new Response(out.buffer, { headers: { 'Content-Type': 'application/octet-stream' } }));
    } catch {
      // 缓存写入失败不影响本次加载
    }
  }

  return out.buffer;
}

export async function loadSofaModel(
  modelPath: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ort.InferenceSession> {
  if (sofaSession) return sofaSession;
  const buffer = await fetchWithProgress(modelPath, onProgress, SOFA_MODEL_SIZE);
  sofaSession = await ort.InferenceSession.create(buffer, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'basic',
  });
  return sofaSession;
}

export async function loadDemucsModel(
  modelPath: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<ort.InferenceSession> {
  if (demucsSession) return demucsSession;
  const buffer = await fetchWithProgress(modelPath, onProgress, DEMUCS_MODEL_SIZE);
  demucsSession = await ort.InferenceSession.create(buffer, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'basic',
  });
  return demucsSession;
}

export async function runSofaInference(
  session: ort.InferenceSession,
  waveform: Float32Array,
): Promise<{ phFrameLogits: Float32Array; phEdgeLogits: Float32Array }> {
  const dims = [1, waveform.length];
  const tensor = new ort.Tensor('float32', waveform, dims);
  const feeds: Record<string, ort.Tensor> = { 'waveform': tensor };
  const results = await session.run(feeds);
  const phFrame = results['ph_frame_logits'];
  const phEdge = results['ph_edge_logits'];
  return {
    phFrameLogits: new Float32Array(phFrame.data as Float32Array),
    phEdgeLogits: new Float32Array(phEdge.data as Float32Array),
  };
}

export function disposeSofaModel(): void {
  sofaSession?.release();
  sofaSession = null;
}

export function disposeDemucsModel(): void {
  demucsSession?.release();
  demucsSession = null;
}
