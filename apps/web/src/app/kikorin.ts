import {
  lifecycleChannel,
  netChannel,
  NET_BULLET,
  NET_LOCAL,
  NET_MONSTER,
  NET_REPLICATED,
} from "@kikorin/adapter";
import type { WorkerEngineProxy } from "../workers/WorkerEngineProxy";
import { KIKORIN_MAP } from "./kikorinMap";
import { eventBus } from "@kikorin/events";
import {
  upsertObjectByEid,
  applyToObjectByEid,
  removeObjectByEid,
  setCameraPosition,
  lookCameraAt,
  getActiveCamera,
} from "@kikorin/system-rendering";
import {
  Mesh,
  MeshBasicMaterial,
  Raycaster,
  SphereGeometry,
  Vector3,
  type Object3D,
} from "three";
import { recordE2EEntitySpawn } from "./e2eMetrics";
import { makeEdgedBox, makePersonMesh } from "./meshFactories";
import { createHeldKeysTracker, suppressContextMenu } from "./inputHelpers";
import type { OwnershipCallbacks } from "./useNetworking";
import { createMonsterTemplates, pickMonsterTemplate } from "./monsterTemplates";
import { createSpriteDirector } from "./paperDollDirector";
import { PLAYER_LOADOUT, MONSTER_LOADOUT } from "./paperDollAssets";

// This file is UI + IO only: it captures raw input, forwards it to the Rust
// engine (which owns all movement/combat/spawn rules), and renders what the
// engine's lifecycle/render patches say exists. Gameplay tuning lives in the
// engine's PlayerConfig/MonsterConfig/AiConfig (engine defaults = kikorin's
// values; override via set_*_config).

// Camera orbit — spherical coords around the player (view concern, TS-owned).
const CAM_DISTANCE = 9.5;
const DEFAULT_CAM_PITCH = Math.atan2(5, 8); // ≈ 0.56 rad
const CAM_PITCH_MIN = 0.15;
const CAM_PITCH_MAX = Math.PI * 0.45;
const CAM_YAW_SENSITIVITY = 0.0025;
const CAM_PITCH_SENSITIVITY = 0.00125;
const CAM_LOOK_HEIGHT_OFFSET = 0.75;
const AIM_PITCH_MIN = -0.4;
const AIM_PITCH_MAX = +0.6;
const CAM_RESTORE_SPEED = 6.0;
const CAM_WALL_SEPARATION = 0.3;

// Crosshair aim-assist visuals (mirror of the engine's muzzle/hit tuning).
const AIM_ORIGIN_FORWARD = 1.1;
const AIM_ORIGIN_UP = 0.4;
const AIM_ASSIST_RADIUS_SQ = 1.2 * 1.2;
const AIM_FAR = 50;

// Pre-allocated for per-frame aim raycasting — avoids GC churn in the hot path.
const aimRaycaster = new Raycaster();
const aimOriginVec = new Vector3();
const aimDirVec = new Vector3();

// Player/monster body half-extents — must match the collider size passed to
// spawn_box_entity (physics and mesh geometry share one source of truth here).
const PERSON_HALF_W = 0.4;
const PERSON_HALF_H = 0.9;
const PERSON_HALF_D = 0.4;

// This game never calls set_ai_config, so monsters run on AiConfig::default()
// — matches its walk_speed exactly, so "agile"/"slow" read as genuinely
// faster/slower than a plain monster rather than an arbitrary unrelated speed.
const MONSTER_BASE_WALK_SPEED = 2.5;
const MONSTER_TEMPLATES = createMonsterTemplates(MONSTER_BASE_WALK_SPEED);

// ---- Three.js mesh factories ----

function makeFloorMesh(hw: number, hh: number, hd: number): Object3D {
  return makeEdgedBox(hw, hh, hd, 0x445342, 0x243022, { shadow: true });
}

function makePlatformMesh(hw: number, hh: number, hd: number): Object3D {
  return makeEdgedBox(hw, hh, hd, 0x8a9a7a, 0x4a5a3a, { shadow: true });
}

function makeWallMesh(hw: number, hh: number, hd: number): Object3D {
  return makeEdgedBox(hw, hh, hd, 0xb0a090, 0x5a4a3a, { shadow: true });
}

function makePersonMeshFor(bodyColor: number, frontColor: number): Object3D {
  return makePersonMesh(PERSON_HALF_W, PERSON_HALF_H, PERSON_HALF_D, bodyColor, frontColor, { castShadow: true });
}

// Shared across all bullet instances — one GPU upload, many Mesh references.
const PROJ_GEO = new SphereGeometry(0.12, 10, 8);
const PROJ_MAT = new MeshBasicMaterial({ color: 0xf97316 });

