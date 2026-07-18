// Procedural placeholder sprite set + matching animation definitions for the
// top-down game. This is *game data*, not engine code (like KIKORIN_TOPDOWN_MAP).
// It exists so the paper-doll pipeline has something to render and animate
// without shipping real art, and doubles as the reference example for authoring
// a real set: the art half (sheets, drawn here to offscreen canvases) feeds
// @kikorin/paperdoll, and the behavior half (KIKORIN_ANIM_DEFS) is loaded into
// the Rust engine, which owns the animation simulation (ADR 0015).
//
// The two halves are kept in step by FAMILY_ORDER: the engine emits an anim_id
// that indexes it, and the sprite maps that back to a family name to bake.

import type { AnimationDefsInput, AnimFamilyInput } from "@kikorin/adapter";
import type { SpriteManifest, SpriteSetDef } from "@kikorin/paperdoll";

const CELL_W = 32;
const CELL_H = 48;

// SINGLE SOURCE OF TRUTH for the family set. Everything else — the engine anim
// defs (load_animations), the art manifest's families, FAMILY_ORDER (the
// anim_id↔name bridge), and per-family frame counts — is derived from this, so
// they can't drift out of alignment (the classic paper-doll footgun; see ADR
// 0019). Family order here IS the engine `anim_id` order and matches the engine
// action kinds (idle=0, walk=1, attack=2). Add a family = one entry here + a
// draw case in the item drawers below.
interface FamilySpec {
  name: string;
  loop: boolean;
  interrupt?: "always" | "block" | "queue";
  /** Freeze the final frame instead of ending (death). */
  holdLast?: boolean;
  /** Re-requesting while playing restarts it (combo/rapid re-fire). */
  retriggerable?: boolean;
  /** Movement allowed while this plays; omit a field = allowed (ADR 0018). */
  movement?: AnimFamilyInput["movement"];
  /** Per-frame optimal ms + optional frame-event id (ADR 0017). */
  frames: { ms: number; event?: number }[];
}

// Family order = engine anim_id = engine action kind (idle=0, walk=1, attack=2,
// hurt=3, death=4). Adding a family here must keep that alignment with the
// engine's ANIM_KIND_* constants.
const FAMILIES_SPEC: FamilySpec[] = [
  { name: "idle", loop: true, frames: [{ ms: 450 }, { ms: 450 }] },
  { name: "walk", loop: true, frames: [{ ms: 110 }, { ms: 110 }, { ms: 110 }, { ms: 110 }] },
  {
    // Run-and-gun shot: raise the gun fast, FIRE the instant it's out (frame 2,
    // event 1 — the gun-fire frame, ADR 0017), HOLD it extended for a few
    // moments, then lower it back down the same path (frames 5–6 mirror 1–0, so
    // it "plays backwards" home — the drawer's raiseHoldLower is symmetric). You
    // can move + turn while firing, just not jump mid-shot (move-mask, ADR 0018).
    name: "attack",
    loop: false,
    interrupt: "block",
    retriggerable: true,
    movement: { jump: false },
    frames: [
      { ms: 40 }, // 0 rest
      { ms: 45 }, // 1 raising
      { ms: 90, event: 1 }, // 2 gun out → FIRE
      { ms: 150 }, // 3 held out
      { ms: 150 }, // 4 held out
      { ms: 45 }, // 5 lowering (mirrors 1)
      { ms: 40 }, // 6 rest (mirrors 0)
    ],
  },
  // Quick flinch on non-lethal damage (ADR 0020) — short and blocking so it
  // reads before locomotion resumes.
  { name: "hurt", loop: false, interrupt: "block", frames: [{ ms: 80 }, { ms: 80 }] },
  // Death: one-shot that holds its final (collapsed) frame; the engine despawns
  // the entity when it finishes (ADR 0020).
  {
    name: "death",
    loop: false,
    interrupt: "block",
    holdLast: true,
    movement: { forward: false, strafe: false, turn: false, jump: false },
    frames: [{ ms: 120 }, { ms: 260 }],
  },
];

/** Family names in engine `anim_id` order — derived, so it can't drift. */
export const FAMILY_ORDER = FAMILIES_SPEC.map((f) => f.name);

const FAMILY_FRAMES: Record<string, number> = Object.fromEntries(
  FAMILIES_SPEC.map((f) => [f.name, f.frames.length]),
);

