import {
  type LyricLine,
  type LyricAssignment,
  type AssetTransform,
} from '../types/index';
import { parseLyricText } from './lyrics';

const LEVEL_OPACITY = [1, 0.6, 0.3, 0, 0];
const PAD_X = 18;
const PAD_Y = 14;
const BORDER_W = 2;
const CARD_RADIUS = 12;
const ITEM_GAP = 20;
const ENTER_TIME = 0.5;
const ENTER_Y = 30;
const ORIGINAL_LINE = 27;
const TRANSLATION_LINE = 33;
const ORIGINAL_COLOR = '#666666';
const TRANSLATION_COLOR = '#1d1d1f';
const CARD_COLOR = '#ffffff';
const BORDER_COLOR = '#1d1d1f';
const FONT_STACK = "'Inter', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', sans-serif";
const ORIGINAL_FONT = `18px ${FONT_STACK}`;
const TRANSLATION_FONT = `600 22px ${FONT_STACK}`;

interface LyricCardItem {
  id: number;
  original: string;
  translation: string;
  level: number;
  assignment: LyricAssignment;
  height: number;
  targetBottom: number;
  bottomCur: number;
  opacityCur: number;
  enterT: number;
}

function approach(cur: number, target: number, dt: number, k: number): number {
  if (Math.abs(cur - target) < 0.0005) return target;
  return cur + (target - cur) * (1 - Math.exp(-dt * k));
}

function easeOutQuint(p: number): number {
  return 1 - Math.pow(1 - p, 5);
}

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  if (!text) return [''];
  const lines: string[] = [];
  let current = '';
  for (const ch of text) {
    const test = current + ch;
    if (ctx.measureText(test).width > maxWidth && current !== '') {
      lines.push(current);
      current = ch;
    } else {
      current = test;
    }
  }
  if (current !== '') lines.push(current);
  return lines.length > 0 ? lines : [text];
}

function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

export class CanvasLyricOverlay {
  private items: LyricCardItem[] = [];
  private lastKey = '';
  private idSeq = 0;
  private lastT = 0;

  private measureItem(ctx: CanvasRenderingContext2D, original: string, translation: string): number {
    ctx.font = ORIGINAL_FONT;
    const origLines = wrapText(ctx, original, 380).length;
    ctx.font = TRANSLATION_FONT;
    const transLines = translation ? wrapText(ctx, translation, 380).length : 0;
    const contentH =
      origLines * ORIGINAL_LINE + (transLines > 0 ? 4 + transLines * TRANSLATION_LINE : 0);
    return Math.round(PAD_Y * 2 + BORDER_W * 2 + contentH);
  }

  update(
    ctx: CanvasRenderingContext2D,
    t: number,
    currentLyric: LyricLine | null,
    charAssignments?: Record<string, LyricAssignment>,
  ): void {
    const dt = Math.max(0, Math.min(t - this.lastT, 0.1));
    this.lastT = t;

    if (currentLyric) {
      const key = String(currentLyric.time);
      if (key !== this.lastKey) {
        this.lastKey = key;
        const { original, translation } = parseLyricText(currentLyric.text);
        const assignment = charAssignments?.[key] ?? '1';
        const height = this.measureItem(ctx, original, translation);
        for (const it of this.items) it.level += 1;
        this.items = this.items.filter((it) => it.level <= 4);
        this.items.push({
          id: ++this.idSeq,
          original,
          translation,
          level: 0,
          assignment,
          height,
          targetBottom: 0,
          bottomCur: 0,
          opacityCur: 0,
          enterT: 0,
        });
        this.recomputeBottoms();
      }
    }

    for (const it of this.items) {
      it.bottomCur = approach(it.bottomCur, it.targetBottom, dt, 9);
      const targetOpacity = LEVEL_OPACITY[it.level] ?? 0;
      it.opacityCur = approach(it.opacityCur, targetOpacity, dt, 9);
      if (it.enterT < ENTER_TIME) it.enterT = Math.min(it.enterT + dt, ENTER_TIME);
    }
  }

  private recomputeBottoms(): void {
    const sorted = [...this.items].sort((a, b) => a.level - b.level);
    let cum = 0;
    for (const it of sorted) {
      it.targetBottom = cum;
      cum += it.height + ITEM_GAP;
    }
  }