function makeProjectileMesh(): Object3D {
  const mesh = new Mesh(PROJ_GEO, PROJ_MAT);
  mesh.scale.set(0.82, 0.82, 1.35);
  return mesh;
}

/** Mesh for a remote peer's mirror, styled by its public profile. */
function makeRemoteMesh(flags: number): Object3D {
  if (flags & NET_BULLET) return makeProjectileMesh();
  if (flags & NET_MONSTER) return makePersonMeshFor(0x8e4444, 0xd88a8a);
  return makePersonMeshFor(0x9c27b0, 0xe1bee7);
}

export type SetupGameResult = {
  playerEid: number;
  ownedEids: number[];
  onRemoteEntityHit: (eid: number) => void;
  spawnMonsters: (count: number) => void;
  /** Called every frame by useEngine after the tick command and before renderFrame. */
  onFrame: () => void;
  /** Pass middle-button drag deltas to orbit the camera. */
  onCameraDrag: (deltaX: number, deltaY: number) => void;
  /** Reset the camera to behind the player. */
  onCameraReset: () => void;
  cleanup: () => void;
};

/**
 * Loads terrain, spawns and registers the player, and wires keyboard + mouse
 * capture. Raw input is forwarded to the engine once per frame; meshes are
 * created and removed from the engine's lifecycle events.
 */
