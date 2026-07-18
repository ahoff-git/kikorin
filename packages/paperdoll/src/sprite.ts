// The render-facing handle: a Three.js Sprite the game registers per entity,
// plus the per-frame update that turns "where is this entity facing / what is it
// doing" into the right sheet cell.
//
// Why THREE.Sprite: a Sprite always points at the camera — Three's built-in
// billboard. Under the top-down straight-down camera that reads as the sprite
// lying flat on the ground facing up; under a perspective camera the same Sprite
// stands upright facing the viewer (Doom-style). One primitive, both modes, and
// it ignores the yaw the render channel writes onto the object each tick instead
// of fighting it. We read that yaw only to choose a direction row (the entity's
// "front"), and step frames with texture.offset — the Three.js-native
// sprite-sheet technique.

import { Sprite, SpriteMaterial, Vector3, type Camera, type Object3D } from "three";
import { log, logLevels } from "@kikorin/util";
import {
  DIRECTION_COUNT,
  directionFromYaw,
  directionFromYawRelativeToCamera,
  type Direction,
} from "./direction";
import { familyForAction, getSpriteSet, type SpriteManifest } from "./manifest";
import { getSheet } from "./bakeCache";
import {
  frameAt,
  loadoutKey as computeLoadoutKey,
  resolveEquipment,
  resolveLayering,
  type Loadout,
} from "./resolvers";

/** Discrete action the game asserts (e.g. from Rust semantic patches). */
export interface ActionInput {
  /** Engine action kind (0 idle, 1 walk, 2 attack, ...) — maps via the manifest actionMap. */
  kind: number;
  /** Sub-selects within a kind (attack pattern); manifest actionMap key "kind.variant". */
  variant?: number;
  /** Increment to restart a one-shot animation; equal seq never restarts. */
  seq?: number;
}

/**
 * Selects how facing maps to the sheet — orientation is always Three's billboard
 * (the Sprite points at the camera). "flat" (top-down): row = entity yaw.
 * "billboard" (3d perspective): row = yaw relative to the camera azimuth.
 * "sidescroll" (2d side view): a fixed side-profile row, mirrored left/right by
 * horizontal movement (a side-scroller has no yaw — facing is a flip).
 */
export type SpriteMode = "flat" | "billboard" | "sidescroll";

// The side-profile row shown in sidescroll mode (East faces screen-right; a
// negative scale.x mirrors it to face left).
const SIDESCROLL_ROW = 6;
const SIDESCROLL_MOVE_EPS = 1e-4;

export interface CreateSpriteOptions {
  setId: string;
  loadout: Loadout;
  /** World-space height of the sprite; width follows the cell aspect ratio. */
  worldHeight: number;
  mode?: SpriteMode;
  /**
   * Rust-driven mode (ADR 0015): family names indexed by the engine's `anim_id`,
   * matching the order passed to `load_animations`. When set, the sprite displays
   * whatever cell `setCell` is fed each tick and ignores the TS-derived clock;
   * omit it to keep the standalone TS-derived behavior (auto idle/walk).
   */
  animFamilies?: string[];
}

export interface PaperDollSprite {
  /** Register this via upsertObjectByEid(eid, () => sprite.object). */
  readonly object: Object3D;
  /** Swap equipment — rebakes to a new look on the next update. */
  setLoadout(loadout: Loadout): void;
  /** Assert a discrete action; pass null to resume auto-derived idle/walk (TS-derived mode only). */
  setAction(action: ActionInput | null): void;
  /**
   * Display the engine-resolved cell (Rust-driven mode). `animId` indexes
   * `animFamilies`. Feed this from the animation fields on SemanticPatch.
   */
  setCell(animId: number, frame: number, dir: number): void;
  /** Advance the animation and pick the sheet cell. Call once per frame before rendering. */
  update(nowMs: number, camera?: Camera): void;
  dispose(): void;
}

// Squared world distance the object must move between frames to read as "walking".
const MOVE_EPS_SQ = 1e-6;

