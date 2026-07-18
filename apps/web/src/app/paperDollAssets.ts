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

import type { AnimationDefsInput } from "@kikorin/adapter";
import type { SpriteManifest, SpriteSetDef } from "@kikorin/paperdoll";

const CELL_W = 32;
const CELL_H = 48;

/** Family names in engine `anim_id` order — the bridge between Rust and the art. */
export const FAMILY_ORDER = ["idle", "walk", "attack"] as const;

/** Frame counts must match KIKORIN_ANIM_DEFS below (sheet columns = family frames). */
const FAMILY_FRAMES: Record<string, number> = { idle: 2, walk: 4, attack: 5 };

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

function drawBody(color: string, shade: string): CellDrawer {
  return (ctx, family, dir, frame, frames) => {
    const [fx, fy] = FACING[dir];
    let swing = 0;
    let bob = 0;
    let lunge = 0;
    if (family === "walk") swing = walkSwing(frame, frames);
    else if (family === "idle") bob = frame % 2 === 0 ? 0 : 1;
    else if (family === "attack") lunge = Math.sin(progress(frame, frames) * Math.PI) * 5;

    const cx = CELL_W / 2 + fx * lunge;
    const topShift = bob + fy * lunge * 0.5;

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
  return (ctx, _family, dir) => {
    const cx = CELL_W / 2;
    const [fx, fy] = FACING[dir];
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(cx + fx * 2, 9 + fy * 2, 8, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(cx - 9 + fx * 2, 8 + fy * 2, 18, 2);
  };
}

function drawSword(color: string): CellDrawer {
  return (ctx, family, _dir, frame, frames) => {
    ctx.save();
    ctx.translate(CELL_W / 2, CELL_H / 2);
    // Attack sweeps the blade through an arc (wind-up → strike → recover); other
    // families rest it at the side. The swing is what makes the attack read.
    const angle = family === "attack" ? -2.2 + progress(frame, frames) * 3.8 : -Math.PI / 5;
    ctx.rotate(angle);
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
  for (const family of FAMILY_ORDER) {
    families[family] = { frames: FAMILY_FRAMES[family], fps: 10, loop: family !== "attack" };
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
 * The behavior half loaded into the Rust engine (family index = anim_id =
 * FAMILY_ORDER index). idle/walk loop; attack is a one-shot that BLOCKS (plays
 * fully, ignoring movement) so the swing is always seen. Timings drive the
 * playback clock and the stretch/cut fitting in Rust.
 */
export const KIKORIN_ANIM_DEFS: AnimationDefsInput = {
  families: [
    // 0: idle
    { frames: [{ optimal_ms: 450 }, { optimal_ms: 450 }], looping: true },
    // 1: walk
    {
      frames: [
        { optimal_ms: 110 },
        { optimal_ms: 110 },
        { optimal_ms: 110 },
        { optimal_ms: 110 },
      ],
      looping: true,
    },
    // 2: attack — one-shot, blocking; the strike frame (3) is a little longer
    // and carries event 1 (FIRE): the engine spawns the player's bullet exactly
    // when the swing connects, regardless of how the attack is timed (ADR 0017).
    {
      frames: [
        { optimal_ms: 60 },
        { optimal_ms: 50 },
        { optimal_ms: 60 },
        { optimal_ms: 120, event: 1 },
        { optimal_ms: 140 },
      ],
      looping: false,
      interrupt: "block",
    },
  ],
  actions: [
    { kind: 0, family: 0 },
    { kind: 1, family: 1 },
    { kind: 2, family: 2 },
  ],
};

export const KIKORIN_SPRITE_SET_ID = "kikorin-placeholder";
export const PLAYER_LOADOUT = { body: "body-hero", head: "hat-hero", weapon: "sword" };
export const MONSTER_LOADOUT = { body: "body-monster" };
