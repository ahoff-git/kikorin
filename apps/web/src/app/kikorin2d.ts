import {
  lifecycleChannel,
  netChannel,
  hudChannel,
  NET_BULLET,
  NET_LOCAL,
  NET_MONSTER,
  NET_REPLICATED,
  NET_PREDICTABLE,
} from "@kikorin/adapter";
import type { WorkerEngineProxy } from "../workers/WorkerEngineProxy";
import {
  upsertObjectByEid,
  applyToObjectByEid,
  removeObjectByEid,
  setCameraPosition,
  lookCameraAt,
} from "@kikorin/system-rendering";
import {
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  type Object3D,
} from "three";
import { KIKORIN_2D_MAP, BLOCK_Z_HALF_DEPTH } from "./kikorin2dMap";
import { makeEdgedBox, makePersonMesh } from "./meshFactories";
import { createHeldKeysTracker, suppressContextMenu } from "./inputHelpers";
import type { OwnershipCallbacks } from "./useNetworking";

// This file is UI + IO only, mirroring kikorin.ts's split for the 3D game —
// it does NOT use the engine's player controller (register_player only
// registers the player for closest_player_position's benefit here;
// set_player_input is never called, and tick_player_controller is a no-op
// for a 2D engine — see specs/engine/README.md's "Physics Dimension"
// section). Player movement/shooting stay plain TypeScript, driving the
// engine through dimension-agnostic primitives: spawn_box_entity,
// spawn_bullet, spawn_floor_entity, set_entity_velocity, destroy_entity.
// Monster AI, pathfinding, and bullet-vs-monster hit detection are NOT
// reimplemented here — they run in Rust exactly as they do for the 3D game
// (tick_monster_ai/tick_bullets), because that logic already degenerates
// correctly for 2D as long as every 2D entity's Z stays 0 (see the engine
// spec's "Monster AI in 2D" section for why). Monsters just need
// NET_MONSTER set to be picked up by it.

const PLAYER_HALF_W = 0.4;
const PLAYER_HALF_H = 0.6;
const PLAYER_HALF_D = 0.3;
const PLAYER_HEALTH = 100;
const MOVE_SPEED = 6.0;
const JUMP_IMPULSE_VY = 9.0;
const MAX_JUMPS = 2;

const INITIAL_MONSTER_COUNT = 6;

const BULLET_SPEED = 14.0;
const BULLET_UP_ARC = 2.0;
const BULLET_MUZZLE_OFFSET = 0.6;

const MONSTER_HALF = 0.4;
const MONSTER_HEALTH = 30;
const MONSTER_SPAWN_Y = 4.0;
const MONSTER_SPAWN_X_SPREAD = 9.0;
// Monsters currently get only one jump per waypoint trigger — MonsterState
// (crates/engine/src/lib.rs) has no multi-jump budget the way PlayerState
// does (see specs/engine/README.md's PlayerConfig.max_jumps note), so the navmesh
// must be built assuming single-jump reach even though the player can
// double-jump. Monsters will route around anything that needs a second
// jump rather than get stuck mid-air attempting it. Giving monsters a real
// jump budget is a natural follow-up, not done here.
const MONSTER_MAX_JUMPS = 1;

const CAM_Y_OFFSET = 1.0;
const CAM_Z = 5.0;

function makeFlatBox(hw: number, hh: number, color: number, edgeColor: number): Object3D {
  return makeEdgedBox(hw, hh, BLOCK_Z_HALF_DEPTH, color, edgeColor);
}

function makePersonMeshFor(bodyColor: number, frontColor: number): Object3D {
  return makePersonMesh(PLAYER_HALF_W, PLAYER_HALF_H, PLAYER_HALF_D, bodyColor, frontColor);
}

const PROJ_GEO = new SphereGeometry(0.15, 10, 8);
const PROJ_MAT = new MeshBasicMaterial({ color: 0xf97316 });
function makeProjectileMesh(): Object3D {
  return new Mesh(PROJ_GEO, PROJ_MAT);
}

export type SetupGame2DResult = {
  playerEid: number;
  ownedEids: number[];
  onRemoteEntityHit: (eid: number) => void;
  spawnMonsters: (count: number) => void;
  onFrame: () => void;
  cleanup: () => void;
};

