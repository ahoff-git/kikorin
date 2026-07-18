import { describe, it, expect } from "vitest";
import {
  frameAt,
  loadoutKey,
  resolveEquipment,
  resolveLayering,
  sheetRowForDirection,
} from "../resolvers";
import type { SpriteManifest } from "../manifest";

const manifest: SpriteManifest = {
  cell: [16, 16],
  anchor: [0.5, 1.0],
  families: { idle: { frames: 1, fps: 1, loop: true }, walk: { frames: 4, fps: 10, loop: true } },
  actionMap: { "0": "idle", "1": "walk" },
  layerOrder: {
    body: 0,
    // In front (z 1) facing the camera-ish rows, behind (z -1) facing away.
    weapon: [1, 1, 1, 1, -1, -1, -1, 1],
  },
  items: {
    hero: { slot: "body", sheets: { idle: "hero/idle", walk: "hero/walk" } },
    sword: { slot: "weapon", sheets: { idle: "sword/idle", walk: "sword/walk" } },
  },
};

describe("frameAt", () => {
  it("wraps a looping family", () => {
    const walk = manifest.families.walk;
    expect(frameAt(walk, 0)).toEqual({ frame: 0, done: false });
    expect(frameAt(walk, 100)).toEqual({ frame: 1, done: false });
    expect(frameAt(walk, 500)).toEqual({ frame: 1, done: false }); // 5 % 4
  });

  it("clamps a one-shot family and reports done on the last frame", () => {
    const shot = { frames: 3, fps: 10, loop: false };
    expect(frameAt(shot, 0)).toEqual({ frame: 0, done: false });
    expect(frameAt(shot, 100)).toEqual({ frame: 1, done: false });
    expect(frameAt(shot, 200)).toEqual({ frame: 2, done: true });
    expect(frameAt(shot, 9999)).toEqual({ frame: 2, done: true });
  });
});

describe("loadoutKey", () => {
  it("is independent of key order", () => {
    expect(loadoutKey({ body: "hero", weapon: "sword" })).toBe(
      loadoutKey({ weapon: "sword", body: "hero" }),
    );
  });

  it("distinguishes different loadouts", () => {
    expect(loadoutKey({ body: "hero" })).not.toBe(loadoutKey({ body: "villain" }));
  });
});

describe("resolveEquipment", () => {
  it("drops items not present in the manifest", () => {
    const layers = resolveEquipment(manifest, { body: "hero", weapon: "ghost-blade" });
    expect(layers.map((l) => l.itemId)).toEqual(["hero"]);
  });
});

describe("resolveLayering", () => {
  it("orders the weapon in front when facing south", () => {
    const layers = resolveEquipment(manifest, { body: "hero", weapon: "sword" });
    const passes = resolveLayering(manifest, layers, 0 /* S */, "walk");
    expect(passes.map((p) => p.slot)).toEqual(["body", "weapon"]);
    expect(passes.map((p) => p.sheetKey)).toEqual(["hero/walk", "sword/walk"]);
  });

  it("orders the weapon behind the body when facing north", () => {
    const layers = resolveEquipment(manifest, { body: "hero", weapon: "sword" });
    const passes = resolveLayering(manifest, layers, 4 /* N */, "walk");
    expect(passes.map((p) => p.slot)).toEqual(["weapon", "body"]);
  });

  it("marks a missing family sheet as null rather than dropping the layer", () => {
    const layers = resolveEquipment(manifest, { body: "hero" });
    const passes = resolveLayering(manifest, layers, 0, "attack.slash");
    expect(passes).toHaveLength(1);
    expect(passes[0].sheetKey).toBeNull();
  });
});

describe("sheetRowForDirection", () => {
  it("is identity on an 8-row sheet", () => {
    for (let d = 0; d < 8; d += 1) expect(sheetRowForDirection(d as never, 8)).toBe(d);
  });

  it("collapses diagonals to the preceding cardinal on a 4-row sheet", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((d) => sheetRowForDirection(d as never, 4))).toEqual([
      0, 0, 1, 1, 2, 2, 3, 3,
    ]);
  });
});