export async function setupGame(
  engine: WorkerEngineProxy,
  ownership: OwnershipCallbacks,
  canvas?: HTMLCanvasElement,
): Promise<SetupGameResult> {
  // --- Terrain ---
  // The game owns the map data; Rust spawns the bodies and builds the navmesh.
  const terrainLayout = await engine.load_map(KIKORIN_MAP);
  const terrainMeshes: Object3D[] = [];
  for (const b of terrainLayout) {
    const meshFn = b.kind === "floor" ? makeFloorMesh
                 : b.kind === "wall"  ? makeWallMesh
                 : makePlatformMesh;
    const obj = upsertObjectByEid(b.eid, () => meshFn(b.hw, b.hh, b.hd));
    obj.position.set(b.x, b.y, b.z);
    terrainMeshes.push(obj);
  }

  // --- Player ---
  // Spawn the body (game data: position/size/health), then hand it to the
  // engine's controller — movement, jumping, and firing rules live in Rust.
  const playerEid = await engine.spawn_box_entity(
    0, 5, 0, PERSON_HALF_W, PERSON_HALF_H, PERSON_HALF_D, 100, NET_LOCAL | NET_REPLICATED,
  );
  engine.register_player(playerEid);
  recordE2EEntitySpawn("player", playerEid);
  ownership.addOwnedEntity(playerEid);
  const ownedEids: number[] = [playerEid];

  // Monster eids (for crosshair aim assist) — maintained from lifecycle events.
  const monsterEids: number[] = [];

  // Paper-doll sprites in billboard mode (perspective camera → Doom-style,
  // camera-relative facing). The engine drives family/frame; the camera picks
  // the shown direction row each frame.
  const PERSON_WORLD_HEIGHT = PERSON_HALF_H * 2;
  const director = await createSpriteDirector(engine, {
    mode: "billboard",
    getCamera: getActiveCamera,
  });

  // --- Sprites/meshes follow the engine's lifecycle events ---
  const unsubLifecycle = lifecycleChannel.subscribe(() => {
    for (const l of lifecycleChannel.getSnapshot()) {
      if (l.kind === "spawned") {
        if (l.flags & NET_MONSTER) {
          // Pick a type before creating the sprite so its capability matches —
          // also covers respawns, which emit this same "spawned" event.
          const template = pickMonsterTemplate(MONSTER_TEMPLATES);
          engine.set_monster_capability(l.entity, template.capability);
          director.add(l.entity, MONSTER_LOADOUT, PERSON_WORLD_HEIGHT);
          monsterEids.push(l.entity);
          recordE2EEntitySpawn("monster", l.entity);
        } else if (l.flags & NET_BULLET) {
          upsertObjectByEid(l.entity, () => makeProjectileMesh());
          recordE2EEntitySpawn("bullet", l.entity);
        } else {
          director.add(l.entity, PLAYER_LOADOUT, PERSON_WORLD_HEIGHT); // the player
        }
      } else {
        director.remove(l.entity); // no-op for non-sprites (bullets)
        removeObjectByEid(l.entity, { dispose: true });
        const idx = monsterEids.indexOf(l.entity);
        if (idx >= 0) monsterEids.splice(idx, 1);
      }
    }
  });

  // --- Remote peers ---
  // The engine mirrors each remote entity into a local eid and reports its
  // lifecycle here; mirror positions then flow through the render channel.
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

  // --- Raw input capture ---
  const { heldKeys, disconnect: disconnectHeldKeys } = createHeldKeysTracker();
  const stopSuppressingContextMenu = suppressContextMenu(document);
  let camYaw = Math.PI;
  let camPitch = DEFAULT_CAM_PITCH;
  let camOrbitActive = false;
  let aimPitch = 0;
  let lastFrameTime = performance.now();
  let camFollowDist = CAM_DISTANCE;
  const camRaycaster = new Raycaster();
  camRaycaster.near = 0.5;
  const camLookAtVec = new Vector3();
  const camRayDirVec = new Vector3();

  function onMouseDown(e: MouseEvent) {
    if (e.button !== 0) {
      e.preventDefault();
      return;
    }
    if (canvas && e.target === canvas && document.pointerLockElement !== canvas) {
      void canvas.requestPointerLock();
    }
    engine.player_fire();
  }
  window.addEventListener("mousedown", onMouseDown);

  function onCameraDrag(deltaX: number, deltaY: number) {
    camYaw -= deltaX * CAM_YAW_SENSITIVITY;
    camPitch = Math.max(CAM_PITCH_MIN, Math.min(CAM_PITCH_MAX, camPitch - deltaY * CAM_PITCH_SENSITIVITY));
    camOrbitActive = true;
  }

  function onCameraReset() {
    applyToObjectByEid(playerEid, (obj) => {
      camYaw = obj.rotation.y + Math.PI;
    });
    camPitch = DEFAULT_CAM_PITCH;
    camOrbitActive = false;
  }

  function onMouseMove(e: MouseEvent) {
    if (!canvas || document.pointerLockElement !== canvas) return;
    camYaw -= e.movementX * CAM_YAW_SENSITIVITY;
    aimPitch = Math.max(AIM_PITCH_MIN, Math.min(AIM_PITCH_MAX, aimPitch - e.movementY * CAM_PITCH_SENSITIVITY));
  }
  document.addEventListener("mousemove", onMouseMove);

  function onPointerLockChange() {
    if (canvas && document.pointerLockElement !== canvas) {
      camOrbitActive = false;
      aimPitch = 0;
    }
  }
  document.addEventListener("pointerlockchange", onPointerLockChange);

  // --- Per-frame: forward raw input, then drive the camera + crosshair ---
  function onFrame() {
    const now = performance.now();
    const dt = Math.min((now - lastFrameTime) / 1000, 0.1);
    lastFrameTime = now;

    const inPointerLock = Boolean(canvas && document.pointerLockElement === canvas);

    // Key/mouse mapping is the only input logic TS keeps; the engine owns what
    // the axes mean (speeds, jump budget, facing integration).
    const forward =
      (heldKeys.has("KeyW") || heldKeys.has("ArrowUp") ? 1 : 0) -
      (heldKeys.has("KeyS") || heldKeys.has("ArrowDown") ? 1 : 0);
    const strafe = inPointerLock
      ? (heldKeys.has("KeyA") || heldKeys.has("KeyQ") ? 1 : 0) - (heldKeys.has("KeyD") || heldKeys.has("KeyE") ? 1 : 0)
      : (heldKeys.has("KeyQ") ? 1 : 0) - (heldKeys.has("KeyE") ? 1 : 0);
    const turn = inPointerLock
      ? 0
      : (heldKeys.has("ArrowRight") || heldKeys.has("KeyD") ? 1 : 0) -
        (heldKeys.has("ArrowLeft") || heldKeys.has("KeyA") ? 1 : 0);

    engine.set_player_input({
      forward,
      strafe,
      turn,
      yaw_override: inPointerLock ? camYaw - Math.PI : null,
      jump_held: heldKeys.has("Space"),
      aim_pitch: aimPitch,
    });

    // Facing for camera/crosshair: camera-driven in pointer lock, otherwise the
    // engine-authored mesh rotation (render patches carry the player's yaw).
    let yaw = camYaw - Math.PI;
    if (!inPointerLock) {
      applyToObjectByEid(playerEid, (obj) => { yaw = obj.rotation.y; });
    }
    const sinY = Math.sin(yaw);
    const cosY = Math.cos(yaw);

    // --- Crosshair + camera follow ---
    applyToObjectByEid(playerEid, (obj) => {
      const px = obj.position.x;
      const py = obj.position.y;
      const pz = obj.position.z;

      const aimCos = Math.cos(aimPitch);
      const aimSin = Math.sin(aimPitch);
      aimOriginVec.set(px + sinY * AIM_ORIGIN_FORWARD, py + AIM_ORIGIN_UP, pz + cosY * AIM_ORIGIN_FORWARD);
      aimDirVec.set(sinY * aimCos, aimSin, cosY * aimCos);
      aimRaycaster.set(aimOriginVec, aimDirVec);

      let aimDist = AIM_FAR;

      // recursive=false skips LineSegments edge-highlight children.
      const terrainHits = aimRaycaster.intersectObjects(terrainMeshes, false);
      if (terrainHits.length > 0) {
        aimDist = terrainHits[0]!.distance;
      }

      // Aim-assist: highlight nearest monster in the crosshair path.
      for (const mEid of monsterEids) {
        applyToObjectByEid(mEid, (mObj) => {
          const dx = mObj.position.x - aimOriginVec.x;
          const dy = mObj.position.y - aimOriginVec.y;
          const dz = mObj.position.z - aimOriginVec.z;
          const t = dx * aimDirVec.x + dy * aimDirVec.y + dz * aimDirVec.z;
          if (t <= 0 || t >= aimDist) return;
          const cx = aimOriginVec.x + aimDirVec.x * t - mObj.position.x;
          const cy = aimOriginVec.y + aimDirVec.y * t - mObj.position.y;
          const cz = aimOriginVec.z + aimDirVec.z * t - mObj.position.z;
          if (cx * cx + cy * cy + cz * cz < AIM_ASSIST_RADIUS_SQ) {
            aimDist = t;
          }
        });
      }

      // Crosshair projected at AIM_FAR (fixed distance keeps screen position stable).
      eventBus.emit("ui:crosshairAimPoint", {
        wx: aimOriginVec.x + aimDirVec.x * AIM_FAR,
        wy: aimOriginVec.y + aimDirVec.y * AIM_FAR,
        wz: aimOriginVec.z + aimDirVec.z * AIM_FAR,
      });

      if (!camOrbitActive) {
        const targetYaw = yaw + Math.PI;
        const delta = Math.atan2(Math.sin(targetYaw - camYaw), Math.cos(targetYaw - camYaw));
        camYaw += delta * 0.12;
      }

      const horizDist = Math.cos(camPitch) * CAM_DISTANCE;
      const followX = Math.sin(camYaw) * horizDist;
      const followY = Math.sin(camPitch) * CAM_DISTANCE;
      const followZ = Math.cos(camYaw) * horizDist;

      const rayX = followX;
      const rayY = followY - CAM_LOOK_HEIGHT_OFFSET;
      const rayZ = followZ;
      const rayLen = Math.sqrt(rayX * rayX + rayY * rayY + rayZ * rayZ);
      if (rayLen > 0) {
        camLookAtVec.set(px, py + CAM_LOOK_HEIGHT_OFFSET, pz);
        camRayDirVec.set(rayX / rayLen, rayY / rayLen, rayZ / rayLen);
        camRaycaster.set(camLookAtVec, camRayDirVec);
        const hits = camRaycaster.intersectObjects(terrainMeshes, true);
        const maxCamDist =
          hits.length > 0 && hits[0]!.distance < rayLen
            ? Math.max(0, ((hits[0]!.distance - CAM_WALL_SEPARATION) / rayLen) * CAM_DISTANCE)
            : CAM_DISTANCE;
        if (camFollowDist > maxCamDist) {
          camFollowDist = maxCamDist;
        } else {
          camFollowDist = Math.min(CAM_DISTANCE, camFollowDist + CAM_RESTORE_SPEED * dt);
        }
      }

      const t = CAM_DISTANCE > 0 ? camFollowDist / CAM_DISTANCE : 0;
      setCameraPosition(px + followX * t, py + followY * t, pz + followZ * t);
      lookCameraAt(px, py + CAM_LOOK_HEIGHT_OFFSET, pz);
    });

    // After the camera has moved this frame, so billboard facing is current.
    director.update(now);
  }

  function spawnMonsters(count: number): void {
    engine.spawn_monsters(count);
  }

  function onRemoteEntityHit(_eid: number) {}

  function cleanup() {
    disconnectHeldKeys();
    window.removeEventListener("mousedown", onMouseDown);
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("pointerlockchange", onPointerLockChange);
    stopSuppressingContextMenu();
    if (canvas && document.pointerLockElement === canvas) document.exitPointerLock();
    unsubLifecycle();
    unsubNet();
    director.dispose();
  }

  return { playerEid, ownedEids, onRemoteEntityHit, spawnMonsters, onFrame, onCameraDrag, onCameraReset, cleanup };
}
