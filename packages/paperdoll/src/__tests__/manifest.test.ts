import { describe, it, expect } from "vitest";
import {
  familyForAction,
  resolveFamilyFallback,
  registerSpriteSet,
  getSpriteSet,
  clearSpriteSets,
  type SpriteManifest,
} from "../manifest";

function baseManifest(overrides: Partial<SpriteManifest> = {}): SpriteManifest {
  return {
    cell: [16, 16],
    anchor: [0.5, 1.0],
    families: {
      idle: { frames: 1, fps: 1, loop: true },
      walk: { frames: 4, fps: 10, loop: true },
      "attack.slash": { frames: 3, fps: 12, loop: false, next: "idle" },
    },
    actionMap: { "0": "idle", "1": "walk", "2.0": "attack.slash" },
    fallbacks: { "attack.thrust": "attack.slash", "*": "idle" },
    layerOrder: { body: 0 },
    items: { hero: { slot: "body", sheets: { idle: "hero/idle", walk: "hero/walk" } } },
    ...overrides,
  };
}

describe("familyForAction", () => {
  const m = baseManifest();

  it("maps a bare kind", () => {
    expect(familyForAction(m, 1)).toBe("walk");
  });

  it("prefers a kind.variant mapping over the bare kind", () => {
    expect(familyForAction(m, 2, 0)).toBe("attack.slash");
  });

  it("falls back when the mapped family is absent", () => {
    // kind 9 has no actionMap entry -> "*" fallback -> idle
    expect(familyForAction(m, 9)).toBe("idle");
  });
});

describe("resolveFamilyFallback", () => {
  const m = baseManifest();

  it("returns the family when it exists", () => {
    expect(resolveFamilyFallback(m, "walk")).toBe("walk");
  });

  it("walks a named fallback to an existing family", () => {
    // attack.thrust isn't defined; fallbacks route it to attack.slash which is.
    expect(resolveFamilyFallback(m, "attack.thrust")).toBe("attack.slash");
  });

  it("terminates at idle", () => {
    expect(resolveFamilyFallback(m, "does-not-exist")).toBe("idle");
  });
});

describe("registerSpriteSet validation", () => {
  it("rejects a bad cell size", () => {
    clearSpriteSets();
    expect(() => registerSpriteSet("x", { manifest: baseManifest({ cell: [0, 16] }) })).toThrow();
  });

  it("rejects a per-direction layer array of the wrong length", () => {
    clearSpriteSets();
    expect(() =>
      registerSpriteSet("x", { manifest: baseManifest({ layerOrder: { body: [0, 1] } }) }),
    ).toThrow();
  });

  it("round-trips a valid set", () => {
    clearSpriteSets();
    registerSpriteSet("hero-set", { manifest: baseManifest(), baseUrl: "/sprites/hero/" });
    expect(getSpriteSet("hero-set").baseUrl).toBe("/sprites/hero/");
  });
});
