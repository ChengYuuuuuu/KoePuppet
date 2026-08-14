import { type LyricLine } from '../types/index';

const METING_API = 'https://api.qijieya.cn/meting/';

export interface SongParseResponse {
  success: boolean;
  data?: {
    title: string;
    artist: string;
    coverUrl: string;
    audioUrl: string;
    lyrics: string;
  };
  error?: string;
}

type MusicPlatform = 'netease' | 'tencent';

function detectPlatform(url: string): MusicPlatform | null {
  if (/163\.com|music\.163\.com/i.test(url)) return 'netease';
  if (/qq\.com|y\.qq\.com|i\.y\.qq\.com/i.test(url)) return 'tencent';
  return null;
}

export function extractSongId(url: string, platform?: MusicPlatform): string | null {
  const p = platform ?? detectPlatform(url);
  if (p === 'tencent') return extractQQSongId(url);
  const patterns = [
    /[?&]id=(\d+)/,
    /\/song\/(\d+)/,
    /music\.163\.com.*?(\d{5,12})/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

function extractQQSongId(url: string): string | null {
  const patterns = [
    /\/songDetail\/([0-9A-Za-z]{8,})/,
    /\/song\/([0-9A-Za-z]{8,})/,
    /[?&]songmid=([0-9A-Za-z]{8,})/,
    /[?&]songid=(\d+)/,
  ];
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  return null;
}

export async function parseSongUrl(url: string): Promise<SongParseResponse> {
  const platform = detectPlatform(url);
  if (!platform) {
    return { success: false, error: '仅支持网易云或 QQ 音乐链接' };
  }

  const songId = extractSongId(url, platform);
  if (!songId) {
    return { success: false, error: '无法解析歌曲ID，请检查链接格式' };
  }

  try {
    const metaRes = await fetch(`${METING_API}?server=${platform}&type=song&id=${songId}`);
    const meta = (await metaRes.json())[0];

    if (!meta.url) {
      return { success: false, error: '该歌曲无法获取播放地址' };
    }

    let audioUrl = meta.url;
    if (!audioUrl.endsWith('.mp3')) {
      try {
        const urlRes = await fetch(audioUrl);
        audioUrl = urlRes.url;
      } catch {
        // redirect 失败时保留原 audioUrl（Meting API 代理地址），不中断流程
      }
    }

    const lrcRes = await fetch(meta.lrc);
    const lyrics = await lrcRes.text();

    return {
      success: true,
      data: {
        title: meta.name || '',
        artist: meta.artist || '',
        coverUrl: meta.pic || '',
        audioUrl,
        lyrics,
      },
    };
  } catch {
    return { success: false, error: 'API 请求失败，请检查网络连接' };
  }
}

export function parseLRC(lrcText: string): LyricLine[] {
  const lines = lrcText.split('\n');
  const lyrics: LyricLine[] = [];
  const timeRegex = /\[(\d{2}):(\d{2})[.:](\d{1,3})\]/g;

  for (const line of lines) {
    const matches = [...line.matchAll(timeRegex)];
    if (matches.length === 0) continue;

    const text = line.replace(timeRegex, '').trim();
    if (!text) continue;

    for (const match of matches) {
      const minutes = parseInt(match[1]);
      const seconds = parseInt(match[2]);
      const fraction = parseFloat(`0.${match[3]}`);
      const time = minutes * 60 + seconds + fraction;
      lyrics.push({ time, text });
    }
  }

  lyrics.sort((a, b) => a.time - b.time);
  return lyrics;
}

export function getCurrentLyric(
  lyrics: LyricLine[],
  currentTime: number,
  offset: number = 0
): LyricLine | null {
  const adjustedTime = currentTime + offset / 1000;
  let result: LyricLine | null = null;
  for (const line of lyrics) {
    if (line.time <= adjustedTime) {
      result = line;
    } else {
      break;
    }
  }
  return result;
}