export function createPaperDollSprite(opts: CreateSpriteOptions): PaperDollSprite {
  const { manifest } = getSpriteSet(opts.setId);
  const [cellW, cellH] = manifest.cell;
  const aspect = cellW / cellH;
  const mode: SpriteMode = opts.mode ?? "flat";
  const w = opts.worldHeight * aspect;

  const material = new SpriteMaterial({ transparent: true, alphaTest: 0.5 });
  const sprite = new Sprite(material);
  sprite.scale.set(w, opts.worldHeight, 1);
  // .center is (0,0)=bottom-left. Flat top-down reads best centered on the
  // entity; an upright billboard reads best pinned at the feet (manifest anchor,
  // whose y is measured from the top — hence 1 - anchorY).
  if (mode === "billboard") sprite.center.set(manifest.anchor[0], 1 - manifest.anchor[1]);
  else sprite.center.set(0.5, 0.5);

  let loadout = opts.loadout;
  let loadoutKeyStr = computeLoadoutKey(loadout);

  // sidescroll flip state: face the way we're moving; hold facing when still.
  let sideFacing = 1;
  let lastSideX = NaN;

  const animFamilies = opts.animFamilies;
  // In Rust-driven mode this holds the latest engine-emitted cell; seeded to the
  // first family so the sprite shows something before the first setCell.
  let rustCell: { family: string; frame: number; dir: number } | null = animFamilies
    ? { family: animFamilies[0] ?? "idle", frame: 0, dir: 0 }
    : null;

  let explicit: ActionInput | null = null;
  let curFamily = "";
  let curSeq: number | undefined;
  let clockOrigin = 0;

  let builtLook = "";
  let builtFrames = 1;

  const lastPos = new Vector3(NaN, NaN, NaN);

  function setLoadout(next: Loadout): void {
    loadout = next;
    loadoutKeyStr = computeLoadoutKey(next);
    // builtLook keys on loadout, so the next update rebakes/rebinds automatically.
  }

  function setAction(action: ActionInput | null): void {
    explicit = action;
  }

  function currentKind(): { kind: number; variant?: number } {
    if (explicit) return { kind: explicit.kind, variant: explicit.variant };
    const moving =
      Number.isFinite(lastPos.x) && sprite.position.distanceToSquared(lastPos) > MOVE_EPS_SQ;
    return { kind: moving ? 1 : 0 };
  }

  function directionFor(yaw: number, camera: Camera | undefined): Direction {
    if (mode === "billboard" && camera) {
      const az = Math.atan2(camera.position.x - sprite.position.x, camera.position.z - sprite.position.z);
      return directionFromYawRelativeToCamera(yaw, az);
    }
    return directionFromYaw(yaw);
  }

  function bindLook(family: string, frames: number): void {
    const sheet = getSheet(opts.setId, loadoutKeyStr, family, frames, (d) =>
      resolveLayering(manifest, resolveEquipment(manifest, loadout), d, family),
    );
    // Clone shares the baked Source (one GPU upload) but carries an independent
    // offset/repeat, so many sprites animate different cells of the same sheet.
    const tex = sheet.texture.clone();
    tex.needsUpdate = true;
    tex.repeat.set(1 / sheet.frames, 1 / sheet.rows);
    material.map = tex;
    material.needsUpdate = true;
    builtFrames = sheet.frames;
  }

  // Rebind the baked sheet on a look change, then point the UVs at (frame, dir).
  // Row 0 (S) sits at the sheet's top; a CanvasTexture is flipY, so the top row
  // lives at the high-v end — hence (rows-1-dir).
  function applyCell(family: string, frame: number, dir: number): void {
    const familyDef = manifest.families[family] ?? manifest.families["idle"];
    const look = `${loadoutKeyStr}|${family}`;
    if (look !== builtLook) {
      bindLook(family, familyDef?.frames ?? 1);
      builtLook = look;
    }
    const f = Math.max(0, Math.min(frame, builtFrames - 1));
    material.map!.offset.set(f / builtFrames, (DIRECTION_COUNT - 1 - dir) / DIRECTION_COUNT);
  }

  function setCell(animId: number, frame: number, dir: number): void {
    if (!animFamilies) return;
    rustCell = { family: animFamilies[animId] ?? animFamilies[0] ?? "idle", frame, dir };
  }

  function update(nowMs: number, camera?: Camera): void {
    // Rust-driven (ADR 0015): use the engine's family + frame. Direction: flat
    // (fixed-camera) modes use the row Rust resolved; billboard (3D) recomputes
    // it camera-relative from the render yaw, since the viewing angle is a TS
    // camera Rust can't know.
    if (rustCell) {
      let dir: number;
      if (mode === "billboard" && camera) {
        dir = directionFor(sprite.rotation.y, camera);
      } else if (mode === "sidescroll") {
        // Fixed side profile; mirror it by horizontal movement (2D has no yaw).
        const x = sprite.position.x;
        if (Number.isFinite(lastSideX)) {
          if (x - lastSideX > SIDESCROLL_MOVE_EPS) sideFacing = 1;
          else if (x - lastSideX < -SIDESCROLL_MOVE_EPS) sideFacing = -1;
        }
        lastSideX = x;
        sprite.scale.x = sideFacing * w;
        dir = SIDESCROLL_ROW;
      } else {
        dir = rustCell.dir;
      }
      applyCell(rustCell.family, rustCell.frame, dir);
      return;
    }

    // TS-derived fallback (no animation set loaded): resolve family/frame here.
    const yaw = sprite.rotation.y;
    const { kind, variant } = currentKind();
    let family = familyForAction(manifest, kind, variant);
    const seq = explicit?.seq;
    if (family !== curFamily || (explicit && seq !== curSeq)) {
      curFamily = family;
      curSeq = seq;
      clockOrigin = nowMs;
    }
    let familyDef = manifest.families[family];
    let { frame, done } = frameAt(familyDef, nowMs - clockOrigin);
    if (done && !familyDef.loop) {
      if (familyDef.holdLast) {
        // stay on the final frame
      } else if (familyDef.next) {
        curFamily = family = familyDef.next;
        clockOrigin = nowMs;
        familyDef = manifest.families[family] ?? familyDef;
        ({ frame } = frameAt(familyDef, 0));
      } else {
        explicit = null;
      }
    }
    applyCell(curFamily, frame, directionFor(yaw, camera));
    lastPos.copy(sprite.position);
  }

  function dispose(): void {
    // Don't dispose material.map: it's a clone sharing the cache's Source, which
    // the cache owns. Material.dispose leaves attached textures alone.
    material.dispose();
  }

  if (!manifest.families["idle"]) {
    log(logLevels.warning, `paperdoll: set "${opts.setId}" has no "idle" family`, ["paperdoll"]);
  }

  return { object: sprite, setLoadout, setAction, setCell, update, dispose };
}

// Re-exported so a consumer can pre-warm/validate a set's manifest if it wants.
export type { SpriteManifest };
