import { useState, useRef, useEffect, useCallback } from 'react';
import { CanvasPreview, RightPanel } from './components/Panel';
import { AudioEngine, updateBounce } from './utils/audio';
import { parseLRC, getCurrentLyric } from './utils/api';
import { loadImage } from './utils/renderer';
import { saveUIConfig, loadUIConfig, loadBaseImage, loadMouthImages, loadAssetTransforms, saveAssetTransforms, loadEyeImages, loadBaseImage2, loadMouthImages2, loadEyeImages2 } from './utils/storage';
import { analyzeSofaUrlChunked } from './utils/streamingSofa';
import { phonemesToMouthPoints } from './utils/mouthMapper';
import {
  type LyricLine,
  type CharacterAssets,
  type UIConfig,
  type PlaybackState,
  type MouthShape,
  type MouthImages,
  type MouthPoint,
  type BounceState,
  type AssetTransform,
  type EyeImages,
  type TimeRange,
  type LyricAssignment,
  DEFAULT_TRANSFORM,
} from './types/index';
import './styles/app.css';

import tetoBase from './assets/teto-底.png';
import tetoA from './assets/teto-a.png';
import tetoE from './assets/teto-e.png';
import tetoI from './assets/teto-i.png';
import tetoO from './assets/teto-o.png';
import tetoU from './assets/teto-u.png';
import tetoClosed from './assets/teto-closed.png';
import tetoBlink from './assets/teto-闭.png';

const defaultMouthImages: MouthImages = {
  A: tetoA, E: tetoE, I: tetoI, O: tetoO, U: tetoU, closed: tetoClosed,
};

const defaultEyeImages: EyeImages = {
  blink: tetoBlink,
};

const defaultAssets: CharacterAssets = {
  baseImage: tetoBase,
  mouthImages: { ...defaultMouthImages },
  eyeImages: { ...defaultEyeImages },
};

