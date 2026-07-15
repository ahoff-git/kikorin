import {
  lifecycleChannel,
  netChannel,
  NET_BULLET,
  NET_LOCAL,
  NET_MONSTER,
  NET_REPLICATED,
} from "@kikorin/adapter";
import type { WorkerEngineProxy } from "../workers/WorkerEngineProxy";
import { KIKORIN_TOPDOWN_MAP } from "./kikorinTopDownMap";
import {
  upsertObjectByEid,
  applyToObjectByEid,
  removeObjectByEid,
  setCameraPosition,
  setCameraUp,
  lookCameraAt,
} from "@kikorin/system-rendering";
import { Mesh, MeshBasicMaterial, SphereGeometry, type Object3D } from "three";
import { recordE2EEntitySpawn } from "./e2eMetrics";
import { makeEdgedBox, makePersonMesh } from "./meshFactories";
import { createHeldKeysTracker, suppressContextMenu } from "./inputHelpers";
import type { OwnershipCallbacks } from "./useNetworking";

// This file is UI + IO only, mirroring kikorin.ts's split for the 3D game —
// and reuses that game's Rust pipeline entirely unmodified (player
// controller, monster AI, pathfinding, bullets). What makes this a top-down,
// no-jump "pacman style" game instead is three setup-time choices, none of
// them new Rust code:
//   - gravity: 0 (see useEngine's gravity param) — nothing falls, so bullets
//     fly straight and entities must spawn at their exact resting height
//     rather than "above and let it settle" the way the 3D game does.
//   - a perfectly flat map (kikorinTopDownMap.ts) — every floor tile is the
//     same Y, so build_navmesh never generates a jump/step edge
//     (height_diff is always exactly 0). "No jumping" falls out of the map
//     being flat, not a gate anywhere.
//   - a top-down orthographic camera (render mode "2d", independent of the
//     3D physics dimension — see useEngine's renderMode param) instead of
//     3D's third-person one.
// The player auto-faces its movement direction (yaw_override computed from
// WASD each frame) rather than turning independently — a common top-down-
// shooter control scheme, and the same yaw_override mechanic 3D's pointer-
// lock mode already uses, just computed differently. No aim-pitch/crosshair
// system — meaningless with a fixed overhead camera; firing uses facing
// direction only, matching 2D's simpler shooting model.

const PERSON_HALF_W = 0.4;
const PERSON_HALF_H = 0.9;
const PERSON_HALF_D = 0.4;
const PLAYER_HEALTH = 100;
const FLOOR_TOP_Y = 0; // kikorinTopDownMap.ts's floor block's top surface

const TOPDOWN_CAM_HEIGHT = 25;

const INITIAL_MONSTER_COUNT = 6;

function makeFloorMesh(hw: number, hh: number, hd: number): Object3D {
  return makeEdgedBox(hw, hh, hd, 0x445342, 0x243022, { shadow: true });
}

function makeWallMesh(hw: number, hh: number, hd: number): Object3D {
  return makeEdgedBox(hw, hh, hd, 0xb0a090, 0x5a4a3a, { shadow: true });
}

function makePersonMeshFor(bodyColor: number, frontColor: number): Object3D {
  return makePersonMesh(PERSON_HALF_W, PERSON_HALF_H, PERSON_HALF_D, bodyColor, frontColor, { castShadow: true });
}

const PROJ_GEO = new SphereGeometry(0.12, 10, 8);
const PROJ_MAT = new MeshBasicMaterial({ color: 0xf97316 });
function makeProjectileMesh(): Object3D {
  return new Mesh(PROJ_GEO, PROJ_MAT);
}

/** Mesh for an engine-owned local entity, styled by its net-flag profile. */
function makeLocalMesh(flags: number): Object3D {
  if (flags & NET_BULLET) return makeProjectileMesh();
  if (flags & NET_MONSTER) return makePersonMeshFor(0xcc4444, 0xff8800);
  return makePersonMeshFor(0x4488cc, 0xffe082); // the player
}

/** Mesh for a remote peer's mirror, styled by its public profile. */
function makeRemoteMesh(flags: number): Object3D {
  if (flags & NET_BULLET) return makeProjectileMesh();
  if (flags & NET_MONSTER) return makePersonMeshFor(0x8e4444, 0xd88a8a);
  return makePersonMeshFor(0x9c27b0, 0xe1bee7);
}

export type SetupGameTopDownResult = {
  playerEid: number;
  ownedEids: number[];
  onRemoteEntityHit: (eid: number) => void;
  spawnMonsters: (count: number) => void;
  onFrame: () => void;
  cleanup: () => void;
};