  draw(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    transforms: Record<string, AssetTransform>,
  ): void {
    if (this.items.length === 0) return;

    const containerW = Math.min(Math.max(200, w * 0.36), 420);
    const containerLeft = w * 0.25 + 200;
    const containerBottom = h * 0.5;
    let totalH = 0;
    for (const it of this.items) {
      totalH = Math.max(totalH, it.targetBottom + it.height);
    }
    totalH = Math.max(totalH, 120);
    const originX = containerLeft + containerW / 2;
    const originY = containerBottom - totalH / 2;

    const lyricT = transforms.lyric ?? { x: 0, y: 0, scale: 1, rotation: 0 };

    ctx.save();
    ctx.translate(originX, originY);
    ctx.translate(lyricT.x, lyricT.y);
    ctx.rotate((lyricT.rotation * Math.PI) / 180);
    ctx.scale(lyricT.scale, lyricT.scale);
    ctx.translate(-originX, -originY);

    const sorted = [...this.items].sort((a, b) => a.level - b.level);
    for (const it of sorted) {
      if (it.opacityCur <= 0.001 && it.enterT >= ENTER_TIME) continue;

      const shiftX = it.assignment === '1' ? -20 : it.assignment === '2' ? 20 : 0;
      const enterProgress = easeOutQuint(it.enterT / ENTER_TIME);
      const enterOffset = (1 - enterProgress) * ENTER_Y;
      const itemY = containerBottom - it.bottomCur - it.height + enterOffset;
      const itemX = containerLeft + shiftX;

      ctx.save();
      ctx.globalAlpha = Math.max(0, Math.min(1, it.opacityCur));

      ctx.shadowColor = 'rgba(0, 0, 0, 0.10)';
      ctx.shadowBlur = 16;
      ctx.shadowOffsetY = 6;
      ctx.fillStyle = CARD_COLOR;
      roundedRectPath(ctx, itemX, itemY, containerW, it.height, CARD_RADIUS);
      ctx.fill();
      ctx.shadowColor = 'transparent';

      ctx.strokeStyle = BORDER_COLOR;
      ctx.lineWidth = BORDER_W;
      roundedRectPath(ctx, itemX, itemY, containerW, it.height, CARD_RADIUS);
      ctx.stroke();

      const innerX = itemX + BORDER_W;
      const innerY = itemY + BORDER_W;
      const maxTextW = containerW - PAD_X * 2 - BORDER_W * 2;

      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';

      let textY = innerY + PAD_Y;
      ctx.font = ORIGINAL_FONT;
      ctx.fillStyle = ORIGINAL_COLOR;
      const origLines = wrapText(ctx, it.original, maxTextW);
      for (const line of origLines) {
        ctx.fillText(line, innerX + PAD_X, textY);
        textY += ORIGINAL_LINE;
      }

      if (it.translation) {
        textY += 4;
        ctx.font = TRANSLATION_FONT;
        ctx.fillStyle = TRANSLATION_COLOR;
        const transLines = wrapText(ctx, it.translation, maxTextW);
        for (const line of transLines) {
          ctx.fillText(line, innerX + PAD_X, textY);
          textY += TRANSLATION_LINE;
        }
      }

      const cy = itemY + it.height / 2;
      if (it.assignment !== '2') {
        ctx.fillStyle = BORDER_COLOR;
        ctx.beginPath();
        ctx.moveTo(itemX - 10, cy);
        ctx.lineTo(itemX + 1, cy - 9);
        ctx.lineTo(itemX + 1, cy + 9);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = CARD_COLOR;
        ctx.beginPath();
        ctx.moveTo(itemX - 7, cy);
        ctx.lineTo(itemX + 1, cy - 7);
        ctx.lineTo(itemX + 1, cy + 7);
        ctx.closePath();
        ctx.fill();
      }

      if (it.assignment === '2' || it.assignment === 'both') {
        const right = itemX + containerW;
        ctx.fillStyle = BORDER_COLOR;
        ctx.beginPath();
        ctx.moveTo(right + 10, cy);
        ctx.lineTo(right - 1, cy - 9);
        ctx.lineTo(right - 1, cy + 9);
        ctx.closePath();
        ctx.fill();
        ctx.fillStyle = CARD_COLOR;
        ctx.beginPath();
        ctx.moveTo(right + 7, cy);
        ctx.lineTo(right - 1, cy - 7);
        ctx.lineTo(right - 1, cy + 7);
        ctx.closePath();
        ctx.fill();
      }

      ctx.restore();
    }

    ctx.restore();
  }

  reset(): void {
    this.items = [];
    this.lastKey = '';
    this.idSeq = 0;
    this.lastT = 0;
  }
}