export default function App() {
  const [config, setConfig] = useState<UIConfig>(() => {
    const loaded = loadUIConfig();
    return loaded;
  });

  const [assets, setAssets] = useState<CharacterAssets>(() => ({
    ...defaultAssets,
    mouthImages: { ...defaultAssets.mouthImages },
  }));

  const [assets2, setAssets2] = useState<CharacterAssets>({
    baseImage: null,
    mouthImages: { A: null, E: null, I: null, O: null, U: null, closed: null },
    eyeImages: { blink: null },
  });

  const [playbackState, setPlaybackState] = useState<PlaybackState>({
    isPlaying: false,
    currentTime: 0,
    duration: 0,
    volume: 0.7,
    energy: 0,
    currentLyric: null,
  });

  const [songInfo, setSongInfo] = useState<{ title: string; artist: string; coverUrl: string } | null>(null);
  const [lyricsList, setLyricsList] = useState<LyricLine[]>([]);
  const [charAssignments, setCharAssignments] = useState<Record<string, LyricAssignment>>({});
  const [mouthShape, setMouthShape] = useState<MouthShape>('closed');
  const [bounceScale, setBounceScale] = useState({ scaleX: 1, scaleY: 1 });
  const [beatTimes, setBeatTimes] = useState<number[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [processedRanges, setProcessedRanges] = useState<TimeRange[]>([]);

  const [editMode, setEditMode] = useState(false);
  const [transforms, setTransforms] = useState<Record<string, AssetTransform>>({});
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);

  useEffect(() => {
    loadAssetTransforms().then(saved => {
      if (saved) setTransforms(saved);
    });
  }, []);

  const handleConfirmEdit = useCallback(async () => {
    await saveAssetTransforms(transforms);
    setEditMode(false);
    setSelectedAsset(null);
  }, [transforms]);

  const handleResetAssetTransform = useCallback((key: string) => {
    setTransforms((prev) => {
      const next = { ...prev, [key]: { ...DEFAULT_TRANSFORM } };
      saveAssetTransforms(next);
      return next;
    });
  }, []);

  const audioEngineRef = useRef<AudioEngine | null>(null);
  const bounceStateRef = useRef<BounceState>({ phase: 'idle', currentBeatIndex: -1, triggerTime: 0, scaleX: 1, scaleY: 1 });
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const whisperTimelineRef = useRef<MouthPoint[]>([]);
  const beatTimesRef = useRef<number[]>([]);
  const configRef = useRef(config);
  const energyHistoryRef = useRef<number[]>([]);
  const blinkTimerRef = useRef<number[]>([]);
  const abortControllerRef = useRef<AbortController | null>(null);
  const receivedChunksRef = useRef<Map<number, MouthPoint[]>>(new Map());
  configRef.current = config;
  beatTimesRef.current = beatTimes;

  const [baseImageLoaded, setBaseImageLoaded] = useState<HTMLImageElement | null>(null);
  const [eyeImagesLoaded, setEyeImagesLoaded] = useState<Record<string, HTMLImageElement | null>>({});
  const [isBlinking, setIsBlinking] = useState(false);
  const [mouthImagesLoaded, setMouthImagesLoaded] = useState<Record<string, HTMLImageElement | null>>({});
  const [baseImageLoaded2, setBaseImageLoaded2] = useState<HTMLImageElement | null>(null);
  const [eyeImagesLoaded2, setEyeImagesLoaded2] = useState<Record<string, HTMLImageElement | null>>({});
  const [mouthImagesLoaded2, setMouthImagesLoaded2] = useState<Record<string, HTMLImageElement | null>>({});

  useEffect(() => {
    if (assets.baseImage) {
      loadImage(assets.baseImage).then(setBaseImageLoaded).catch(() => setBaseImageLoaded(null));
    } else {
      setBaseImageLoaded(null);
    }
  }, [assets.baseImage]);

  useEffect(() => {
    const loadAll = async () => {
      const loaded: Record<string, HTMLImageElement | null> = {};
      for (const key of ['A', 'E', 'I', 'O', 'U', 'closed'] as const) {
        const src = assets.mouthImages[key];
        if (src) {
          try { loaded[key] = await loadImage(src); } catch { loaded[key] = null; }
        } else { loaded[key] = null; }
      }
      setMouthImagesLoaded(loaded);
    };
    loadAll();
  }, [assets.mouthImages]);

  useEffect(() => {
    const loadAll = async () => {
      const loaded: Record<string, HTMLImageElement | null> = {};
      for (const key of ['blink'] as const) {
        const src = assets.eyeImages[key];
        if (src) {
          try { loaded[key] = await loadImage(src); } catch { loaded[key] = null; }
        } else { loaded[key] = null; }
      }
      setEyeImagesLoaded(loaded);
    };
    loadAll();
  }, [assets.eyeImages]);

  useEffect(() => {
    if (assets2.baseImage) {
      loadImage(assets2.baseImage).then(setBaseImageLoaded2).catch(() => setBaseImageLoaded2(null));
    } else {
      setBaseImageLoaded2(null);
    }
  }, [assets2.baseImage]);

  useEffect(() => {
    const loadAll = async () => {
      const loaded: Record<string, HTMLImageElement | null> = {};
      for (const key of ['A', 'E', 'I', 'O', 'U', 'closed'] as const) {
        const src = assets2.mouthImages[key];
        if (src) {
          try { loaded[key] = await loadImage(src); } catch { loaded[key] = null; }
        } else { loaded[key] = null; }
      }
      setMouthImagesLoaded2(loaded);
    };
    loadAll();
  }, [assets2.mouthImages]);

  useEffect(() => {
    const loadAll = async () => {
      const loaded: Record<string, HTMLImageElement | null> = {};
      for (const key of ['blink'] as const) {
        const src = assets2.eyeImages[key];
        if (src) {
          try { loaded[key] = await loadImage(src); } catch { loaded[key] = null; }
        } else { loaded[key] = null; }
      }
      setEyeImagesLoaded2(loaded);
    };
    loadAll();
  }, [assets2.eyeImages]);

  // Blink timer
  useEffect(() => {
    blinkTimerRef.current.forEach(clearTimeout);
    blinkTimerRef.current = [];
    setIsBlinking(false);

    if (config.blinkFrequency <= 0 || !playbackState.isPlaying) return;

    const minInterval = 500;
    const maxInterval = 10000;
    const interval = maxInterval - (config.blinkFrequency / 100) * (maxInterval - minInterval);

    const scheduleNext = () => {
      const actualInterval = interval * (0.5 + Math.random());
      const t1 = window.setTimeout(() => {
        setIsBlinking(true);
        const t2 = window.setTimeout(() => {
          setIsBlinking(false);
          scheduleNext();
        }, 150);
        blinkTimerRef.current = [t2];
      }, actualInterval);
      blinkTimerRef.current = [t1];
    };

    scheduleNext();

    return () => {
      blinkTimerRef.current.forEach(clearTimeout);
      blinkTimerRef.current = [];
      setIsBlinking(false);
    };
  }, [config.blinkFrequency, playbackState.isPlaying]);

  const setupAudioEngine = useCallback((engine: AudioEngine, lyricsList: LyricLine[]) => {
    engine.onPlayStateChangeCallback((playing) => {
      setPlaybackState((prev) => ({ ...prev, isPlaying: playing }));
    });

    engine.onFrameUpdate((audioData, currentTime) => {
      const energy = audioData.energy;
      setPlaybackState((prev) => ({
        ...prev,
        currentTime,
        energy,
        duration: engine.getDuration(),
      }));

      const hist = energyHistoryRef.current;
      hist.push(energy);
      if (hist.length > 300) hist.shift();

      let mouth: MouthShape | null = null;
      for (const p of whisperTimelineRef.current) {
        if (p.start <= currentTime && currentTime < p.end) {
          mouth = p.mouth;
          break;
        }
      }
      setMouthShape(mouth ?? 'closed');

      const c = configRef.current;
      bounceStateRef.current = updateBounce(bounceStateRef.current, currentTime, beatTimesRef.current, c.bounceIntensity);
      setBounceScale({
        scaleX: bounceStateRef.current.scaleX,
        scaleY: bounceStateRef.current.scaleY,
      });

      const matched = getCurrentLyric(lyricsList, currentTime, c.lyricOffset);
      setPlaybackState((prev) => ({ ...prev, currentLyric: matched || null }));
    });

    engine.onPlayEnded(() => {
      setPlaybackState((prev) => ({ ...prev, isPlaying: false }));
      setMouthShape('closed');
      bounceStateRef.current = { phase: 'idle', currentBeatIndex: -1, triggerTime: 0, scaleX: 1, scaleY: 1 };
      setBounceScale({ scaleX: 1, scaleY: 1 });
    });
  }, []);

  const loadAudioToEngine = useCallback(async (engine: AudioEngine, url: string) => {
    try {
      await engine.loadAudio(url);
      setPlaybackState((prev) => ({ ...prev, duration: engine.getDuration() }));
    } catch {
      console.error('音频加载失败');
    }
  }, []);

  const handleSongLoad = useCallback(
    (data: { title: string; artist: string; coverUrl: string; audioUrl: string; lyrics: string }) => {
      setSongInfo({ title: data.title, artist: data.artist, coverUrl: data.coverUrl });

      let lyricsList: LyricLine[] = [];
      if (data.lyrics) {
        lyricsList = parseLRC(data.lyrics);
      }
      setLyricsList(lyricsList);

      if (data.audioUrl) {
        abortControllerRef.current?.abort();
        receivedChunksRef.current.clear();

        audioEngineRef.current?.destroy();
        const engine = new AudioEngine();
        audioEngineRef.current = engine;
        setupAudioEngine(engine, lyricsList);
        loadAudioToEngine(engine, data.audioUrl);

        setAnalyzing(true);
        setProcessedRanges([]);

        const controller = analyzeSofaUrlChunked(
          data.audioUrl, data.lyrics, 'https://music.163.com',
          {
            onChunkComplete: (index, chunkData) => {
              setProcessedRanges(prev => [...prev, { start: chunkData.start!, end: chunkData.end! }]);

              if (!chunkData.success || !chunkData.phonemes) return;
              const points = phonemesToMouthPoints(chunkData.phonemes);
              console.log(
                `[sync] chunk ${index}: ${points.length} 点 [${points[0]?.start ?? '-'} - ${points[points.length - 1]?.end ?? '-'}]s`
              );
              receivedChunksRef.current.set(index, points);

              const all: MouthPoint[] = [];
              for (const [, pts] of receivedChunksRef.current) {
                for (const p of pts) all.push(p);
              }
              all.sort((a, b) => a.start - b.start);
              whisperTimelineRef.current = all;
            },
            onBpm: (_bpm, beats) => {
              if (beats.length > 0) setBeatTimes(beats);
            },
            onError: (msg) => console.error('流式分析错误:', msg),
            onComplete: () => setAnalyzing(false),
          },
          configRef.current.vocalSeparation,
        );
        abortControllerRef.current = controller;
      }
    },
    [setupAudioEngine, loadAudioToEngine]
  );

  const handleWhisperResult = useCallback((mouthPoints: MouthPoint[]) => {
    whisperTimelineRef.current = mouthPoints;
  }, []);

  const handleFileAnalyze = useCallback((result: { bpm: number | null; beats: number[]; mouthPoints: MouthPoint[] }) => {
    whisperTimelineRef.current = result.mouthPoints;
    if (result.beats.length > 0) {
      setBeatTimes(result.beats);
    }
  }, []);

  const handleLyricsLoad = useCallback((lrcText: string) => {
    parseLRC(lrcText);
  }, []);

  const handleConfigChange = useCallback((partial: Partial<UIConfig>) => {
    setConfig((prev) => {
      const next = { ...prev, ...partial };
      saveUIConfig(next);
      return next;
    });
  }, []);

  const handleAssetsChange = useCallback((newAssets: CharacterAssets) => {
    setAssets(newAssets);
  }, []);

  const handleAssetsChange2 = useCallback((newAssets: CharacterAssets) => {
    setAssets2(newAssets);
  }, []);

  const handleAssignLyrics = useCallback((assignments: Record<string, LyricAssignment>) => {
    setCharAssignments(assignments);
  }, []);

  const handleSeek = useCallback((time: number) => {
    setPlaybackState((prev) => ({ ...prev, currentTime: time }));
    let newIndex = -1;
    for (let i = 0; i < beatTimes.length; i++) {
      if (beatTimes[i] <= time) newIndex = i;
      else break;
    }
    bounceStateRef.current = {
      phase: 'idle',
      currentBeatIndex: newIndex,
      triggerTime: 0,
      scaleX: 1,
      scaleY: 1,
    };
  }, [beatTimes]);

  useEffect(() => {
    loadBaseImage().then((saved) => {
      if (!saved) return;
      setAssets((prev) =>
        prev.baseImage !== defaultAssets.baseImage ? prev : { ...prev, baseImage: saved }
      );
    });
    loadMouthImages().then((saved) => {
      if (!saved) return;
      setAssets((prev) => {
        const userChanged = Object.keys(saved).some(
          (k) => prev.mouthImages[k as keyof MouthImages] !== defaultMouthImages[k as keyof MouthImages]
        );
        return userChanged ? prev : { ...prev, mouthImages: { ...prev.mouthImages, ...saved } };
      });
    });
    loadEyeImages().then((saved) => {
      if (!saved) return;
      setAssets((prev) =>
        prev.eyeImages.blink !== defaultEyeImages.blink ? prev : { ...prev, eyeImages: { ...prev.eyeImages, ...saved } }
      );
    });
    loadBaseImage2().then((saved) => {
      if (!saved) return;
      setAssets2((prev) => (prev.baseImage !== null ? prev : { ...prev, baseImage: saved }));
    });
    loadMouthImages2().then((saved) => {
      if (!saved) return;
      setAssets2((prev) =>
        Object.values(prev.mouthImages).some((v) => v !== null)
          ? prev
          : { ...prev, mouthImages: { ...prev.mouthImages, ...saved } }
      );
    });
    loadEyeImages2().then((saved) => {
      if (!saved) return;
      setAssets2((prev) =>
        prev.eyeImages.blink !== null ? prev : { ...prev, eyeImages: { ...prev.eyeImages, ...saved } }
      );
    });
  }, []);

  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
      audioEngineRef.current?.destroy();
    };
  }, []);

  useEffect(() => {
    audioEngineRef.current?.setVolume(playbackState.volume);
  }, [playbackState.volume]);

  return (
    <div className="app-container">
      <div className="main-layout">
        <div className="canvas-area">
          <div className="canvas-wrap">
            <div className="canvas-frame">
              <CanvasPreview
                ref={canvasRef}
                audioEngine={audioEngineRef.current}
                assets={assets}
                config={config}
                playbackState={playbackState}
                mouthShape={mouthShape}
                bounceScale={bounceScale}
                beatTimes={beatTimes}
                baseImageLoaded={baseImageLoaded}
                mouthImagesLoaded={mouthImagesLoaded}
                eyeImagesLoaded={eyeImagesLoaded}
                assets2={assets2}
                baseImageLoaded2={baseImageLoaded2}
                mouthImagesLoaded2={mouthImagesLoaded2}
                eyeImagesLoaded2={eyeImagesLoaded2}
                isBlinking={isBlinking}
                charAssignments={charAssignments}
                onMouthOffsetChange={(offset) => handleConfigChange({ mouthOffset: offset })}
                transforms={transforms}
                editMode={editMode}
                selectedAsset={selectedAsset}
                onSelectAsset={setSelectedAsset}
                onEditTransform={(key, t) => setTransforms(prev => ({ ...prev, [key]: t }))}
              />
              <button
                className="canvas-edit-btn"
                onClick={() => {
                  if (editMode) {
                    handleConfirmEdit();
                  } else {
                    setEditMode(true);
                  }
                }}
              >
                {editMode ? '确认' : '编辑'}
              </button>
              <div className="app-tips">
                <div className="app-tips-title">Tips</div>
                <div>· 第一次加载需要大约两分钟</div>
                <div>· 勾选人声分离会让结果更加准确，但是增加一倍的等待时间</div>
              </div>
            </div>
          </div>
        </div>
        <RightPanel
          audioEngine={audioEngineRef.current}
          playbackState={playbackState}
          config={config}
          onConfigChange={handleConfigChange}
          canvasRef={canvasRef}
          assets={assets}
          onAssetsChange={handleAssetsChange}
          assets2={assets2}
          onAssetsChange2={handleAssetsChange2}
          onSongLoad={handleSongLoad}
          onLyricsLoad={handleLyricsLoad}
          onSeek={handleSeek}
          songInfo={songInfo}
          onWhisperResult={handleWhisperResult}
          onFileAnalyze={handleFileAnalyze}
          analyzing={analyzing}
          editMode={editMode}
          processedRanges={processedRanges}
          lyricsList={lyricsList}
          charAssignments={charAssignments}
          onAssignLyrics={handleAssignLyrics}
          onResetAssetTransform={handleResetAssetTransform}
        />
      </div>
    </div>
  );
}
