export async function downloadAndDecodeAudio(url: string): Promise<AudioBuffer | null> {
  try {
    const res = await fetch(url, { mode: 'cors' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    const arrayBuffer = await blob.arrayBuffer();
    return await decodeAudioBuffer(arrayBuffer);
  } catch (err) {
    console.error('音频下载/解码失败:', err);
    return null;
  }
}

export async function fileToAudioBuffer(file: File): Promise<AudioBuffer | null> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    return await decodeAudioBuffer(arrayBuffer);
  } catch (err) {
    console.error('音频文件解码失败:', err);
    return null;
  }
}

async function decodeAudioBuffer(arrayBuffer: ArrayBuffer): Promise<AudioBuffer | null> {
  const ctx = new OfflineAudioContext(1, 1, 44100);
  return await ctx.decodeAudioData(arrayBuffer);
}

export function audioBufferToFloat32(audioBuffer: AudioBuffer, targetSr: number = 44100): Float32Array {
  const channelData = audioBuffer.getChannelData(0);
  if (audioBuffer.sampleRate === targetSr) {
    return channelData;
  }
  const ratio = audioBuffer.sampleRate / targetSr;
  const newLength = Math.round(channelData.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const srcIdx = i * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, channelData.length - 1);
    const frac = srcIdx - lo;
    result[i] = channelData[lo] * (1 - frac) + channelData[hi] * frac;
  }
  return result;
}

export function resampleFloat32(audio: Float32Array, srcSr: number, targetSr: number): Float32Array {
  if (srcSr === targetSr) return audio;
  const ratio = srcSr / targetSr;
  const newLength = Math.round(audio.length / ratio);
  const result = new Float32Array(newLength);
  for (let i = 0; i < newLength; i++) {
    const srcIdx = Math.min(i * ratio, audio.length - 1);
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, audio.length - 1);
    const frac = srcIdx - lo;
    result[i] = audio[lo] * (1 - frac) + audio[hi] * frac;
  }
  return result;
}