export async function setupGameTopDown(
  engine: WorkerEngineProxy,
  ownership: OwnershipCallbacks,
  _canvas?: HTMLCanvasElement,
): Promise<SetupGameTopDownResult> {
  // Once: a straight-down lookAt is degenerate against the default up vector
  // (both parallel to the view direction) — see setCameraUp's doc comment.
  setCameraUp(0, 0, -1);

  // --- Terrain: load_map spawns every block and builds the navmesh in one
  // call, same as the 3D game — the maze being flat is what makes the
  // navmesh jump-free, not anything special about this call. ---
  const terrainLayout = await engine.load_map(KIKORIN_TOPDOWN_MAP);
  for (const b of terrainLayout) {
    const meshFn = b.kind === "wall" ? makeWallMesh : makeFloorMesh;
    const obj = upsertObjectByEid(b.eid, () => meshFn(b.hw, b.hh, b.hd));
    obj.position.set(b.x, b.y, b.z);
  }

  // Monster tuning: the ring-based spawn_monsters/respawn placement (3D's
  // existing code, reused unmodified) defaults to a radius/height tuned for
  // the open 3D game — here it must stay inside the maze's open center room
  // (walls start at distance 5 from the origin) and at the flat floor's
  // resting height (nothing will fall into place under zero gravity).
  engine.set_monster_config({
    spawn_y: FLOOR_TOP_Y + PERSON_HALF_H,
    ring_base_radius: 2.0,
    ring_radius_step: 0.6,
    ring_steps: 2,
    respawn_y: FLOOR_TOP_Y + PERSON_HALF_H,
    respawn_radius_min: 1.5,
    respawn_radius_max: 2.5,
  });

  // --- Player: spawned at its exact resting height (no gravity to settle
  // it), registered with the real controller — see the module doc above for
  // why yaw_override is how "auto-face movement direction" reuses it as-is. ---
  const playerEid = await engine.spawn_box_entity(
    0, FLOOR_TOP_Y + PERSON_HALF_H, 0, PERSON_HALF_W, PERSON_HALF_H, PERSON_HALF_D, PLAYER_HEALTH,
    NET_LOCAL | NET_REPLICATED,
  );
  engine.register_player(playerEid);
  recordE2EEntitySpawn("player", playerEid);
  ownership.addOwnedEntity(playerEid);
  const ownedEids: number[] = [playerEid];

  // --- Meshes follow the engine's lifecycle events ---
  const unsubLifecycle = lifecycleChannel.subscribe(() => {
    for (const l of lifecycleChannel.getSnapshot()) {
      if (l.kind === "spawned") {
        upsertObjectByEid(l.entity, () => makeLocalMesh(l.flags));
        if (l.flags & NET_MONSTER) recordE2EEntitySpawn("monster", l.entity);
        else if (l.flags & NET_BULLET) recordE2EEntitySpawn("bullet", l.entity);
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
        upsertObjectByEid(p.entity, () => makeRemoteMesh(flags));
      } else if (p.kind === "despawned") {
        removeObjectByEid(p.entity, { dispose: true });
      }
    }
  });

  // --- Raw input ---
  const { heldKeys, disconnect: disconnectHeldKeys } = createHeldKeysTracker();
  const stopSuppressingContextMenu = suppressContextMenu(document);

  function onMouseDown(e: MouseEvent) {
    if (e.button !== 0) return;
    engine.player_fire();
  }
  window.addEventListener("mousedown", onMouseDown);

  function onFrame() {
    const left = heldKeys.has("KeyA") || heldKeys.has("ArrowLeft");
    const right = heldKeys.has("KeyD") || heldKeys.has("ArrowRight");
    const up = heldKeys.has("KeyW") || heldKeys.has("ArrowUp");
    const down = heldKeys.has("KeyS") || heldKeys.has("ArrowDown");

    let dx = 0;
    if (left && !right) dx = -1;
    else if (right && !left) dx = 1;
    let dz = 0;
    if (up && !down) dz = -1;
    else if (down && !up) dz = 1;

    const moving = dx !== 0 || dz !== 0;
    engine.set_player_input({
      forward: moving ? 1 : 0,
      strafe: 0,
      turn: 0,
      // vx = sin(yaw), vz = cos(yaw) at forward=1/strafe=0 (tick_player_controller's
      // existing formula) — solving for the desired (dx, dz) direction gives this.
      yaw_override: moving ? Math.atan2(dx, dz) : null,
      jump_held: false,
      aim_pitch: 0,
    });

    applyToObjectByEid(playerEid, (obj) => {
      setCameraPosition(obj.position.x, TOPDOWN_CAM_HEIGHT, obj.position.z);
      lookCameraAt(obj.position.x, 0, obj.position.z);
    });
  }

  function spawnMonsters(count: number): void {
    engine.spawn_monsters(count);
  }

  function onRemoteEntityHit(_eid: number) {}

  spawnMonsters(INITIAL_MONSTER_COUNT);

  function cleanup() {
    disconnectHeldKeys();
    window.removeEventListener("mousedown", onMouseDown);
    stopSuppressingContextMenu();
    unsubLifecycle();
    unsubNet();
  }

  return { playerEid, ownedEids, onRemoteEntityHit, spawnMonsters, onFrame, cleanup };
}
