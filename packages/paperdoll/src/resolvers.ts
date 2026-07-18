// The three pure resolvers the pipeline is built from. None of them touch
// Three.js, canvases, or the registry — they turn data into data, which is what
// keeps them unit-testable and keeps the render backends interchangeable.

import type { Direction } from "./direction";
import { DIRECTION_COUNT } from "./direction";
import type { FamilyDef, ItemDef, LayerOrderMatrix, SpriteManifest } from "./manifest";

/** What an entity is wearing: layer slot -> item id. Plain game data. */
export type Loadout = Record<string, string>;

/** Stable key for a loadout — equal loadouts (any key order) produce equal keys. */
export function loadoutKey(loadout: Loadout): string {
  return Object.entries(loadout)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([slot, item]) => `${slot}:${item}`)
    .join("|");
}

// --- Pose resolver: family clock -> frame -------------------------------------

export interface FrameResult {
  frame: number;
  /** A one-shot family has reached its end (last frame shown). */
  done: boolean;
}

/**
 * Which frame a family shows `elapsedMs` into playing. Looping families wrap;
 * one-shot families clamp to the last frame and report `done` (the caller then
 * honors `next`/`holdLast`).
 */
export function frameAt(family: FamilyDef, elapsedMs: number): FrameResult {
  const frames = Math.max(1, family.frames);
  const raw = Math.floor((Math.max(0, elapsedMs) / 1000) * family.fps);
  if (family.loop) {
    return { frame: raw % frames, done: false };
  }
  if (raw >= frames - 1) {
    return { frame: frames - 1, done: true };
  }
  return { frame: raw, done: false };
}

// --- Equipment resolver: loadout -> layers ------------------------------------

export interface EquipLayer {
  slot: string;
  itemId: string;
  item: ItemDef;
}

/**
 * Expand a loadout into the item defs to draw, dropping slots whose item id
 * isn't in the manifest (a missing item is skipped, never fatal).
 */
export function resolveEquipment(manifest: SpriteManifest, loadout: Loadout): EquipLayer[] {
  const layers: EquipLayer[] = [];
  for (const [slot, itemId] of Object.entries(loadout)) {
    const item = manifest.items[itemId];
    if (item) layers.push({ slot, itemId, item });
  }
  return layers;
}

// --- Layering resolver: layers + direction -> ordered passes ------------------

export interface DrawPass {
  slot: string;
  itemId: string;
  /** Sheet key for the resolved family, or null if the item has no sheet for it. */
  sheetKey: string | null;
  z: number;
}

function zForDirection(matrix: LayerOrderMatrix, slot: string, dir: Direction): number {
  const z = matrix[slot];
  if (z === undefined) return 0;
  if (Array.isArray(z)) return z[dir] ?? 0;
  return z;
}

/**
 * Order the equipped layers back-to-front for a direction and attach the sheet
 * each will draw for `family`. Ties in z break by the item's slot order in the
 * layer matrix, so output is deterministic. A layer whose item lacks the family
 * sheet stays in the stack with `sheetKey: null` — the caller resolves the
 * fallback (it may share the layer matrix z regardless of which sheet wins).
 */
export function resolveLayering(
  manifest: SpriteManifest,
  layers: EquipLayer[],
  dir: Direction,
  family: string,
): DrawPass[] {
  const slotOrder = Object.keys(manifest.layerOrder);
  return layers
    .map((l) => ({
      slot: l.slot,
      itemId: l.itemId,
      sheetKey: l.item.sheets[family] ?? null,
      z: zForDirection(manifest.layerOrder, l.slot, dir),
    }))
    .sort((a, b) => {
      if (a.z !== b.z) return a.z - b.z;
      return slotOrder.indexOf(a.slot) - slotOrder.indexOf(b.slot);
    });
}

/** Diagonal directions borrow the preceding cardinal row on a 4-row sheet. */
export function sheetRowForDirection(dir: Direction, rows: 4 | 8): number {
  if (rows === DIRECTION_COUNT) return dir;
  // 8-way ring is S,SW,W,NW,N,NE,E,SE; a 4-row sheet stores only S,W,N,E (the
  // even indices). Each diagonal borrows the cardinal just before it in the
  // ring, which collapses to floor(dir/2): SW->S, NW->W, NE->N, SE->E.
  return Math.floor(dir / 2);
}
