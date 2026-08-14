export interface LyricLine {
  time: number;
  text: string;
}

export type LyricAssignment = '1' | '2' | 'both';

export interface SongData {
  title: string;
  artist: string;
  coverUrl: string;
  audioUrl: string;
  lyrics: LyricLine[];
}

export interface MouthImages {
  A: string | null;
  E: string | null;
  I: string | null;
  O: string | null;
  U: string | null;
  closed: string | null;
}

export interface EyeImages {
  blink: string | null;
}

export interface CharacterAssets {
  baseImage: string | null;
  mouthImages: MouthImages;
  eyeImages: EyeImages;
}

export type MouthShape = 'A' | 'E' | 'I' | 'O' | 'U' | 'closed';

export interface MouthPoint {
  char: string;
  start: number;
  end: number;
  mouth: MouthShape;
}
export type RenderMode = 'L3';

export interface PlaybackState {
  isPlaying: boolean;
  currentTime: number;
  duration: number;
  volume: number;
  energy: number;
  currentLyric: LyricLine | null;
}

export interface UIConfig {
  renderMode: RenderMode;
  mouthOffset: { x: number; y: number };
  bounceIntensity: number;
  swayIntensity: number;
  lyricOffset: number;
  backgroundColor: string;
  blinkFrequency: number;
  vocalSeparation: boolean;
}

export interface BounceState {
  phase: 'idle' | 'compress' | 'stretch' | 'reCompress' | 'settle';
  currentBeatIndex: number;
  triggerTime: number;
  scaleX: number;
  scaleY: number;
}

export interface SwayState {
  currentBeatIndex: number;
  angle: number;
}

export interface AudioAnalyserData {
  energy: number;
  frequencyData: Uint8Array;
}

export interface AssetTransform {
  x: number;
  y: number;
  scale: number;
  rotation: number;
}

export const DEFAULT_TRANSFORM: AssetTransform = { x: 0, y: 0, scale: 1, rotation: 0 };

export const DEFAULT_MOUTH_OFFSET = { x: 0, y: -60 };

export interface TimeRange {
  start: number;
  end: number;
}

export const DEFAULT_UI_CONFIG: UIConfig = {
  renderMode: 'L3',
  mouthOffset: { ...DEFAULT_MOUTH_OFFSET },
  bounceIntensity: 0.6,
  swayIntensity: 0.5,
  lyricOffset: 0,
  backgroundColor: '#ffffff',
  blinkFrequency: 30,
  vocalSeparation: false,
};