// Per-direction unit vector in cell pixel space (y-down). Row order is the
// engine's Direction enum: S, SW, W, NW, N, NE, E, SE. Sheets are flipY, so
// small y = screen-up = north.
const FACING: ReadonlyArray<readonly [number, number]> = [
  [0, 1], [-0.7, 0.7], [-1, 0], [-0.7, -0.7], [0, -1], [0.7, -0.7], [1, 0], [0.7, 0.7],
];

type CellDrawer = (
  ctx: CanvasRenderingContext2D,
  family: string,
  dir: number,
  frame: number,
  frames: number,
) => void;

interface ItemSpec {
  id: string;
  slot: string;
  draw: CellDrawer;
}

function walkSwing(frame: number, frames: number): number {
  if (frames <= 1) return 0;
  return [0, -2, 0, 2][frame % 4] ?? 0;
}

/** 0→1 progress through a one-shot family. */
function progress(frame: number, frames: number): number {
  return frames > 1 ? frame / (frames - 1) : 0;
}

/**
 * Symmetric raise → hold → lower profile in [0,1]: ramps up over the first
 * quarter, holds at 1 through the middle, ramps back down over the last quarter.
 * The descent is the ascent mirrored, so the gun "plays backwards" on the way
 * home. Used for the shooting pose (raise the gun, hold it out, lower it).
 */
function raiseHoldLower(frame: number, frames: number): number {
  const p = progress(frame, frames);
  return Math.max(0, Math.min(1, (1 - Math.abs(2 * p - 1)) / 0.5));
}

function drawBody(color: string, shade: string): CellDrawer {
  return (ctx, family, dir, frame, frames) => {
    const [fx, fy] = FACING[dir];

    if (family === "death") {
      // Collapse: sink + squash over the frames, holding the prone last frame.
      const t = progress(frame, frames);
      const cx = CELL_W / 2;
      const yTop = 20 + t * 18;
      const h = 16 * (1 - t) + 4;
      ctx.fillStyle = shade;
      ctx.fillRect(cx - 8, yTop + h, 16, 4); // prone slab
      ctx.fillStyle = color;
      ctx.fillRect(cx - 6, yTop, 12, h); // squashed torso
      ctx.beginPath();
      ctx.arc(cx + t * 8, yTop - 2 + t * 6, 6 - t * 2, 0, Math.PI * 2); // head slumps aside
      ctx.fill();
      return;
    }

    let swing = 0;
    let bob = 0;
    let lunge = 0;
    let recoil = 0;
    if (family === "walk") swing = walkSwing(frame, frames);
    else if (family === "idle") bob = frame % 2 === 0 ? 0 : 1;
    else if (family === "hurt") recoil = 3 * (1 - progress(frame, frames)); // quick knock-back that settles
    // "attack" leaves the body still — the weapon raises/holds/lowers so the hat
    // and head stay put (the sword layer carries the shooting motion).

    const cx = CELL_W / 2 + fx * (lunge - recoil);
    const topShift = bob + fy * (lunge - recoil) * 0.5;

    // Legs (opposed swing while walking).
    ctx.fillStyle = shade;
    ctx.fillRect(cx - 6, 34 + topShift + swing, 4, 12 - Math.abs(swing));
    ctx.fillRect(cx + 2, 34 + topShift - swing, 4, 12 - Math.abs(swing));

    // Torso + head.
    ctx.fillStyle = color;
    ctx.fillRect(cx - 6, 18 + topShift, 12, 16);
    ctx.beginPath();
    ctx.arc(cx, 12 + topShift, 7, 0, Math.PI * 2);
    ctx.fill();

    // Facing marker.
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.arc(cx + fx * 5, 12 + topShift + fy * 5, 2.2, 0, Math.PI * 2);
    ctx.fill();
  };
}

function drawHat(color: string): CellDrawer {
  return (ctx, family, dir) => {
    if (family === "death") return; // the collapsed body stands in for death
    const cx = CELL_W / 2;
    const [fx, fy] = FACING[dir];
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx + fx * 2, 9 + fy * 2, 8, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(cx - 9 + fx * 2, 8 + fy * 2, 18, 2);
  };
}

const WEAPON_REST = -Math.PI / 5; // stowed at the side
const WEAPON_OUT = 1.4; // raised, extended forward to fire

