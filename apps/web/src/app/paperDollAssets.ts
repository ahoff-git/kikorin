// Procedural placeholder sprite set for the top-down game. This is *game data*,
// not engine code — it lives here for the same reason KIKORIN_TOPDOWN_MAP does.
// It exists so the paper-doll pipeline has something to render without shipping
// real art: every sheet is drawn to an offscreen canvas at runtime and handed to
// @kikorin/paperdoll as an in-memory source (baseUrl is never touched).
//
// The drawings are deliberately crude but readable: an obvious facing marker per
// direction row, a leg-swing per walk frame, and a sword bar that overlaps the
// torso so the per-direction layer ordering (in front facing the camera, behind
// facing away) is visible at a glance. Swap this for real sheets under
// public/sprites/ + a JSON manifest whenever art exists.

import type { SpriteManifest, SpriteSetDef } from "@kikorin/paperdoll";

const CELL_W = 32;
const CELL_H = 48;

// Per-direction unit vector in cell pixel space (y-down). Row order is the
// engine's Direction enum: S, SW, W, NW, N, NE, E, SE. The sheet is drawn with
// flipY, so small y = screen-up = north.
const FACING: ReadonlyArray<readonly [number, number]> = [
  [0, 1], // S
  [-0.7, 0.7], // SW
  [-1, 0], // W
  [-0.7, -0.7], // NW
  [0, -1], // N
  [0.7, -0.7], // NE
  [1, 0], // E
  [0.7, 0.7], // SE
];

type CellDrawer = (ctx: CanvasRenderingContext2D, dir: number, frame: number, frames: number) => void;

interface ItemSpec {
  id: string;
  slot: string;
  draw: CellDrawer;
}

function legOffset(frame: number, frames: number): number {
  if (frames <= 1) return 0;
  // −2, 0, +2, 0 … a simple stride bob.
  return [0, -2, 0, 2][frame % 4] ?? 0;
}

function drawBody(color: string, shade: string): CellDrawer {
  return (ctx, dir, frame, frames) => {
    const cx = CELL_W / 2;
    const swing = legOffset(frame, frames);

    // Legs (swing in opposition for a walk read).
    ctx.fillStyle = shade;
    ctx.fillRect(cx - 6, 34 + swing, 4, 12 - Math.abs(swing));
    ctx.fillRect(cx + 2, 34 - swing, 4, 12 - Math.abs(swing));

    // Torso.
    ctx.fillStyle = color;
    ctx.fillRect(cx - 6, 18, 12, 16);

    // Head.
    ctx.beginPath();
    ctx.arc(cx, 12, 7, 0, Math.PI * 2);
    ctx.fill();

    // Facing marker: a nose dot pushed toward the direction of travel.
    const [fx, fy] = FACING[dir];
    ctx.fillStyle = shade;
    ctx.beginPath();
    ctx.arc(cx + fx * 5, 12 + fy * 5, 2.2, 0, Math.PI * 2);
    ctx.fill();
  };
}

function drawHat(color: string): CellDrawer {
  return (ctx, dir) => {
    const cx = CELL_W / 2;
    const [fx, fy] = FACING[dir];
    ctx.fillStyle = color;
    // A cap arc over the top of the head, nudged toward the facing side.
    ctx.beginPath();
    ctx.arc(cx + fx * 2, 9 + fy * 2, 8, Math.PI, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(cx - 9 + fx * 2, 8 + fy * 2, 18, 2);
  };
}

function drawSword(color: string): CellDrawer {
  return (ctx) => {
    // A bold bar across the torso — overlaps the body so the layer order (front
    // vs behind) reads clearly. Direction-independent on purpose.
    ctx.save();
    ctx.translate(CELL_W / 2, CELL_H / 2);
    ctx.rotate(-Math.PI / 5);
    ctx.fillStyle = color;
    ctx.fillRect(-2, -18, 4, 30);
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

const FAMILIES: Record<string, { frames: number; fps: number; loop: boolean }> = {
  idle: { frames: 1, fps: 1, loop: true },
  walk: { frames: 4, fps: 10, loop: true },
};

function sheetKey(itemId: string, family: string): string {
  return `${itemId}/${family}`;
}

function renderSheet(draw: CellDrawer, frames: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = CELL_W * frames;
  canvas.height = CELL_H * 8; // 8 direction rows
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  for (let dir = 0; dir < 8; dir += 1) {
    for (let frame = 0; frame < frames; frame += 1) {
      ctx.save();
      ctx.translate(frame * CELL_W, dir * CELL_H);
      draw(ctx, dir, frame, frames);
      ctx.restore();
    }
  }
  return canvas;
}

/**
 * Build the placeholder sprite set: a manifest plus in-memory canvas sheets for
 * every (item, family). Call once at game setup, then registerSpriteSet + await
 * loadSpriteSet with the result.
 */
export function buildKikorinSpriteSet(): SpriteSetDef {
  const sources: Record<string, CanvasImageSource> = {};
  const items: SpriteManifest["items"] = {};

  for (const item of ITEMS) {
    const sheets: Record<string, string> = {};
    for (const [family, def] of Object.entries(FAMILIES)) {
      const key = sheetKey(item.id, family);
      sources[key] = renderSheet(item.draw, def.frames);
      sheets[family] = key;
    }
    items[item.id] = { slot: item.slot, sheets };
  }

  const manifest: SpriteManifest = {
    cell: [CELL_W, CELL_H],
    anchor: [0.5, 1.0],
    rows: 8,
    families: FAMILIES,
    actionMap: { "0": "idle", "1": "walk" },
    fallbacks: { "*": "idle" },
    layerOrder: {
      body: 0,
      head: 2, // always over the body
      // In front when facing toward the camera (south-ish), behind when facing away.
      weapon: [1, 1, 1, -1, -1, -1, 1, 1],
    },
    items,
  };

  return { manifest, sources };
}

export const KIKORIN_SPRITE_SET_ID = "kikorin-placeholder";
export const PLAYER_LOADOUT = { body: "body-hero", head: "hat-hero", weapon: "sword" };
export const MONSTER_LOADOUT = { body: "body-monster" };
