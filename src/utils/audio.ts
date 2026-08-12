import {
  type AudioAnalyserData,
  type BounceState,
  type SwayState,
} from '../types/index';

// ── AudioEngine ──

export class AudioEngine {
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private gainNode: GainNode | null = null;
  private source: AudioBufferSourceNode | null = null;
  private mediaSource: MediaElementAudioSourceNode | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private buffer: AudioBuffer | null = null;
  private isPlaying = false;
  private startTime = 0;
  private pauseOffset = 0;
  private duration = 0;
  private _loopTimer: ReturnType<typeof setInterval> | null = null;
  private _frequencyData: Uint8Array<ArrayBuffer> | null = null;
  private onFrame: ((data: AudioAnalyserData, currentTime: number) => void) | null = null;
  private onEnded: (() => void) | null = null;
  private useElement = false;

  private isUserPause = false;
  private onPlayStateChange: ((playing: boolean) => void) | null = null;

  async loadAudio(url: string): Promise<void> {
    this.destroy();
    this.context = new AudioContext();

    try {
      const response = await fetch(url, { mode: 'cors' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const arrayBuffer = await response.arrayBuffer();
      this.buffer = await this.context.decodeAudioData(arrayBuffer);
      this.duration = this.buffer.duration;
      this.useElement = false;
    } catch {
      await this.loadViaElement(url);
    }

    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 256;
    this._frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
    this.gainNode = this.context.createGain();
    this.gainNode.gain.value = 0.7;
  }

  private loadViaElement(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const audio = new Audio();
      audio.crossOrigin = 'anonymous';
      audio.src = url;
      this.audioElement = audio;
      this.useElement = true;

      audio.addEventListener('canplaythrough', () => {
        this.duration = audio.duration;
        resolve();
      }, { once: true });

      audio.addEventListener('error', () => {
        reject(new Error('音频加载失败（CORS 或地址无效）'));
      }, { once: true });

      audio.load();
    });
  }

