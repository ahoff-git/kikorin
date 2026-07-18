// Shared paper-doll wiring for every sample game (game data / glue, not engine).
// Each game differs only in render mode and which entities are sprites, so the
// registration, animation loading, per-entity sprite lifecycle, the
// SemanticPatch → setCell feed, and the per-frame update all live here once.
//
// The engine owns the animation simulation (ADR 0015); this just creates the
// Three.js sprites, hands them the cell the engine emits, and disposes them.

import { hudChannel } from "@kikorin/adapter";
import type { Loadout, SpriteMode, PaperDollSprite } from "@kikorin/paperdoll";
import {
  registerSpriteSet,
  loadSpriteSet,
  createPaperDollSprite,
} from "@kikorin/paperdoll";
import { upsertObjectByEid, removeObjectByEid } from "@kikorin/system-rendering";
import { type Camera } from "three";
import type { WorkerEngineProxy } from "../workers/WorkerEngineProxy";
import {
  buildKikorinSpriteSet,
  KIKORIN_ANIM_DEFS,
  FAMILY_ORDER,
  KIKORIN_SPRITE_SET_ID,
} from "./paperDollAssets";

export interface SpriteDirector {
  /** Create a sprite for an entity and register its object for render patches. */
  add(eid: number, loadout: Loadout, worldHeight: number): void;
  /** Tear a sprite down (detach + dispose); safe for unknown eids. */
  remove(eid: number): void;
  /** Advance every sprite (call once per frame before renderFrame). */
  update(nowMs: number): void;
  dispose(): void;
}

export interface SpriteDirectorOptions {
  mode: SpriteMode;
  /** Billboard mode needs the active camera each frame for camera-relative facing. */
  getCamera?: () => Camera | null | undefined;
}

/**
 * Register the shared sprite set, load its sheets, load the animation defs into
 * the engine, and return a director that manages per-entity sprites and feeds
 * them the engine-resolved cell. Await before creating sprites.
 */
export async function createSpriteDirector(
  engine: WorkerEngineProxy,
  opts: SpriteDirectorOptions,
): Promise<SpriteDirector> {
  registerSpriteSet(KIKORIN_SPRITE_SET_ID, buildKikorinSpriteSet());
  await loadSpriteSet(KIKORIN_SPRITE_SET_ID);
  // Behavior half: the engine drives family/frame/direction each tick.
  engine.load_animations(KIKORIN_ANIM_DEFS);
  const animFamilies = [...FAMILY_ORDER];

  const sprites = new Map<number, PaperDollSprite>();

  // The engine emits the resolved cell on SemanticPatch; hand it to the sprite.
  const unsubHud = hudChannel.subscribe(() => {
    for (const s of hudChannel.getSnapshot()) {
      if (s.anim_id === undefined) continue;
      sprites.get(s.entity)?.setCell(s.anim_id, s.anim_frame ?? 0, s.anim_dir ?? 0);
    }
  });

  return {
    add(eid, loadout, worldHeight) {
      const sprite = createPaperDollSprite({
        setId: KIKORIN_SPRITE_SET_ID,
        loadout,
        worldHeight,
        mode: opts.mode,
        animFamilies,
      });
      upsertObjectByEid(eid, () => sprite.object);
      sprites.set(eid, sprite);
    },
    remove(eid) {
      const sprite = sprites.get(eid);
      if (!sprite) return;
      sprites.delete(eid);
      removeObjectByEid(eid); // detach; the sprite owns geometry/material disposal
      sprite.dispose();
    },
    update(nowMs) {
      const camera = opts.getCamera?.() ?? undefined;
      for (const sprite of sprites.values()) sprite.update(nowMs, camera);
    },
    dispose() {
      unsubHud();
      for (const sprite of sprites.values()) sprite.dispose();
      sprites.clear();
    },
  };
}