export async function setupGame2D(
  engine: WorkerEngineProxy,
  ownership: OwnershipCallbacks,
  _canvas?: HTMLCanvasElement,
): Promise<SetupGame2DResult> {
  // --- Terrain: spawned directly (no load_map — this game has no single
  // "load the map" call), but does build a 2D navmesh over the resulting
  // geometry once every block is down (see build_navmesh_2d below). ---
  for (const b of KIKORIN_2D_MAP) {
    const eid = await engine.spawn_floor_entity(b.x, b.y, 0, b.hw, b.hh, BLOCK_Z_HALF_DEPTH);
    if (b.walkable === false) engine.set_terrain_walkable(eid, false);
    const obj = upsertObjectByEid(eid, () => makeFlatBox(b.hw, b.hh, 0x445342, 0x243022));
    obj.position.set(b.x, b.y, 0);
  }
  // Capability describes whoever will actually traverse the mesh — monsters
  // (the player never queries it; movement there is direct input, not
  // pathfinding) — so this must match set_ai_config below, not the player's
  // own (higher) jump budget.
  await engine.build_navmesh_2d(MOVE_SPEED, JUMP_IMPULSE_VY, MONSTER_MAX_JUMPS);
  // Monster AI tuning: walk/jump speed must match the capability the
  // navmesh above was built for. The rest of AiConfig's defaults (waypoint
  // reach, replan timing, stuck detection, separation radius) are tuned for
  // 3D's world scale but close enough in magnitude to 2D's that they're left
  // as-is for now — revisit after playtesting if monsters feel off.
  engine.set_ai_config({ walk_speed: MOVE_SPEED, jump_speed: JUMP_IMPULSE_VY });
  // respawn:false — respawn_monster() (crates/engine/src/lib.rs) places the
  // replacement on a 3D ring, which would write a nonzero Z into a 2D
  // entity and break the Z=0 invariant every other monster-AI/hit-detection
  // calculation relies on (see specs/engine/README.md). A 2D-aware respawn is a
  // natural follow-up, not done here.
  engine.set_monster_config({ respawn: false });

  // --- Player ---
  const playerEid = await engine.spawn_box_entity(
    0, 3, 0, PLAYER_HALF_W, PLAYER_HALF_H, PLAYER_HALF_D, PLAYER_HEALTH, NET_LOCAL | NET_REPLICATED,
  );
  upsertObjectByEid(playerEid, () => makePersonMeshFor(0x4488cc, 0xffe082));
  // Registers the player for closest_player_position's benefit only —
  // tick_player_controller is a no-op for a 2D engine (see module doc
  // above), so this never fights the manual set_entity_velocity calls below.
  engine.register_player(playerEid);
  ownership.addOwnedEntity(playerEid);
  const ownedEids: number[] = [playerEid];

  // --- Bullets: mesh lifecycle only. Hit detection, damage, death, and TTL/
  // kill-plane cleanup are all handled by the engine's existing tick_bullets
  // pipeline (works for NET_MONSTER entities regardless of dimension). ---
  const unsubLifecycle = lifecycleChannel.subscribe(() => {
    for (const l of lifecycleChannel.getSnapshot()) {
      if (l.kind === "spawned") {
        if (l.entity === playerEid) continue; // already created above
        if (l.flags & NET_BULLET) {
          upsertObjectByEid(l.entity, () => makeProjectileMesh());
        }
      } else {
        removeObjectByEid(l.entity, { dispose: true });
      }
    }
  });

  // --- Remote peers' mirrors ---
  const unsubNet = netChannel.subscribe(() => {
    for (const p of netChannel.getSnapshot()) {
      if (p.kind === "spawned") {
        const flags = p.flags ?? 0;
        upsertObjectByEid(p.entity, () => {
          if (flags & NET_BULLET) return makeProjectileMesh();
          if (flags & NET_MONSTER) return makePersonMeshFor(0x8e4444, 0xd88a8a);
          return makePersonMeshFor(0x9c27b0, 0xe1bee7);
        });
      } else if (p.kind === "despawned") {
        removeObjectByEid(p.entity, { dispose: true });
      }
    }
  });

  // --- Grounded tracking, for the player's own jump edge-detection (no
  // built-in player controller here, so this game does its own for the
  // player — see the module doc above). Monsters don't need this in TS
  // anymore: tick_monster_ai reads is_grounded internally. ---
  let playerGrounded = false;
  const unsubHud = hudChannel.subscribe(() => {
    for (const s of hudChannel.getSnapshot()) {
      if (s.entity === playerEid && s.grounded !== undefined) playerGrounded = s.grounded;
    }
  });

  // --- Monsters: NET_MONSTER so the engine's own tick_monster_ai (movement/
  // pathfinding) and tick_bullets (hit detection/damage/death) pick them up
  // — see the module doc above for why that already works correctly for a
  // 2D entity without any 2D-specific code on the Rust side. ---
  async function spawnMonsters(count: number) {
    for (let i = 0; i < count; i++) {
      const x = (Math.random() - 0.5) * 2 * MONSTER_SPAWN_X_SPREAD;
      const eid = await engine.spawn_box_entity(
        x, MONSTER_SPAWN_Y, 0, MONSTER_HALF, MONSTER_HALF, MONSTER_HALF, MONSTER_HEALTH,
        NET_LOCAL | NET_MONSTER | NET_REPLICATED,
      );
      upsertObjectByEid(eid, () => makePersonMeshFor(0xcc4444, 0xff8800));
    }
  }

  // --- Raw input ---
  const { heldKeys, disconnect: disconnectHeldKeys } = createHeldKeysTracker();
  const stopSuppressingContextMenu = suppressContextMenu(document);

  let facing: 1 | -1 = 1;

  function fire() {
    applyToObjectByEid(playerEid, (obj) => {
      const vx = facing * BULLET_SPEED;
      void engine.spawn_bullet(
        obj.position.x + facing * BULLET_MUZZLE_OFFSET,
        obj.position.y,
        0,
        vx,
        BULLET_UP_ARC,
        0,
        NET_REPLICATED | NET_PREDICTABLE,
      );
    });
  }

  function onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    fire();
  }
  window.addEventListener("mousedown", onMouseDown);

  let prevJumpHeld = false;
  let jumpsUsed = 0;

  function onFrame() {
    const left = heldKeys.has("KeyA") || heldKeys.has("ArrowLeft");
    const right = heldKeys.has("KeyD") || heldKeys.has("ArrowRight");
    const jumpHeld = heldKeys.has("Space");

    let vx = 0;
    if (left && !right) { vx = -MOVE_SPEED; facing = -1; }
    else if (right && !left) { vx = MOVE_SPEED; facing = 1; }

    // Landing refills the jump budget; edge-detected so holding Space through
    // a landing doesn't re-trigger. Airborne presses spend the budget instead
    // of being gated on `grounded`, which is what gives the second jump.
    if (playerGrounded) jumpsUsed = 0;
    const jumpEdge = jumpHeld && !prevJumpHeld && jumpsUsed < MAX_JUMPS;
    prevJumpHeld = jumpHeld;
    if (jumpEdge) jumpsUsed++;

    engine.set_entity_velocity(playerEid, vx, jumpEdge ? JUMP_IMPULSE_VY : 0, 0);

    applyToObjectByEid(playerEid, (obj) => {
      // Mirror facing onto the sprite so it's visually obvious which way the
      // player is aiming (no separate rotation channel needed for this).
      obj.scale.x = facing;
      setCameraPosition(obj.position.x, obj.position.y + CAM_Y_OFFSET, CAM_Z);
      lookCameraAt(obj.position.x, obj.position.y + CAM_Y_OFFSET, 0);
    });

    // Monster movement, pathfinding, and bullet-vs-monster hit detection all
    // run in Rust now (tick_monster_ai / tick_bullets) — nothing to drive
    // here per frame.
  }

  function onRemoteEntityHit(_eid: number) {}

  await spawnMonsters(INITIAL_MONSTER_COUNT);

  function cleanup() {
    disconnectHeldKeys();
    window.removeEventListener("mousedown", onMouseDown);
    stopSuppressingContextMenu();
    unsubLifecycle();
    unsubNet();
    unsubHud();
  }

  return { playerEid, ownedEids, onRemoteEntityHit, spawnMonsters, onFrame, cleanup };
}