  loadFromFile(file: File): Promise<void> {
    return new Promise((resolve, reject) => {
      this.destroy();
      this.context = new AudioContext();
      this.analyser = this.context.createAnalyser();
      this.analyser.fftSize = 256;
      this._frequencyData = new Uint8Array(this.analyser.frequencyBinCount);
      this.gainNode = this.context.createGain();
      this.gainNode.gain.value = 0.7;

      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const arrayBuffer = reader.result as ArrayBuffer;
          this.buffer = await this.context!.decodeAudioData(arrayBuffer);
          this.duration = this.buffer.duration;
          this.useElement = false;
          resolve();
        } catch {
          reject(new Error('音频解码失败'));
        }
      };
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsArrayBuffer(file);
    });
  }

  onPlayStateChangeCallback(callback: (playing: boolean) => void): void {
    this.onPlayStateChange = callback;
  }

  private setPlaying(v: boolean): void {
    if (this.isPlaying === v) return;
    this.isPlaying = v;
    this.onPlayStateChange?.(v);
  }

  play(): void {
    if (!this.context || (!this.buffer && !this.audioElement)) return;
    if (this.isPlaying) return;

    this.isUserPause = false;

    if (this.context.state === 'suspended') {
      this.context.resume();
    }

    if (this.useElement && this.audioElement) {
      if (!this.mediaSource) {
        this.mediaSource = this.context.createMediaElementSource(this.audioElement);
        this.mediaSource.connect(this.analyser!);
        this.analyser!.connect(this.gainNode!);
        this.gainNode!.connect(this.context.destination);
      }
      this.audioElement.currentTime = this.pauseOffset;
      this.audioElement.play().catch(() => {});
      this.setPlaying(true);
      this.startLoop();
      this.audioElement.onended = () => {
        this.setPlaying(false);
        this.pauseOffset = 0;
        this.onEnded?.();
      };
      return;
    }

    if (!this.buffer) return;

    this.source = this.context.createBufferSource();
    this.source.buffer = this.buffer;
    this.source.connect(this.analyser!);
    this.analyser!.connect(this.gainNode!);
    this.gainNode!.connect(this.context.destination);

    this.source.start(0, this.pauseOffset);
    this.startTime = this.context.currentTime - this.pauseOffset;
    this.setPlaying(true);

    this.source.onended = () => {
      if (!this.isUserPause && this.isPlaying) {
        this.setPlaying(false);
        this.pauseOffset = 0;
        this.onEnded?.();
      }
    };

    this.startLoop();
  }

  pause(): void {
    this.isUserPause = true;
    if (this.useElement && this.audioElement) {
      this.audioElement.pause();
      this.pauseOffset = this.audioElement.currentTime;
      this.setPlaying(false);
    } else if (this.context && this.source) {
      this.source.stop();
      this.source?.disconnect();
      this.source = null;
      this.pauseOffset = this.context.currentTime - this.startTime;
      this.setPlaying(false);
    }
    this.stopLoop();
  }

  stop(): void {
    this.isUserPause = true;
    if (this.useElement && this.audioElement) {
      this.audioElement.pause();
      this.audioElement.currentTime = 0;
    } else {
      this.source?.stop();
      this.source?.disconnect();
      this.source = null;
    }
    this.setPlaying(false);
    this.pauseOffset = 0;
    this.stopLoop();
  }

  seek(time: number): void {
    const target = Math.min(Math.max(time, 0), this.duration);
    const wasPlaying = this.isPlaying;

    if (this.useElement && this.audioElement) {
      this.pauseOffset = target;
      this.audioElement.currentTime = target;
      this.onFrame?.({ energy: 0, frequencyData: new Uint8Array(0) }, target);
      if (wasPlaying) {
        this.audioElement.play().catch(() => {});
      }
      return;
    }

    if (!this.buffer) return;

    if (this.source) {
      this.source.onended = null;
      try { this.source.stop(); } catch {}
      this.source.disconnect();
      this.source = null;
    }
    this.stopLoop();

    this.pauseOffset = target;

    if (wasPlaying && this.context) {
      this.source = this.context.createBufferSource();
      this.source.buffer = this.buffer;
      this.source.connect(this.analyser!);
      this.analyser!.connect(this.gainNode!);
      this.gainNode!.connect(this.context.destination);
      this.source.start(0, this.pauseOffset);
      this.startTime = this.context.currentTime - this.pauseOffset;
      this.source.onended = () => {
        if (!this.isUserPause && this.isPlaying) {
          this.setPlaying(false);
          this.pauseOffset = 0;
          this.onEnded?.();
        }
      };
      this.onFrame?.({ energy: 0, frequencyData: new Uint8Array(0) }, this.pauseOffset);
      this.startLoop();
    }
  }

  setVolume(value: number): void {
    if (this.gainNode) {
      this.gainNode.gain.value = Math.max(0, Math.min(1, value));
    }
    if (this.audioElement) {
      this.audioElement.volume = Math.max(0, Math.min(1, value));
    }
  }

  getCurrentTime(): number {
    if (this.useElement && this.audioElement) {
      return this.audioElement.currentTime;
    }
    if (!this.context || !this.isPlaying) return this.pauseOffset;
    return this.context.currentTime - this.startTime;
  }

  getDuration(): number {
    return this.duration;
  }

  getAudioContext(): AudioContext | null {
    return this.context;
  }

  onFrameUpdate(callback: (data: AudioAnalyserData, currentTime: number) => void): void {
    this.onFrame = callback;
  }

  onPlayEnded(callback: () => void): void {
    this.onEnded = callback;
  }

  private startLoop(): void {
    const LOOP_MS = 66;
    this._loopTimer = setInterval(() => {
      if (!this.isPlaying || !this.analyser || !this.context) return;

      const frequencyData = this._frequencyData!;
      this.analyser.getByteFrequencyData(frequencyData);

      let energy = 0;
      for (let i = 0; i < frequencyData.length; i++) {
        energy += frequencyData[i];
      }
      energy = energy / frequencyData.length;

      this.onFrame?.({ energy, frequencyData }, this.getCurrentTime());
    }, LOOP_MS);
  }

  private stopLoop(): void {
    if (this._loopTimer !== null) {
      clearInterval(this._loopTimer);
      this._loopTimer = null;
    }
  }

  destroy(): void {
    this.stopLoop();
    this.source?.stop();
    this.source?.disconnect();
    this.mediaSource?.disconnect();
    this.analyser?.disconnect();
    this.gainNode?.disconnect();
    this.context?.close();
    this.audioElement?.pause();
    this.context = null;
    this.analyser = null;
    this.gainNode = null;
    this.source = null;
    this.mediaSource = null;
    this.audioElement = null;
    this.buffer = null;
    this.setPlaying(false);
    this.pauseOffset = 0;
    this.duration = 0;
    this.useElement = false;
  }

  get playing(): boolean {
    return this.isPlaying;
  }
}

