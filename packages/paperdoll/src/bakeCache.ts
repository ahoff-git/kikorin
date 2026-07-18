// Composites a loadout's layers into one texture per (set, loadout, family): a
// grid of 8 direction rows × N frame columns, each row ordered back-to-front for
// its own direction. Playback and facing are pure UV math on this texture
// (sprite.ts drives texture.offset), which is the Three.js-native way to animate
// a sprite sheet — so this canvas work happens once per distinct look, and both
// "which frame" and "which direction" are free per-frame shifts afterward.
//
// Equipment changes mint a new loadout key and stop referencing old entries; a
// bounded LRU ages those out.

import { CanvasTexture, NearestFilter, SRGBColorSpace, type Texture } from "three";
import { DIRECTION_COUNT, type Direction } from "./direction";
import { getSpriteSet } from "./manifest";
import { log, logLevels } from "@kikorin/util";
import { getSheetImage } from "./images";
import { sheetRowForDirection, type DrawPass } from "./resolvers";

// Soft cap that *doubles* when hit rather than evicting (ADR 0020). Per-sprite
// clones share a cached texture's Source, so evicting one out from under a live
// sprite would break it; growing avoids that entirely. At realistic look counts
// this never trips.
let cacheCap = 64;

interface CacheEntry {
  texture: CanvasTexture;
  frames: number;
}

// Insertion order doubles as LRU order: a hit re-inserts, so the oldest key is
// always first.
const cache = new Map<string, CacheEntry>();

export interface BakedSheet {
  /** A frames×DIRECTION_COUNT grid. Select a cell with texture.offset/repeat. */
  texture: Texture;
  frames: number;
  /** Always DIRECTION_COUNT — a 4-row source is expanded to 8 baked rows. */
  rows: number;
}

/**
 * Get (baking on first use) the full sheet for one look. `rowPasses(dir)` returns
 * that direction's layers ordered back-to-front (resolveLayering) — it's called
 * only on a cache miss, once per direction row. A layer with no sheet for the
 * family is skipped.
 */
export function getSheet(
  setId: string,
  loadoutKey: string,
  family: string,
  frames: number,
  rowPasses: (dir: Direction) => DrawPass[],
): BakedSheet {
  const key = `${setId}|${loadoutKey}|${family}`;

  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return { texture: hit.texture, frames: hit.frames, rows: DIRECTION_COUNT };
  }

  const entry = bake(setId, frames, rowPasses);
  cache.set(key, entry);
  if (cache.size > cacheCap) {
    cacheCap *= 2;
    log(logLevels.debug, `paperdoll: bake cache grew to ${cacheCap} looks`, ["paperdoll"]);
  }
  return { texture: entry.texture, frames: entry.frames, rows: DIRECTION_COUNT };
}

function bake(setId: string, frames: number, rowPasses: (dir: Direction) => DrawPass[]): CacheEntry {
  const { manifest } = getSpriteSet(setId);
  const [cellW, cellH] = manifest.cell;
  const srcRows = manifest.rows ?? DIRECTION_COUNT;
  const count = Math.max(1, frames);

  const canvas = makeCanvas(cellW * count, cellH * DIRECTION_COUNT);
  const ctx = canvas.getContext("2d") as CanvasRenderingContext2D | null;
  if (!ctx) throw new Error("paperdoll: 2D canvas context unavailable for baking");
  ctx.imageSmoothingEnabled = false; // pixel-art: keep hard edges

  for (let dir = 0; dir < DIRECTION_COUNT; dir += 1) {
    const srcRow = sheetRowForDirection(dir as Direction, srcRows);
    for (const pass of rowPasses(dir as Direction)) {
      if (!pass.sheetKey) continue; // item has no sheet for this family — skip layer
      const img = getSheetImage(setId, pass.sheetKey);
      if (!img) continue;
      for (let f = 0; f < count; f += 1) {
        ctx.drawImage(
          img,
          f * cellW, srcRow * cellH, cellW, cellH, // source cell (frame column, source row)
          f * cellW, dir * cellH, cellW, cellH,    // baked cell (frame column, direction row)
        );
      }
    }
  }

  const texture = new CanvasTexture(canvas as HTMLCanvasElement);
  // Tuned for Three.js color management (r152+): a color map must declare sRGB
  // or it renders with the wrong gamma. Nearest + no mipmaps keeps pixel art crisp.
  texture.colorSpace = SRGBColorSpace;
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return { texture, frames: count };
}

function makeCanvas(w: number, h: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return c;
}

/** Drop every cached sheet and free its GPU texture. */
export function disposeSheetCache(): void {
  for (const entry of cache.values()) entry.texture.dispose();
  cache.clear();
}