function drawSword(color: string): CellDrawer {
  return (ctx, family, _dir, frame, frames) => {
    if (family === "death") return; // dropped on death (collapsed body only)
    ctx.save();
    ctx.translate(CELL_W / 2, CELL_H / 2);
    // Attack raises the gun out, holds it there, then lowers it back along the
    // same path (raiseHoldLower is symmetric — the return is the raise reversed).
    const t = family === "attack" ? raiseHoldLower(frame, frames) : 0;
    ctx.rotate(WEAPON_REST + (WEAPON_OUT - WEAPON_REST) * t);
    ctx.fillStyle = color;
    ctx.fillRect(-2, -20, 4, 30);
    ctx.fillStyle = "#c9a227";
    ctx.fillRect(-4, 8, 8, 4); // hilt
    ctx.restore();
  };
}

const ITEMS: ItemSpec[] = [
  { id: "body-hero", slot: "body", draw: drawBody("#4488cc", "#2b5f92") },
  { id: "body-monster", slot: "body", draw: drawBody("#cc4444", "#902b2b") },
  { id: "hat-hero", slot: "head", draw: drawHat("#ffd54a") },
  { id: "sword", slot: "weapon", draw: drawSword("#dfe6ee") },
];

function sheetKey(itemId: string, family: string): string {
  return `${itemId}/${family}`;
}

function renderSheet(draw: CellDrawer, family: string, frames: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = CELL_W * frames;
  canvas.height = CELL_H * 8; // 8 direction rows
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  for (let dir = 0; dir < 8; dir += 1) {
    for (let frame = 0; frame < frames; frame += 1) {
      ctx.save();
      ctx.translate(frame * CELL_W, dir * CELL_H);
      draw(ctx, family, dir, frame, frames);
      ctx.restore();
    }
  }
  return canvas;
}

/**
 * Build the placeholder sprite set: a manifest plus in-memory canvas sheets for
 * every (item, family). Call once at game setup, then registerSpriteSet +
 * loadSpriteSet with the result. The manifest's family list matches FAMILY_ORDER.
 */
export function buildKikorinSpriteSet(): SpriteSetDef {
  const sources: Record<string, CanvasImageSource> = {};
  const items: SpriteManifest["items"] = {};

  for (const item of ITEMS) {
    const sheets: Record<string, string> = {};
    for (const family of FAMILY_ORDER) {
      const frames = FAMILY_FRAMES[family];
      const key = sheetKey(item.id, family);
      sources[key] = renderSheet(item.draw, family, frames);
      sheets[family] = key;
    }
    items[item.id] = { slot: item.slot, sheets };
  }

  const families: SpriteManifest["families"] = {};
  for (const f of FAMILIES_SPEC) {
    families[f.name] = { frames: f.frames.length, fps: 10, loop: f.loop };
  }

  const manifest: SpriteManifest = {
    cell: [CELL_W, CELL_H],
    anchor: [0.5, 1.0],
    rows: 8,
    families,
    // actionMap/fallbacks are only used by the TS-derived fallback path; harmless here.
    actionMap: { "0": "idle", "1": "walk", "2": "attack" },
    fallbacks: { "*": "idle" },
    layerOrder: {
      body: 0,
      head: 2,
      weapon: [1, 1, 1, -1, -1, -1, 1, 1],
    },
    items,
  };

  return { manifest, sources };
}

/**
 * The behavior half loaded into the Rust engine, derived from FAMILIES_SPEC so
 * it always matches the art. Family index = anim_id = engine action kind
 * (idle=0, walk=1, attack=2). Timings drive the playback clock and the
 * stretch/cut fitting; the attack's FIRE event + block + move-mask are carried
 * through (ADR 0017/0018).
 */
export const KIKORIN_ANIM_DEFS: AnimationDefsInput = {
  families: FAMILIES_SPEC.map((f) => ({
    frames: f.frames.map((fr) => ({
      optimal_ms: fr.ms,
      ...(fr.event !== undefined ? { event: fr.event } : {}),
    })),
    looping: f.loop,
    ...(f.interrupt ? { interrupt: f.interrupt } : {}),
    ...(f.holdLast ? { hold_last: true } : {}),
    ...(f.retriggerable ? { retriggerable: true } : {}),
    ...(f.movement ? { movement: f.movement } : {}),
  })),
  // Action kinds map 1:1 to family indices here (idle/walk/attack).
  actions: FAMILIES_SPEC.map((_, i) => ({ kind: i, family: i })),
};

export const KIKORIN_SPRITE_SET_ID = "kikorin-placeholder";
export const PLAYER_LOADOUT = { body: "body-hero", head: "hat-hero", weapon: "sword" };
export const MONSTER_LOADOUT = { body: "body-monster" };
