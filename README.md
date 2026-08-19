# KoePuppet — 对口型是不对的

An automatic **lip-sync animation app** for singing characters. Paste a music link, upload character art, and the app animates the character's mouth to the singing, bounces and sways on the beat, shows synced lyrics, and exports everything as an **MP4**.

---

## Problem

Making a character "sing" by hand is painful: you have to cut mouth shapes, align them to the audio by ear, animate the body on the beat, lay out lyrics, and render a video.

This project automates the whole pipeline:

- **Import** — paste a NetEase Cloud Music / QQ Music link (title, artist, cover, audio and LRC lyrics are fetched automatically), or upload a local audio file + `.lrc`.
- **Assets** — upload a base character image plus mouth shapes (`A E I O U closed`) and an optional blink image, for up to **two characters**.
- **Analyze** — the audio is aligned to the lyrics to produce a phoneme timeline; the beat is detected; optional vocal separation improves alignment.
- **Animate** — mouth follows the singing, the body bounces (squash & stretch) and sways on the beat, blinking is randomized, and each lyric line can be assigned to character 1, character 2, or both (duet).
- **Export** — render the whole thing to a real **MP4** (H.264 + AAC) with audio and lyrics baked in.

---

## Architecture

### Frontend — React + TypeScript + Vite

Everything user-facing runs in the browser. Key modules in `src/`:

| Module | Responsibility |
|---|---|
| `utils/api.ts` | Song URL parsing via the Meting API; LRC parsing |
| `utils/audio.ts` | `AudioEngine` (WebAudio/`<audio>` playback, energy analyser), beat-driven **bounce** and **sway** math |
| `utils/mouthMapper.ts` | Maps phonemes → mouth shape per frame |
| `utils/streamingSofa.ts` / `client/sofaPipeline.ts` | Orchestrates the in-browser analysis pipeline |
| `utils/renderer.ts` | Canvas renderer: background, character + mouth/blink images, bounce, progressive twist sway, per-asset transforms |
| `utils/exportLyrics.ts` | Canvas-based lyric cards (replicates the DOM overlay for video export) |
| `utils/exporter.ts` | Offline MP4 export via WebCodecs + mp4-muxer |
| `utils/storage.ts` / `db.ts` | IndexedDB persistence for uploaded assets and UI config |
| `components/Panel.tsx` | `CanvasPreview` (canvas + DOM lyric overlay + edit handles) and the `RightPanel` UI |

### Analysis pipeline (in-browser, onnxruntime-web)

No server is needed for the deployed version — inference runs in the browser:

1. **G2P** — lyrics text → phoneme sequence (`pinyin-pro` + a Mandarin/Japanese/English dictionary).
2. **Vocal separation (optional)** — Demucs isolates the vocal track for a more accurate alignment (~2× slower).
3. **SOFA alignment** — a speech/singing alignment ONNX model produces per-frame phoneme logits; a Viterbi decoder converts them into a phoneme timeline with start/end times.
4. **Beat detection** — a Web Worker (`beatDetector`) computes BPM and beat timestamps from the audio.

The audio is processed in **chunks** with streaming progress so long songs stay responsive. Models (~490 MB total) are fetched from Cloudflare R2; WASM for onnxruntime loads from a CDN.

### Rendering

- The canvas draws the background color, the character base image, the current mouth-shape image (from the phoneme timeline), a blink overlay, and applies:
  - **Bounce** — squash-and-stretch keyframes triggered on each beat.
  - **Sway** — a progressive horizontal "twist" of the body, easing between beats.
- Every asset (base, mouth, lyrics) has an editable transform (position / scale / rotation) via an edit mode with on-canvas handles.
- Lyrics are rendered as white rounded **cards** with pointer arrows over the canvas (DOM in preview, canvas-drawn in export).

### MP4 export

Export is a **deterministic offline re-render** (does not depend on live playback):