// ── Bounce Engine ──

export function updateBounce(
  state: BounceState,
  currentTime: number,
  beatTimes: number[],
  intensity: number
): BounceState {
  let { phase, currentBeatIndex, triggerTime } = state;
  const i = intensity * 0.86;

  const nextBeat = currentBeatIndex + 1;
  const hasNext = nextBeat < beatTimes.length;
  const beatStart = hasNext ? beatTimes[nextBeat] : Infinity;
  const beatDuration = hasNext && nextBeat + 1 < beatTimes.length
    ? beatTimes[nextBeat + 1] - beatTimes[nextBeat]
    : 0.5;

  // Detect new beat
  if (hasNext && currentTime >= beatStart && currentBeatIndex < nextBeat) {
    return {
      phase: 'compress', currentBeatIndex: nextBeat, triggerTime: currentTime,
      scaleX: 1,
      scaleY: 1,
    };
  }

  if (phase === 'idle') {
    return { phase: 'idle', currentBeatIndex, triggerTime: 0, scaleX: 1, scaleY: 1 };
  }

  const t = (currentTime - triggerTime) / beatDuration;

  // Keyframes: [t, scaleX, scaleY]
  const kf: [number, number, number][] = [
    [0.00, 1, 1],
    [0.10, 1 + 0.05 * i, 1 - 0.05 * i],
    [0.55, 1 - 0.10 * i, 1 + 0.10 * i],
    [1.00, 1, 1],
  ];

  if (t >= 1) {
    return { phase: 'idle', currentBeatIndex, triggerTime: 0, scaleX: 1, scaleY: 1 };
  }

  // Find segment and interpolate
  for (let s = 0; s < kf.length - 1; s++) {
    const [t0, x0, y0] = kf[s];
    const [t1, x1, y1] = kf[s + 1];
    if (t >= t0 && t < t1) {
      const p = (t - t0) / (t1 - t0);
      const ease = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2;
      return {
        phase: s === 0 ? 'compress' : s === 1 ? 'stretch' : s === 2 ? 'reCompress' : 'settle',
        currentBeatIndex, triggerTime,
        scaleX: x0 + (x1 - x0) * ease,
        scaleY: y0 + (y1 - y0) * ease,
      };
    }
  }

  return state;
}

// ── Sway Engine (beat-driven, smooth ease toward alternating target) ──

export function computeSway(
  state: SwayState,
  t: number,
  beatTimes: number[],
  intensity: number,
  dt: number,
): SwayState {
  let { currentBeatIndex, angle } = state;

  if (intensity <= 0 || beatTimes.length === 0) {
    return { currentBeatIndex: -1, angle: 0 };
  }

  const next = currentBeatIndex + 1;
  if (next < beatTimes.length && t >= beatTimes[next]) {
    currentBeatIndex = next;
  }

  const dir = currentBeatIndex < 0 ? 0 : (currentBeatIndex % 2 === 0 ? -1 : 1);
  const target = dir * 0.05 * (0.3 + intensity * 0.7);
  const k = 6;
  angle += (target - angle) * (1 - Math.exp(-dt * k));

  if (currentBeatIndex < 0) angle = 0;

  return { currentBeatIndex, angle };
}
