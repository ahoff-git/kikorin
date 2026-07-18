// Manifest: the data contract a consumer authors to describe one sprite set —
// its cell size, animation families, how engine action kinds map to families,
// the per-direction layer order, and the items that can be equipped. The engine
// ships none of this; a game registers it (see registerSpriteSet).
//
// NOTE (v1): this shape is intentionally *not* frozen or schema-validated yet.
// The formal, versioned contract is a later pass (see specs/paperdoll and ADR
// 0014). Parsing here only guards against the mistakes that would crash a bake.

import { DIRECTION_COUNT } from "./direction";

/** A single animation (a row-set of frames), e.g. "walk" or "attack.slash". */
export interface FamilyDef {
  /** Frame columns in each direction row. */
  frames: number;
  fps: number;
  loop: boolean;
  /** One-shot only: family to switch to when it ends (omitted = resume locomotion). */
  next?: string;
  /** One-shot only: freeze on the final frame instead of transitioning. */
  holdLast?: boolean;
}

/** An equippable visual — one sheet per family it supports. */
export interface ItemDef {
  /** Layer slot this item occupies (keys the layer-order matrix). */
  slot: string;
  /** family name -> sheet key (an entry in the set's `sheets`/`sources`). */
  sheets: Record<string, string>;
}

/**
 * Per-slot draw order. A scalar applies to every direction; an 8-element array
 * gives a distinct z per direction (what makes a weapon draw in front facing
 * south and behind facing north). Lower z draws first (further back).
 */
export type LayerOrderMatrix = Record<string, number | number[]>;

export interface SpriteManifest {
  /** [width, height] px of one animation frame; uniform across the set. */
  cell: [number, number];
  /** Sprite origin in cell fractions; [0.5, 1.0] = bottom-center (feet). */
  anchor: [number, number];
  /** Direction rows present per sheet (default 8). 4 = cardinals; diagonals borrow the nearest cardinal. */
  rows?: 4 | 8;
  families: Record<string, FamilyDef>;
  /** "kind" or "kind.variant" (numeric, matching the engine action enum) -> family name. */
  actionMap: Record<string, string>;
  /** family name -> fallback family when a sheet is missing; "*" is the terminal fallback. */
  fallbacks?: Record<string, string>;
  layerOrder: LayerOrderMatrix;
  items: Record<string, ItemDef>;
}

export interface SpriteSetDef {
  manifest: SpriteManifest;
  /** Root that `sheets` string values resolve against when they are URLs. */
  baseUrl?: string;
  /**
   * In-memory sheet sources keyed the same way `items[*].sheets` values are.
   * Present entries win over `baseUrl` fetching — this is how procedural or
   * test sprites skip the network entirely (an intentional convenience, not a
   * required path).
   */
  sources?: Record<string, CanvasImageSource>;
}

const registry = new Map<string, SpriteSetDef>();

/** Register a sprite set under an id the game passes to createPaperDollSprite. */
export function registerSpriteSet(id: string, def: SpriteSetDef): void {
  validateManifest(id, def.manifest);
  registry.set(id, def);
}

export function getSpriteSet(id: string): SpriteSetDef {
  const def = registry.get(id);
  if (!def) throw new Error(`paperdoll: sprite set "${id}" is not registered`);
  return def;
}

export function hasSpriteSet(id: string): boolean {
  return registry.has(id);
}

/** Test/HMR seam — drop all registrations. */
export function clearSpriteSets(): void {
  registry.clear();
}

function validateManifest(id: string, m: SpriteManifest): void {
  if (!m.cell || m.cell[0] <= 0 || m.cell[1] <= 0) {
    throw new Error(`paperdoll: set "${id}" has an invalid cell size`);
  }
  const rows = m.rows ?? DIRECTION_COUNT;
  if (rows !== 4 && rows !== DIRECTION_COUNT) {
    throw new Error(`paperdoll: set "${id}" rows must be 4 or ${DIRECTION_COUNT}`);
  }
  for (const [slot, z] of Object.entries(m.layerOrder)) {
    if (Array.isArray(z) && z.length !== DIRECTION_COUNT) {
      throw new Error(`paperdoll: set "${id}" layerOrder["${slot}"] array must have ${DIRECTION_COUNT} entries`);
    }
  }
}

/**
 * Resolve an engine action to a family name. Tries "kind.variant" first, then
 * "kind", then the fallback chain, guaranteeing a family that exists.
 */
export function familyForAction(m: SpriteManifest, kind: number, variant?: number): string {
  const keyed = variant !== undefined ? m.actionMap[`${kind}.${variant}`] : undefined;
  const named = keyed ?? m.actionMap[`${kind}`];
  if (named && m.families[named]) return named;
  if (named) return resolveFamilyFallback(m, named);
  return resolveFamilyFallback(m, "*");
}

/** Walk the fallback chain until a defined family is found; "idle" is the last resort. */
export function resolveFamilyFallback(m: SpriteManifest, family: string): string {
  const seen = new Set<string>();
  let cur = family;
  while (cur && !seen.has(cur)) {
    if (m.families[cur]) return cur;
    seen.add(cur);
    cur = m.fallbacks?.[cur] ?? m.fallbacks?.["*"] ?? "idle";
  }
  if (m.families["idle"]) return "idle";
  // A set with neither the requested family, a fallback, nor idle is malformed.
  throw new Error(`paperdoll: no resolvable family for "${family}" and no "idle" fallback`);
}