- Fixed output **1280 × 720 @ 30 fps**.
- `VideoEncoder` (H.264) + `AudioEncoder` (AAC), muxed into MP4 with **mp4-muxer**.
- Blink uses a seeded pseudo-random schedule so it's reproducible; energy is computed from the audio PCM; bounce/sway re-derive from the beat timeline.
- If the browser does not provide a `decoderConfig` in the encoder output, the first frame's H.264 SPS/PPS are parsed and re-assembled into an `AVCDecoderConfigurationRecord` so muxing never crashes.
- Requires Chrome/Edge 94+ or Safari 17+ (WebCodecs). Firefox shows a clear "not supported" message.

### Storage

Uploaded images and UI settings are persisted in **IndexedDB** (`src/utils/db.ts`, `storage.ts`) so a refresh keeps your characters and config.

### Optional Python backend

A FastAPI server (`backend/server.py`) provides the same analysis (SOFA aligner, Demucs separation, librosa beat detection) over HTTP for local use:

- `POST /analyze-url` · `POST /analyze` — full audio analysis
- `POST /analyze-url-chunked` · `POST /analyze-chunked` — chunked streaming analysis
- `POST /log-alignment` — diagnostics

The deployed site is fully static and does **not** require this backend.

---

## Results

- A live, beat-synced lip-sync animation of up to two singing characters.
- Assignable lyrics (solo / duet) with animated lyric cards.
- A downloadable **MP4** video (H.264 + AAC, 1280×720@30fps) with audio, mouth movement, bounce/sway, blinking and lyrics baked in.

---

## Running locally

Prerequisites: Node.js ≥ 20, npm ≥ 10 (see note below), Python 3.x with the backend deps only if you want the optional server.

```bash
# 1. Install frontend dependencies
npm install

# 2. Start the Vite dev server (frontend only, everything in-browser)
npm run dev
# → http://localhost:5173
```

Or run both frontend + optional backend with the helper scripts:

```bash
start.bat     # Windows
start.ps1     # Windows PowerShell
```

Backend (optional):

```bash
cd backend
pip install -r requirements.txt
python server.py
# → http://localhost:8001
```

---

## Building & deploying

```bash
npm run build        # outputs dist/
npm run preview      # serve the production build locally
```

The project is deployed as a static site (e.g. **Cloudflare Pages**):

- Build command: `npm run build`, output directory: `dist`.
- Large ML models are hosted on a public **Cloudflare R2** bucket and loaded at runtime (see `SOFA_MODEL_PATH` in `src/utils/client/sofaPipeline.ts`); they are not part of the static bundle.
- **Important:** `package-lock.json` must stay in sync with npm 10 (`npx -p npm@10.9.2 npm install`). Cloudflare Pages runs `npm ci` with npm 10.9.2, which rejects lockfiles generated by npm 11 because of the `@emnapi/core` / `@emnapi/runtime` overrides.

---

## Scripts

| Script | Description |
|---|---|
| `npm run dev` | Start Vite dev server (`--host 0.0.0.0`) |
| `npm run build` | Production build to `dist/` |
| `npm run typecheck` | TypeScript type-check (`tsc --noEmit`) |
| `npm run lint` | Oxlint |
| `npm run preview` | Serve the production build |

---

## Project structure

```
.
├── src/                  # React + TypeScript frontend
│   ├── components/       # CanvasPreview, RightPanel
│   ├── utils/            # audio, renderer, exporter, analysis, storage, …
│   ├── types/            # shared types & defaults
│   └── styles/           # app.css
├── backend/              # Optional FastAPI server (SOFA / Demucs / beats)
├── models/               # Local copies of ONNX models (gitignored)
├── dist/                 # Production build output (gitignored)
├── vite.config.ts        # Vite build config
└── vercel.json           # (legacy) cache headers
```

## Browser support

- **MP4 export:** Chrome/Edge 94+, Safari 17+ (WebCodecs).
- **Analysis & preview:** Chromium-based browsers recommended (onnxruntime-web WASM).
- Firefox: analysis works, but MP4 export is not supported.
