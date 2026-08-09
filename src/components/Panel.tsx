import { useState, useCallback, forwardRef, useEffect, useRef, useLayoutEffect, useSyncExternalStore } from 'react';
import {
  type CharacterAssets,
  type MouthImages,
  type EyeImages,
  type UIConfig,
  type PlaybackState,
  type LyricLine,
  type MouthShape,
  type MouthPoint,
  type AssetTransform,
  type TimeRange,
  DEFAULT_TRANSFORM,
} from '../types/index';
import { parseNeteaseSong } from '../utils/api';
import { phonemesToMouthPoints } from '../utils/mouthMapper';
import { getModelLoadState, subscribeModelLoadState, ensureModelsLoaded, analyzeSofaFile } from '../utils/streamingSofa';
import { getAnalysisState, subscribeAnalysisState, type AnalysisStage } from '../utils/client/analysisDiag';
import { saveBaseImage, saveMouthImages, saveEyeImages } from '../utils/storage';
import { renderFrame, getAssetCenter, getAssetSize, computeVisibleBounds, type VisibleBounds } from '../utils/renderer';
import { parseLyricText } from '../utils/lyrics';
import { AudioEngine, computeSway } from '../utils/audio';

const HANDLE_RADIUS = 8;
const ROTATE_RADIUS = 10;

function isNarrowScreen(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(max-width: 640px)').matches === true;
}

function findBeatIndex(t: number, beatTimes: number[]): number {
  let idx = -1;
  for (let i = 0; i < beatTimes.length; i++) {
    if (beatTimes[i] <= t) idx = i;
    else break;
  }
  return idx;
}

interface CanvasPreviewProps {
  assets: CharacterAssets;
  config: UIConfig;
  playbackState: PlaybackState;
  mouthShape: MouthShape;
  bounceScale: { scaleX: number; scaleY: number };
  beatTimes: number[];
  audioEngine: AudioEngine | null;
  baseImageLoaded: HTMLImageElement | null;
  mouthImagesLoaded: Record<string, HTMLImageElement | null>;
  eyeImagesLoaded: Record<string, HTMLImageElement | null>;
  isBlinking: boolean;
  onMouthOffsetChange?: (offset: { x: number; y: number }) => void;
  transforms?: Record<string, AssetTransform>;
  editMode?: boolean;
  selectedAsset?: string | null;
  onSelectAsset?: (key: string | null) => void;
  onEditTransform?: (key: string, t: AssetTransform) => void;
}

