// Resolves a sprite set's sheet keys to drawable image sources, once per set.
// A key present in the set's in-memory `sources` is used as-is (procedural or
// test sprites); otherwise it's fetched relative to `baseUrl`. How assets reach
// `baseUrl` — bundled, streamed, lazily loaded — is the consumer's concern; this
// only fetches what a set references, when the set is first loaded.

import { getSpriteSet } from "./manifest";

const loadedBySet = new Map<string, Map<string, CanvasImageSource>>();

/** Load (and memoize) every sheet a set references. Idempotent per set id. */
export async function loadSpriteSet(id: string): Promise<void> {
  if (loadedBySet.has(id)) return;
  const def = getSpriteSet(id);

  const keys = new Set<string>();
  for (const item of Object.values(def.manifest.items)) {
    for (const sheetKey of Object.values(item.sheets)) keys.add(sheetKey);
  }

  const images = new Map<string, CanvasImageSource>();
  await Promise.all(
    [...keys].map(async (key) => {
      const inMemory = def.sources?.[key];
      images.set(key, inMemory ?? (await fetchImage((def.baseUrl ?? "") + key)));
    }),
  );
  loadedBySet.set(id, images);
}

export function isSpriteSetLoaded(id: string): boolean {
  return loadedBySet.has(id);
}

export function getSheetImage(id: string, sheetKey: string): CanvasImageSource | null {
  return loadedBySet.get(id)?.get(sheetKey) ?? null;
}

/** Test/HMR seam — forget loaded images so a re-register re-fetches. */
export function clearLoadedImages(): void {
  loadedBySet.clear();
}

async function fetchImage(url: string): Promise<CanvasImageSource> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`paperdoll: failed to load sheet "${url}" (${res.status})`);
  return createImageBitmap(await res.blob());
}
