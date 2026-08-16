import { type UIConfig, DEFAULT_UI_CONFIG, type MouthImages, type EyeImages, type AssetTransform } from '../types/index';
import { dbGet, dbSet } from './db';

const STORAGE_KEYS = {
  UI_CONFIG: 'lip-sync-ui-config',
  MOUTH_IMAGES: 'lip-sync-mouth-images',
  BASE_IMAGE: 'lip-sync-base-image',
  ASSET_TRANSFORMS: 'lip-sync-asset-transforms',
  EYE_IMAGES: 'lip-sync-eye-images',
  BASE_IMAGE_2: 'lip-sync-base-image-2',
  MOUTH_IMAGES_2: 'lip-sync-mouth-images-2',
  EYE_IMAGES_2: 'lip-sync-eye-images-2',
} as const;

export function saveUIConfig(config: Partial<UIConfig>): void {
  try {
    const existing = loadUIConfig();
    const merged = { ...existing, ...config };
    localStorage.setItem(STORAGE_KEYS.UI_CONFIG, JSON.stringify(merged));
  } catch {}
}

export function loadUIConfig(): UIConfig {
  try {
    const data = localStorage.getItem(STORAGE_KEYS.UI_CONFIG);
    if (data) return { ...DEFAULT_UI_CONFIG, ...JSON.parse(data) };
  } catch {}
  return { ...DEFAULT_UI_CONFIG };
}

export async function saveBaseImage(dataUrl: string): Promise<boolean> {
  try {
    await dbSet(STORAGE_KEYS.BASE_IMAGE, dataUrl);
    return true;
  } catch (e) {
    console.warn('IndexedDB save failed for base image', e);
    return false;
  }
}

export async function loadBaseImage(): Promise<string | null> {
  try {
    return await dbGet(STORAGE_KEYS.BASE_IMAGE);
  } catch {
    return null;
  }
}

export async function saveMouthImages(images: MouthImages): Promise<boolean> {
  try {
    await dbSet(STORAGE_KEYS.MOUTH_IMAGES, JSON.stringify(images));
    return true;
  } catch (e) {
    console.warn('IndexedDB save failed for mouth images', e);
    return false;
  }
}

export async function loadMouthImages(): Promise<MouthImages | null> {
  try {
    const data = await dbGet(STORAGE_KEYS.MOUTH_IMAGES);
    if (data) return JSON.parse(data);
  } catch {}
  return null;
}

export async function saveAssetTransforms(transforms: Record<string, AssetTransform>): Promise<void> {
  try {
    await dbSet(STORAGE_KEYS.ASSET_TRANSFORMS, JSON.stringify(transforms));
  } catch (e) {
    console.warn('IndexedDB save failed for asset transforms', e);
  }
}

export async function loadAssetTransforms(): Promise<Record<string, AssetTransform> | null> {
  try {
    const data = await dbGet(STORAGE_KEYS.ASSET_TRANSFORMS);
    if (data) return JSON.parse(data);
  } catch {}
  return null;
}

export async function saveEyeImages(images: EyeImages): Promise<boolean> {
  try {
    await dbSet(STORAGE_KEYS.EYE_IMAGES, JSON.stringify(images));
    return true;
  } catch (e) {
    console.warn('IndexedDB save failed for eye images', e);
    return false;
  }
}

export async function loadEyeImages(): Promise<EyeImages | null> {
  try {
    const data = await dbGet(STORAGE_KEYS.EYE_IMAGES);
    if (data) return JSON.parse(data);
  } catch {}
  return null;
}

export async function saveBaseImage2(dataUrl: string): Promise<boolean> {
  try {
    await dbSet(STORAGE_KEYS.BASE_IMAGE_2, dataUrl);
    return true;
  } catch (e) {
    console.warn('IndexedDB save failed for base image 2', e);
    return false;
  }
}

export async function loadBaseImage2(): Promise<string | null> {
  try {
    return await dbGet(STORAGE_KEYS.BASE_IMAGE_2);
  } catch {
    return null;
  }
}

export async function saveMouthImages2(images: MouthImages): Promise<boolean> {
  try {
    await dbSet(STORAGE_KEYS.MOUTH_IMAGES_2, JSON.stringify(images));
    return true;
  } catch (e) {
    console.warn('IndexedDB save failed for mouth images 2', e);
    return false;
  }
}

export async function loadMouthImages2(): Promise<MouthImages | null> {
  try {
    const data = await dbGet(STORAGE_KEYS.MOUTH_IMAGES_2);
    if (data) return JSON.parse(data);
  } catch {}
  return null;
}

export async function saveEyeImages2(images: EyeImages): Promise<boolean> {
  try {
    await dbSet(STORAGE_KEYS.EYE_IMAGES_2, JSON.stringify(images));
    return true;
  } catch (e) {
    console.warn('IndexedDB save failed for eye images 2', e);
    return false;
  }
}

export async function loadEyeImages2(): Promise<EyeImages | null> {
  try {
    const data = await dbGet(STORAGE_KEYS.EYE_IMAGES_2);
    if (data) return JSON.parse(data);
  } catch {}
  return null;
}

export async function clearAssets(): Promise<boolean> {
  try {
    await dbDelete(STORAGE_KEYS.BASE_IMAGE);
    await dbDelete(STORAGE_KEYS.MOUTH_IMAGES);
    await dbDelete(STORAGE_KEYS.EYE_IMAGES);
    return true;
  } catch (e) {
    console.warn('IndexedDB clear failed for role 1 assets', e);
    return false;
  }
}

export async function clearAssets2(): Promise<boolean> {
  try {
    await dbDelete(STORAGE_KEYS.BASE_IMAGE_2);
    await dbDelete(STORAGE_KEYS.MOUTH_IMAGES_2);
    await dbDelete(STORAGE_KEYS.EYE_IMAGES_2);
    return true;
  } catch (e) {
    console.warn('IndexedDB clear failed for role 2 assets', e);
    return false;
  }
}