export const CanvasPreview = forwardRef<HTMLCanvasElement, CanvasPreviewProps>(function CanvasPreview(
  props: CanvasPreviewProps,
  ref
) {
  const {
    assets, config, playbackState, mouthShape, bounceScale, beatTimes, audioEngine,
    baseImageLoaded, mouthImagesLoaded, eyeImagesLoaded, isBlinking,
    transforms, editMode, selectedAsset, onSelectAsset, onEditTransform,
  } = props;
  const editInteraction = useRef<{ type: 'move' | 'resize' | 'rotate'; startX: number; startY: number; cx: number; cy: number; startT: AssetTransform } | null>(null);
  const visibleBoundsRef = useRef<Record<string, VisibleBounds>>({});
  const animDataRef = useRef({} as {
    playbackState: typeof playbackState;
    mouthShape: typeof mouthShape;
    bounceScale: typeof bounceScale;
    beatTimes: number[];
    audioEngine: AudioEngine | null;
    assets: typeof assets;
    config: typeof config;
    baseImageLoaded: typeof baseImageLoaded;
    mouthImagesLoaded: typeof mouthImagesLoaded;
    eyeImagesLoaded: typeof eyeImagesLoaded;
    isBlinking: typeof isBlinking;
    transforms: typeof transforms;
    editMode: typeof editMode;
    selectedAsset: typeof selectedAsset;
    onSelectAsset: typeof onSelectAsset;
    onEditTransform: typeof onEditTransform;
    visibleBounds: Record<string, VisibleBounds>;
  });

  const selectionInteraction = useRef<{
    type: 'move' | 'resize' | 'rotate';
    startX: number; startY: number;
    startT: AssetTransform;
    centerX: number; centerY: number;
  } | null>(null);
  const renderRequestedRef = useRef(false);
  const [renderTick, setRenderTick] = useState(0);
  const swayRef = useRef<{ currentBeatIndex: number; angle: number }>({ currentBeatIndex: -1, angle: 0 });
  const lastFrameNowRef = useRef(0);

  const itemIdRef = useRef(0);
  const prevLyricRef = useRef<LyricLine | null>(null);
  const [lyricItems, setLyricItems] = useState<Array<{
    id: number;
    original: string;
    translation: string;
    level: number;
    entering: boolean;
  }>>([]);

  useEffect(() => {
    const current = playbackState.currentLyric;
    if (!current || current === prevLyricRef.current) return;
    prevLyricRef.current = current;

    const { original, translation } = parseLyricText(current.text);
    const id = ++itemIdRef.current;

    setLyricItems(prev => {
      const updated = prev
        .map(item => ({ ...item, level: item.level + 1 }))
        .filter(item => item.level <= 4);
      return [...updated, { id, original, translation, level: 0, entering: true }];
    });

    requestAnimationFrame(() => {
      setLyricItems(prev =>
        prev.map(item => item.id === id ? { ...item, entering: false } : item)
      );
    });
  }, [playbackState.currentLyric]);

  const itemRefs = useRef<Map<number, HTMLDivElement>>(new Map());
  const [bottoms, setBottoms] = useState<Record<number, number>>({});
  const [lyricContentHeight, setLyricContentHeight] = useState(200);

  useLayoutEffect(() => {
    const sorted = [...lyricItems].sort((a, b) => a.level - b.level);
    let cum = 0;
    const newBottoms: Record<number, number> = {};
    for (const item of sorted) {
      const el = itemRefs.current.get(item.id);
      const h = el ? el.offsetHeight : 60;
      newBottoms[item.id] = cum;
      cum += h + 20;
    }

    setLyricContentHeight(Math.max(cum, 120));

    let changed = Object.keys(bottoms).length !== Object.keys(newBottoms).length;
    if (!changed) {
      for (const [id, val] of Object.entries(newBottoms)) {
        if (bottoms[Number(id)] !== val) { changed = true; break; }
      }
    }

    if (changed) setBottoms(newBottoms);
  }, [lyricItems]);

  useEffect(() => {
    const newBounds: Record<string, VisibleBounds> = {};

    if (baseImageLoaded) {
      newBounds.base = computeVisibleBounds(baseImageLoaded);
    }

    for (const [k, img] of Object.entries(mouthImagesLoaded)) {
      if (img) {
        newBounds[k] = computeVisibleBounds(img);
      }
    }

    visibleBoundsRef.current = {
      ...visibleBoundsRef.current,
      ...newBounds,
    };
  }, [baseImageLoaded, mouthImagesLoaded]);

  useEffect(() => {
    const shouldRender = (playbackState.isPlaying || editMode) === true;
    if (shouldRender !== renderRequestedRef.current) {
      renderRequestedRef.current = shouldRender;
      if (shouldRender) setRenderTick(t => t + 1);
    }
  }, [playbackState.isPlaying, editMode]);

  animDataRef.current = {
    playbackState, mouthShape, bounceScale, beatTimes, audioEngine, assets, config,
    baseImageLoaded, mouthImagesLoaded, eyeImagesLoaded, isBlinking,
    transforms, editMode, selectedAsset, onSelectAsset, onEditTransform,
    visibleBounds: visibleBoundsRef.current,
  };

  useEffect(() => {
    const canvas = (ref as React.RefObject<HTMLCanvasElement | null>).current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const w = rect.width * dpr;
    const h = rect.height * dpr;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }

    let running = true;
    let prevLyric: LyricLine | null = null;
    let lyricTransition = 1;
    let lyricTimer = 0;

    function getCanvasCenter(width: number, height: number) {
      return { cx: width * 0.25, cy: height / 2 - 40 };
    }

    function hitTestAsset(mx: number, my: number, key: string, d: typeof animDataRef.current, cw: number, ch: number): boolean {
      const center = getCanvasCenter(cw, ch);
      const vb = d.visibleBounds;
      const size = getAssetSize(key, d.baseImageLoaded, d.mouthImagesLoaded, d.transforms ?? {}, vb);
      if (size.w === 0 || size.h === 0) return false;
      const assetCenter = getAssetCenter(key, center.cx, center.cy, d.config, d.transforms ?? {}, vb, d.baseImageLoaded);
      const t = d.transforms?.[key] ?? DEFAULT_TRANSFORM;
      const angle = t.rotation * Math.PI / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      // Rotate mouse point back to local coords
      const dx = mx - assetCenter.x;
      const dy = my - assetCenter.y;
      const localX = dx * cos + dy * sin;
      const localY = -dx * sin + dy * cos;
      return Math.abs(localX) <= size.w / 2 && Math.abs(localY) <= size.h / 2;
    }

    function getHandles(key: string, d: typeof animDataRef.current, cw: number, ch: number): { x: number; y: number; type: 'corner' | 'mid' | 'rotate' }[] | null {
      const center = getCanvasCenter(cw, ch);
      const vb = d.visibleBounds;
      const size = getAssetSize(key, d.baseImageLoaded, d.mouthImagesLoaded, d.transforms ?? {}, vb);
      if (size.w === 0 || size.h === 0) return null;
      const assetCenter = getAssetCenter(key, center.cx, center.cy, d.config, d.transforms ?? {}, vb, d.baseImageLoaded);
      const t = d.transforms?.[key] ?? DEFAULT_TRANSFORM;
      const angle = t.rotation * Math.PI / 180;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const hw = size.w / 2;
      const hh = size.h / 2;
      const corners = [
        { x: assetCenter.x + cos * (-hw) - sin * (-hh), y: assetCenter.y + sin * (-hw) + cos * (-hh) },
        { x: assetCenter.x + cos * hw - sin * (-hh), y: assetCenter.y + sin * hw + cos * (-hh) },
        { x: assetCenter.x + cos * hw - sin * hh, y: assetCenter.y + sin * hw + cos * hh },
        { x: assetCenter.x + cos * (-hw) - sin * hh, y: assetCenter.y + sin * (-hw) + cos * hh },
      ];
      const mids = [
        { x: (corners[0].x + corners[1].x) / 2, y: (corners[0].y + corners[1].y) / 2 },
        { x: (corners[1].x + corners[2].x) / 2, y: (corners[1].y + corners[2].y) / 2 },
        { x: (corners[2].x + corners[3].x) / 2, y: (corners[2].y + corners[3].y) / 2 },
        { x: (corners[3].x + corners[0].x) / 2, y: (corners[3].y + corners[0].y) / 2 },
      ];
      return [
        ...corners.map(p => ({ ...p, type: 'corner' as const })),
        ...mids.map(p => ({ ...p, type: 'mid' as const })),
        { x: mids[0].x, y: mids[0].y - 25, type: 'rotate' as const },
      ];
    }

    function getHitHandle(mx: number, my: number, handles: { x: number; y: number; type: string }[]): { index: number; type: string } | null {
      const narrow = isNarrowScreen();
      const s = narrow ? 2.6 : 1;
      for (let i = 0; i < handles.length; i++) {
        const h = handles[i];
        const r = (h.type === 'rotate' ? ROTATE_RADIUS : HANDLE_RADIUS) * s;
        if (Math.abs(mx - h.x) < r && Math.abs(my - h.y) < r) {
          return { index: i, type: h.type };
        }
      }
      return null;
    }

    let animFrameId: number | null = null;
    let lastDrawn = { w: -1, h: -1, mouthShape: '', scaleX: 0, scaleY: 0, swayAngle: 0, isBlinking: false, lyric: null as LyricLine | null, energy: 0 };

    const frame = (now: number) => {
      if (!running) return;

      const d = animDataRef.current;
      const rect2 = canvas.getBoundingClientRect();
      const cw = rect2.width;
      const ch = rect2.height;
      const resized = canvas.width !== cw * dpr || canvas.height !== ch * dpr;
      if (resized) {
        canvas.width = cw * dpr;
        canvas.height = ch * dpr;
      }

      const currentLyric = d.playbackState.currentLyric;
      if (currentLyric && currentLyric !== prevLyric) {
        prevLyric = currentLyric;
        lyricTransition = 0;
        lyricTimer = now;
      }
      if (lyricTransition < 1) {
        lyricTransition = Math.min((now - lyricTimer) / 300, 1);
      }

      const b = d.bounceScale;

      let dt = (now - lastFrameNowRef.current) / 1000;
      if (lastFrameNowRef.current === 0) dt = 1 / 60;
      lastFrameNowRef.current = now;
      if (dt > 0.1) dt = 0.1;

      let swayAngle = 0;
      if (d.playbackState.isPlaying && !d.editMode) {
        const t = d.audioEngine?.getCurrentTime() ?? d.playbackState.currentTime;
        const bt = d.beatTimes;
        const intensity = d.config.swayIntensity;
        if (bt.length === 0 || intensity <= 0) {
          swayRef.current = { currentBeatIndex: -1, angle: 0 };
        } else {
          let s = swayRef.current;
          if (s.currentBeatIndex < 0) {
            s = { currentBeatIndex: findBeatIndex(t, bt), angle: 0 };
          }
          s = computeSway(s, t, bt, intensity, dt);
          swayRef.current = s;
          swayAngle = s.angle;
        }
      } else if (swayRef.current.angle !== 0) {
        swayRef.current = { currentBeatIndex: -1, angle: 0 };
      }

      const dirty = resized || d.editMode
        || d.mouthShape !== lastDrawn.mouthShape
        || b.scaleX !== lastDrawn.scaleX
        || b.scaleY !== lastDrawn.scaleY
        || swayAngle !== lastDrawn.swayAngle
        || d.isBlinking !== lastDrawn.isBlinking
        || currentLyric !== lastDrawn.lyric
        || lyricTransition < 1
        || d.playbackState.energy !== lastDrawn.energy;

      if (dirty) {
        lastDrawn = {
          w: cw, h: ch,
          mouthShape: d.mouthShape,
          scaleX: b.scaleX,
          scaleY: b.scaleY,
          swayAngle,
          isBlinking: d.isBlinking,
          lyric: currentLyric,
          energy: d.playbackState.energy,
        };
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const rc = {
          ctx,
          width: cw,
          height: ch,
          time: d.playbackState.currentTime,
          energy: d.playbackState.energy,
          mouthShape: d.mouthShape,
          bounceScale: d.bounceScale,
          swayAngle,
          currentLyric,
          assets: d.assets,
          config: d.config,
          mouthImagesLoaded: d.mouthImagesLoaded,
          eyeImagesLoaded: d.eyeImagesLoaded,
          isBlinking: d.isBlinking,
          baseImageLoaded: d.baseImageLoaded,
          prevLyric: null,
          lyricTransition,
          transforms: d.transforms ?? {},
          editMode: d.editMode ?? false,
          selectedAsset: d.selectedAsset ?? null,
          visibleBounds: d.visibleBounds,
        };
        renderFrame(rc);
        ctx.resetTransform();
      }

      if (renderRequestedRef.current) {
        animFrameId = requestAnimationFrame(frame);
      } else {
        animFrameId = null;
      }
    };

    animFrameId = requestAnimationFrame(frame);

    const onPointerDown = (e: PointerEvent) => {
      if (editInteraction.current) return;
      if (!e.isPrimary) return;

      const d = animDataRef.current;
      const rect2 = canvas.getBoundingClientRect();

      if (d.editMode) {
        e.preventDefault();
        const mx = e.clientX - rect2.left;
        const my = e.clientY - rect2.top;
        const center = getCanvasCenter(rect2.width, rect2.height);

        // Check handles of currently selected asset (skip for lyric since it uses HTML handles)
        if (d.selectedAsset && d.selectedAsset !== 'lyric' && d.onEditTransform) {
          const handles = getHandles(d.selectedAsset, d, rect2.width, rect2.height);
          if (handles) {
            const hit = getHitHandle(mx, my, handles);
            if (hit) {
              const currentT = d.transforms?.[d.selectedAsset] ?? { ...DEFAULT_TRANSFORM };
              const vb = d.visibleBounds;
              const assetCenter = getAssetCenter(d.selectedAsset, center.cx, center.cy, d.config, d.transforms ?? {}, vb, d.baseImageLoaded);
              if (hit.type === 'rotate') {
                editInteraction.current = { type: 'rotate', startX: mx, startY: my, cx: assetCenter.x, cy: assetCenter.y, startT: { ...currentT } };
                canvas.style.cursor = 'crosshair';
              } else {
                editInteraction.current = { type: 'resize', startX: mx, startY: my, cx: assetCenter.x, cy: assetCenter.y, startT: { ...currentT } };
                canvas.style.cursor = 'nwse-resize';
              }
              try { canvas.setPointerCapture(e.pointerId); } catch {}
              return;
            }
          }
        }

        // Check asset bodies
        const assetKeys = d.baseImageLoaded ? ['mouth', 'base'] : [];
        for (const key of assetKeys) {
          if (hitTestAsset(mx, my, key, d, rect2.width, rect2.height)) {
            d.onSelectAsset?.(key);
            const currentT = d.transforms?.[key] ?? { ...DEFAULT_TRANSFORM };
            const vb = d.visibleBounds;
            const assetCenter = getAssetCenter(key, center.cx, center.cy, d.config, d.transforms ?? {}, vb, d.baseImageLoaded);
            editInteraction.current = { type: 'move', startX: mx, startY: my, cx: assetCenter.x, cy: assetCenter.y, startT: { ...currentT } };
            canvas.style.cursor = 'grabbing';
            try { canvas.setPointerCapture(e.pointerId); } catch {}
            return;
          }
        }

        // Click on empty space → deselect
        d.onSelectAsset?.(null);
        return;
      }

    };

    const onPointerMove = (e: PointerEvent) => {
      const d = animDataRef.current;
      const rect2 = canvas.getBoundingClientRect();

      if (d.editMode && editInteraction.current && d.selectedAsset && d.onEditTransform) {
        const mx = e.clientX - rect2.left;
        const my = e.clientY - rect2.top;
        const dx = mx - editInteraction.current.startX;
        const dy = my - editInteraction.current.startY;
        const ei = editInteraction.current;

        if (ei.type === 'move') {
          d.onEditTransform(d.selectedAsset, {
            ...ei.startT,
            x: ei.startT.x + dx,
            y: ei.startT.y + dy,
          });
        } else if (ei.type === 'resize') {
          const startDist = Math.hypot(ei.startX - ei.cx, ei.startY - ei.cy);
          const curDist = Math.hypot(mx - ei.cx, my - ei.cy);
          if (startDist > 0) {
            const newScale = ei.startT.scale * (curDist / startDist);
            d.onEditTransform(d.selectedAsset, { ...ei.startT, scale: Math.max(0.05, newScale) });
          }
        } else if (ei.type === 'rotate') {
          const startAngle = Math.atan2(ei.startY - ei.cy, ei.startX - ei.cx);
          const curAngle = Math.atan2(my - ei.cy, mx - ei.cx);
          d.onEditTransform(d.selectedAsset, {
            ...ei.startT,
            rotation: ei.startT.rotation + (curAngle - startAngle) * 180 / Math.PI,
          });
        }
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      if (editInteraction.current) {
        editInteraction.current = null;
        canvas.style.cursor = 'default';
        try { canvas.releasePointerCapture(e.pointerId); } catch {}
      }
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointercancel', onPointerUp);

    return () => {
      running = false;
      if (animFrameId !== null) cancelAnimationFrame(animFrameId);
      canvas.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      editInteraction.current = null;
    };
  }, [ref, renderTick, baseImageLoaded, mouthImagesLoaded, eyeImagesLoaded]);

  const handleLyricPointerDown = (e: React.PointerEvent) => {
    if (!editMode) return;
    e.stopPropagation();
    e.preventDefault();

    const currentT = transforms?.lyric ?? { ...DEFAULT_TRANSFORM };
    selectionInteraction.current = {
      type: 'move', startX: e.clientX, startY: e.clientY,
      startT: { ...currentT }, centerX: 0, centerY: 0,
    };

    if (selectedAsset !== 'lyric') {
      onSelectAsset?.('lyric');
    }

    const onPointerMove = (ev: PointerEvent) => {
      if (!selectionInteraction.current || !onEditTransform) return;
      const si = selectionInteraction.current;
      const dx = ev.clientX - si.startX;
      const dy = ev.clientY - si.startY;
      onEditTransform('lyric', { ...si.startT, x: si.startT.x + dx, y: si.startT.y + dy });
    };

    const onPointerUp = () => {
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      selectionInteraction.current = null;
    };

    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerUp);
  };

  function handleSelectionHandlePointerDown(type: 'resize' | 'rotate') {
    return (e: React.PointerEvent) => {
      e.stopPropagation();
      e.preventDefault();
      const currentT = transforms?.lyric ?? { ...DEFAULT_TRANSFORM };
      const boxEl = e.currentTarget.parentElement!;
      const rect = boxEl.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;

      selectionInteraction.current = { type, startX: e.clientX, startY: e.clientY, startT: { ...currentT }, centerX, centerY };

      const onPointerMove = (ev: PointerEvent) => {
        if (!selectionInteraction.current || !onEditTransform) return;
        const si = selectionInteraction.current;
        if (si.type === 'resize') {
          const startDist = Math.hypot(si.startX - si.centerX, si.startY - si.centerY);
          const curDist = Math.hypot(ev.clientX - si.centerX, ev.clientY - si.centerY);
          if (startDist > 0) {
            onEditTransform('lyric', { ...si.startT, scale: Math.max(0.05, si.startT.scale * (curDist / startDist)) });
          }
        } else if (si.type === 'rotate') {
          const startAngle = Math.atan2(si.startY - si.centerY, si.startX - si.centerX);
          const curAngle = Math.atan2(ev.clientY - si.centerY, ev.clientX - si.centerX);
          onEditTransform('lyric', { ...si.startT, rotation: si.startT.rotation + (curAngle - startAngle) * 180 / Math.PI });
        }
      };

      const onPointerUp = () => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        selectionInteraction.current = null;
      };

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    };
  }

  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <canvas ref={ref as React.Ref<HTMLCanvasElement>} style={{ width: '100%', height: '100%', display: 'block' }} />
      {lyricItems.length > 0 && (
        <div
          className={`lyric-container${editMode ? ' lyric-editable' : ''}${selectedAsset === 'lyric' && editMode ? ' lyric-selected' : ''}`}
          style={{
            ...(transforms?.lyric ? {
              transform: `translate(${transforms.lyric.x}px, ${transforms.lyric.y}px) rotate(${transforms.lyric.rotation}deg) scale(${transforms.lyric.scale})`,
            } : {}),
            ...(editMode && selectedAsset === 'lyric' ? { height: lyricContentHeight + 40 } : {}),
          }}
          onPointerDown={handleLyricPointerDown}
        >
          {editMode && selectedAsset === 'lyric' && (
            <div className="lyric-selection-box">
              <div className="lyric-handle lyric-handle-tl" onPointerDown={handleSelectionHandlePointerDown('resize')} />
              <div className="lyric-handle lyric-handle-tr" onPointerDown={handleSelectionHandlePointerDown('resize')} />
              <div className="lyric-handle lyric-handle-bl" onPointerDown={handleSelectionHandlePointerDown('resize')} />
              <div className="lyric-handle lyric-handle-br" onPointerDown={handleSelectionHandlePointerDown('resize')} />
              <div className="lyric-handle-rotate" onPointerDown={handleSelectionHandlePointerDown('rotate')} />
              <div className="lyric-rotate-line" />
            </div>
          )}
          {lyricItems.map(item => (
            <div
              key={item.id}
              ref={el => { if (el) itemRefs.current.set(item.id, el); }}
              className={`lyric-item level-${item.level}${item.entering ? ' entering' : ''}`}
              style={{ bottom: bottoms[item.id] ?? 0 }}
            >
              <div className="lyric-original">{item.original}</div>
              {item.translation && <div className="lyric-translated">{item.translation}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

interface RightPanelProps {
  audioEngine: AudioEngine | null;
  playbackState: PlaybackState;
  config: UIConfig;
  onConfigChange: (config: Partial<UIConfig>) => void;
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  assets: CharacterAssets;
  onAssetsChange: (assets: CharacterAssets) => void;
  onSongLoad: (data: { title: string; artist: string; coverUrl: string; audioUrl: string; lyrics: string }) => void;
  onLyricsLoad: (lrcText: string) => void;
  onSeek: (time: number) => void;
  onWhisperResult: (mouthPoints: MouthPoint[]) => void;
  onFileAnalyze: (result: { bpm: number | null; beats: number[]; mouthPoints: MouthPoint[] }) => void;
  songInfo: { title: string; artist: string; coverUrl: string } | null;
  analyzing?: boolean;
  editMode?: boolean;
  processedRanges: TimeRange[];
}

const MOUTH_KEYS: (keyof MouthImages)[] = ['closed', 'A', 'E', 'I', 'O', 'U'];

const STAGE_LABELS: Record<AnalysisStage, string> = {
  audio: '下载音频',
  separate: '人声分离',
  g2p: '文本转音素',
  infer: '模型推理',
  decode: '解码',
};

export function RightPanel({
  audioEngine,
  playbackState,
  config,
  onConfigChange,
  assets,
  onAssetsChange,
  onSongLoad,
  onLyricsLoad,
  onSeek,
  onWhisperResult,
  onFileAnalyze,
  songInfo,
  analyzing,
  editMode,
  processedRanges,
}: RightPanelProps) {
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [dragTime, setDragTime] = useState<number | null>(null);
  const modelLoadState = useSyncExternalStore(subscribeModelLoadState, getModelLoadState);
  const analysisState = useSyncExternalStore(subscribeAnalysisState, getAnalysisState);

  const handleParse = useCallback(async () => {
    if (!url.trim()) return;
    setLoading(true);
    setError('');
    const result = await parseNeteaseSong(url);
    if (result.success && result.data) {
      onSongLoad(result.data);
      onLyricsLoad(result.data.lyrics);
    } else {
      setError(result.error || '解析失败');
    }
    setLoading(false);
  }, [url, onSongLoad, onLyricsLoad]);

  const handlePlayPause = useCallback(() => {
    if (!audioEngine) return;
    if (playbackState.isPlaying) {
      audioEngine.pause();
    } else {
      audioEngine.play();
    }
  }, [audioEngine, playbackState.isPlaying]);

  const handleSeekDrag = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = parseFloat(e.target.value);
    audioEngine?.seek(value);
    setDragTime(value);
  }, [audioEngine]);

  const handleSeekEnd = useCallback(() => {
    if (dragTime !== null) {
      onSeek(dragTime);
      audioEngine?.seek(dragTime);
      setDragTime(null);
    }
  }, [audioEngine, dragTime, onSeek]);

  const handleBaseImageUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = reader.result as string;
        await saveBaseImage(dataUrl);
        onAssetsChange({ ...assets, baseImage: dataUrl });
      };
      reader.readAsDataURL(file);
    },
    [assets, onAssetsChange]
  );

  const handleMouthUpload = useCallback(
    (key: keyof MouthImages) => (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = reader.result as string;
        const newMouthImages = { ...assets.mouthImages, [key]: dataUrl };
        await saveMouthImages(newMouthImages);
        onAssetsChange({ ...assets, mouthImages: newMouthImages });
      };
      reader.readAsDataURL(file);
    },
    [assets, onAssetsChange]
  );

  const handleEyeUpload = useCallback(
    (key: keyof EyeImages) => (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = reader.result as string;
        const newEyeImages = { ...assets.eyeImages, [key]: dataUrl };
        await saveEyeImages(newEyeImages);
        onAssetsChange({ ...assets, eyeImages: newEyeImages });
      };
      reader.readAsDataURL(file);
    },
    [assets, onAssetsChange]
  );

  const [fileAnalyzing, setFileAnalyzing] = useState(false);
  const [fileLyrics, setFileLyrics] = useState('');
  const [lrcFileName, setLrcFileName] = useState('');

  const handleLrcUpload = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      setFileLyrics(reader.result as string);
      setLrcFileName(file.name);
    };
    reader.readAsText(file);
    e.target.value = '';
  }, []);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileAnalyzing(true);
    const result = await analyzeSofaFile(file, fileLyrics, config.vocalSeparation);
    if (result.success && result.phonemes) {
      const mouthPoints = phonemesToMouthPoints(result.phonemes);
      onWhisperResult(mouthPoints);
      onFileAnalyze({ bpm: result.bpm ?? null, beats: result.beats ?? [], mouthPoints });
    } else {
      console.error('文件分析失败:', result);
    }
    setFileAnalyzing(false);
    e.target.value = '';
  }, [fileLyrics, onWhisperResult, onFileAnalyze, config]);

  const formatTime = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  return (
    <div className="right-panel">
      <div className="right-panel-logo">对口型是不对的！</div>

      <div className="song-import">
        <input
          type="url"
          placeholder="网易云链接..."
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button onClick={handleParse} disabled={loading || analyzing || !url.trim()}>
          {loading ? <span className="spinner" /> : analyzing ? <span className="spinner" /> : '解析'}
        </button>
      </div>
      {error && <div className="error-text">{error}</div>}

      {modelLoadState.status === 'loading' && (
        <div className="model-progress">
          <div className="model-progress-label">
            <span>{modelLoadState.label === 'SOFA' ? 'SOFA 对齐模型' : '人声分离模型'}</span>
            <span>
              {modelLoadState.total > 0 ? Math.round((modelLoadState.loaded / modelLoadState.total) * 100) : 0}% ·{' '}
              {(modelLoadState.loaded / 1048576).toFixed(1)} / {(modelLoadState.total / 1048576).toFixed(1)} MB
            </span>
          </div>
          <div className="model-progress-track">
            <div
              className="model-progress-fill"
              style={{
                width: `${modelLoadState.total > 0 ? Math.min(100, (modelLoadState.loaded / modelLoadState.total) * 100) : 0}%`,
              }}
            />
          </div>
        </div>
      )}
      {modelLoadState.status === 'done' && <div className="model-progress-done">模型已加载 ✓</div>}
      {modelLoadState.status === 'error' && (
        <div className="model-progress-error">
          <span>模型加载失败：{modelLoadState.message}</span>
          <button
            className="model-retry-btn"
            onClick={() => {
              ensureModelsLoaded().catch(() => {});
            }}
          >
            重试
          </button>
        </div>
      )}

      {analysisState.status === 'running' && (
        <div className="model-progress">
          <div className="model-progress-label">
            <span>分析中… {STAGE_LABELS[analysisState.stage]}</span>
            {analysisState.chunkIndex !== undefined && <span>#chunk {analysisState.chunkIndex}</span>}
          </div>
          <div className="model-progress-track">
            <div className="model-progress-fill" style={{ width: '35%' }} />
          </div>
        </div>
      )}
      {analysisState.status === 'error' && (
        <div className="model-progress-error">
          <span>
            分析失败（{analysisState.stage ? STAGE_LABELS[analysisState.stage] : '?'}）：{analysisState.message}
          </span>
        </div>
      )}

      <div className="cover-box">
        {songInfo?.coverUrl ? (
          <img src={songInfo.coverUrl} alt="" />
        ) : (
          <div className="cover-placeholder">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
            <span>No Song</span>
          </div>
        )}
      </div>

      <div className="song-info-right">
        <div className="title font-title">{songInfo?.title || '—'}</div>
        <div className="artist">{songInfo?.artist || '—'}</div>
      </div>

      <div className="progress-row">
        <span className="time">{formatTime(dragTime !== null ? dragTime : playbackState.currentTime)}</span>
        <div className="progress-track-wrap">
          <div className="progress-track-bg">
            {processedRanges.map((r, i) => {
              const dur = playbackState.duration || 1;
              const left = (r.start / dur) * 100;
              const width = ((r.end - r.start) / dur) * 100;
              return (
                <div
                  key={i}
                  className="progress-done-segment"
                  style={{ left: `${left}%`, width: `${width}%` }}
                />
              );
            })}
          </div>
          <input
            type="range"
            className="progress-bar"
            min="0"
            max={playbackState.duration || 1}
            step="0.1"
            value={dragTime !== null ? dragTime : playbackState.currentTime}
            onChange={handleSeekDrag}
            onMouseUp={handleSeekEnd}
            onTouchEnd={handleSeekEnd}
          />
        </div>
        <span className="time">{formatTime(playbackState.duration)}</span>
      </div>

      <div className="play-btn-wrap">
        <button className="play-btn-big" onClick={handlePlayPause}>
          {playbackState.isPlaying ? (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" />
            </svg>
          ) : (
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
          )}
        </button>
      </div>

      <div className="sliders-compact">
        <div className="slider-row">
          <label>弹跳</label>
          <input
            type="range" min="0" max="1.0" step="0.1"
            value={config.bounceIntensity}
            onChange={(e) => onConfigChange({ bounceIntensity: parseFloat(e.target.value) })}
          />
          <span className="val">{config.bounceIntensity.toFixed(1)}</span>
        </div>
        <div className="slider-row">
          <label>摇摆</label>
          <input
            type="range" min="0" max="1.0" step="0.1"
            value={config.swayIntensity}
            onChange={(e) => onConfigChange({ swayIntensity: parseFloat(e.target.value) })}
          />
          <span className="val">{config.swayIntensity.toFixed(1)}</span>
        </div>
        <div className="slider-row">
          <label>歌词偏移</label>
          <input
            type="range" min="-500" max="500" step="50"
            value={config.lyricOffset}
            onChange={(e) => onConfigChange({ lyricOffset: parseInt(e.target.value) })}
          />
          <span className="val">{config.lyricOffset}</span>
        </div>
        <div className="slider-row">
          <label>眨眼频率</label>
          <input
            type="range" min="0" max="100" step="1"
            value={config.blinkFrequency}
            onChange={(e) => onConfigChange({ blinkFrequency: parseInt(e.target.value) })}
          />
          <span className="val">{config.blinkFrequency}%</span>
        </div>
        <div className="slider-row">
          <label>增强</label>
          <label className="toggle-row">
            <input
              type="checkbox"
              checked={config.vocalSeparation}
              onChange={(e) => onConfigChange({ vocalSeparation: e.target.checked })}
            />
            <span>{config.vocalSeparation ? '人声分离 ✓' : '人声分离'}</span>
          </label>
        </div>
      </div>

      <div className="asset-section">
        <div className="label">角色素材</div>
        <div className="asset-btns">
          <label className={`asset-btn ${assets.baseImage ? 'uploaded' : ''}`} style={editMode ? { opacity: 0.4, pointerEvents: 'none' } : {}}>
            {assets.baseImage ? '底图 ✓' : '角色底图'}
            <input type="file" accept="image/png,image/jpeg" onChange={handleBaseImageUpload} disabled={editMode} />
          </label>
          {MOUTH_KEYS.map((key) => (
              <label key={key} className={`asset-btn ${assets.mouthImages[key] ? 'uploaded' : ''}`} style={editMode ? { opacity: 0.4, pointerEvents: 'none' } : {}}>
                {assets.mouthImages[key] ? `${key} ✓` : key}
                <input type="file" accept="image/png" onChange={handleMouthUpload(key)} disabled={editMode} />
              </label>
            ))}
          <label className={`asset-btn ${assets.eyeImages.blink ? 'uploaded' : ''}`} style={editMode ? { opacity: 0.4, pointerEvents: 'none' } : {}}>
            {assets.eyeImages.blink ? '闭眼图 ✓' : '闭眼图'}
            <input type="file" accept="image/png" onChange={handleEyeUpload('blink')} disabled={editMode} />
          </label>
          </div>
        </div>

      <div className="asset-section">
        <div className="label">上传音频测试</div>
        <div className="asset-btns">
          <label className={`asset-btn ${fileAnalyzing ? '' : ''}`}>
            {fileAnalyzing ? '分析中...' : '选择音频文件'}
            <input type="file" accept="audio/*" onChange={handleFileUpload} disabled={fileAnalyzing} />
          </label>
          <label className={`asset-btn ${lrcFileName ? 'uploaded' : ''}`}>
            {lrcFileName || '选择LRC歌词'}
            <input type="file" accept=".lrc,.txt" onChange={handleLrcUpload} />
          </label>
        </div>
      </div>
    </div>
  );
}


