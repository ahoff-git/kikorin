import { hudChannel, hitsChannel } from "@kikorin/adapter";
import type { WorkerEngineProxy } from "../workers/WorkerEngineProxy";
import { eventBus } from "@kikorin/events";
import {
  upsertObjectByEid,
  applyToObjectByEid,
  removeObjectByEid,
  setCameraPosition,
  lookCameraAt,
} from "@kikorin/system-rendering";
import {
  BoxGeometry,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshLambertMaterial,
  MeshBasicMaterial,
  Raycaster,
  SphereGeometry,
  Vector3,
  type Object3D,
} from "three";

// NET_LOCAL flag: entity is simulated locally, included in render patches every tick.
const NET_LOCAL = 0x01;
// NET_MONSTER flag: entity is a monster; engine owns AI, separation, and hit detection.
const NET_MONSTER = 0x04;

const WALK_SPEED = 15;
const TURN_SPEED = 1.8; // radians / second
const JUMP_VEL = 12;

// Camera orbit — spherical coords around the player
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

const PROJ_SPEED = 40;
const PROJ_MAX_FRAMES = 600; // ~10 s at 60 fps
const PROJ_HIT_RADIUS_SQ = 1.2 * 1.2; // for crosshair aim-assist only
const AIM_FAR = 50;

// Pre-allocated for per-frame aim raycasting — avoids GC churn in the hot path.
const aimRaycaster = new Raycaster();
const aimOriginVec = new Vector3();
const aimDirVec = new Vector3();

// ---- Three.js mesh factories ----

function makeEdgedBox(hw: number, hh: number, hd: number, color: number, edgeColor: number): Object3D {
  const geo = new BoxGeometry(hw * 2, hh * 2, hd * 2);
  const mesh = new Mesh(geo, new MeshLambertMaterial({ color }));
  mesh.receiveShadow = true;
  mesh.castShadow = true;
  const line = new LineSegments(new EdgesGeometry(geo), new LineBasicMaterial({ color: edgeColor }));
  line.renderOrder = 1;
  line.scale.setScalar(1.0005);
  mesh.add(line);
  return mesh;
}

function makeFloorMesh(hw: number, hh: number, hd: number): Object3D {
  return makeEdgedBox(hw, hh, hd, 0x445342, 0x243022);
}

function makePlatformMesh(hw: number, hh: number, hd: number): Object3D {
  return makeEdgedBox(hw, hh, hd, 0x8a9a7a, 0x4a5a3a);
}

function makeWallMesh(hw: number, hh: number, hd: number): Object3D {
  return makeEdgedBox(hw, hh, hd, 0xb0a090, 0x5a4a3a);
}

function makePersonMesh(bodyColor: number, frontColor: number): Object3D {
  const group = new Group();
  const geo = new BoxGeometry(0.8, 1.8, 0.8);
  const bodyMat = new MeshLambertMaterial({ color: bodyColor });
  const frontMat = new MeshLambertMaterial({ color: frontColor });
  const body = new Mesh(geo, [bodyMat, bodyMat, bodyMat, bodyMat, frontMat, bodyMat]);
  body.castShadow = true;
  group.add(body);
  return group;
}

// Shared across all bullet instances — one GPU upload, many Mesh references.
const PROJ_GEO = new SphereGeometry(0.12, 10, 8);
const PROJ_MAT = new MeshBasicMaterial({ color: 0xf97316 });

function makeProjectileMesh(): Object3D {
  const mesh = new Mesh(PROJ_GEO, PROJ_MAT);
  mesh.scale.set(0.82, 0.82, 1.35);
  return mesh;
}

// ---- Static terrain layout ----

type TerrainKind = "floor" | "step" | "wall";
type TerrainBlock = { x: number; y: number; z: number; hw: number; hh: number; hd: number; kind?: TerrainKind };

// Multi-zone map. Ramps are approximated as solid stacked steps (AABB colliders only).
const TERRAIN: TerrainBlock[] = [
  // ── MAIN FLOOR ───────────────────────────────────────────────────────────
  { x: 0, y: -1, z: -5, hw: 60, hh: 1, hd: 75, kind: "floor" },

  // ── EAST WING — ramp steps going east (x=10→22, y=0→4, z=12 centre) ────
  { x: 11.5, y: 0.5, z: 12, hw: 1.5, hh: 0.5, hd: 5 },
  { x: 14.5, y: 1.0, z: 12, hw: 1.5, hh: 1.0, hd: 5 },
  { x: 17.5, y: 1.5, z: 12, hw: 1.5, hh: 1.5, hd: 5 },
  { x: 20.5, y: 2.0, z: 12, hw: 1.5, hh: 2.0, hd: 5 },
  { x: 31,   y: 3.7, z: -6, hw: 9,   hh: 0.3, hd: 22 },
  { x: 42,   y: 3.7, z: 0,  hw: 2,   hh: 0.3, hd: 3  },
  { x: 47,   y: 3.7, z: 0,  hw: 3,   hh: 0.3, hd: 4  },

  // ── WEST WING — staircase going west ────────────────────────────────────
  { x: -12, y: 0.5, z: 5, hw: 1.5, hh: 0.5, hd: 2.5 },
  { x: -15, y: 1.0, z: 5, hw: 1.5, hh: 1.0, hd: 2.5 },
  { x: -18, y: 1.5, z: 5, hw: 1.5, hh: 1.5, hd: 2.5 },
  { x: -21, y: 2.0, z: 5, hw: 1.5, hh: 2.0, hd: 2.5 },
  { x: -31, y: 3.7, z: -6, hw: 9, hh: 0.3, hd: 22 },

  // ── NORTH BRIDGE (y=4) ───────────────────────────────────────────────────
  { x: 0, y: 3.7, z: -26, hw: 22, hh: 0.3, hd: 5 },

  // ── NORTH KEEP (y=4) ─────────────────────────────────────────────────────
  { x: 0, y: 3.7, z: -37, hw: 8, hh: 0.3, hd: 6 },
  { x: 0, y: 4.5, z: -44, hw: 4, hh: 0.5, hd: 1.5 },
  { x: 0, y: 5.5, z: -47, hw: 4, hh: 0.5, hd: 1.5 },
  { x: 0, y: 6.5, z: -50, hw: 4, hh: 0.5, hd: 1.5 },
  { x: 0, y: 7.5, z: -53, hw: 4, hh: 0.5, hd: 1.5 },

  // ── UPPER KEEP (top at y=8) ───────────────────────────────────────────────
  { x: 0, y: 7.7, z: -58, hw: 5, hh: 0.3, hd: 4 },
  { x: 0, y: 9.5, z: -62, hw: 5, hh: 1.5, hd: 0.4, kind: "wall" },

  // ── SOUTH TERRACE ────────────────────────────────────────────────────────
  { x: 0, y: 0.5, z: 28.5, hw: 8, hh: 0.5, hd: 1.5 },
  { x: 0, y: 1.0, z: 25.5, hw: 8, hh: 1.0, hd: 1.5 },
  { x: 0, y: 1.5, z: 22.5, hw: 8, hh: 1.5, hd: 1.5 },
  { x: 0, y: 2.7, z: 17, hw: 12, hh: 0.3, hd: 5 },

  // ── WALLS & PARAPETS ─────────────────────────────────────────────────────
  { x: -5, y: 1.5, z: -7,  hw: 0.5, hh: 1.5, hd: 3,  kind: "wall" },
  { x:  5, y: 1.5, z: -7,  hw: 0.5, hh: 1.5, hd: 3,  kind: "wall" },
  { x:  40, y: 4.8, z: -6, hw: 0.3, hh: 0.8, hd: 22, kind: "wall" },
  { x: -40, y: 4.8, z: -6, hw: 0.3, hh: 0.8, hd: 22, kind: "wall" },
  { x: -11, y: 4.8, z: -31, hw: 11, hh: 0.8, hd: 0.4, kind: "wall" },
  { x:  11, y: 4.8, z: -31, hw: 11, hh: 0.8, hd: 0.4, kind: "wall" },
];

// ---- Ownership / networking callback shape ----

type OwnershipCallbacks = {
  addOwnedEntity: (eid: number) => void;
  removeOwnedEntity: (eid: number) => void;
  signalEntityDestroyed: (eid: number) => void;
  signalHitOnRemoteEntity: (localMirrorEid: number) => void;
};

export type SetupGameResult = {
  playerEid: number;
  ownedEids: number[];
  onRemoteEntityHit: (eid: number) => void;
  spawnMonsters: (count: number) => Promise<void>;
  /** Called every frame by useEngine after the tick command and before renderFrame. */
  onFrame: () => void;
  /** Pass middle-button drag deltas to orbit the camera. */
  onCameraDrag: (deltaX: number, deltaY: number) => void;
  /** Reset the camera to behind the player. */
  onCameraReset: () => void;
  cleanup: () => void;
};

/**
 * Spawns terrain, player, and wires keyboard + mouse controls.
 * Returns onFrame (injected into useEngine's RAF loop) and a cleanup function.
 * Async because entity spawning crosses the worker boundary.
 */
export async function setupGame(
  engine: WorkerEngineProxy,
  ownership: OwnershipCallbacks,
  canvas?: HTMLCanvasElement,
): Promise<SetupGameResult> {
  const ownedEids: number[] = [];

  // --- Terrain ---
  const terrainMeshes: Object3D[] = [];
  await Promise.all(TERRAIN.map(async (b) => {
    const eid = await engine.spawn_floor_entity(b.x, b.y, b.z, b.hw, b.hh, b.hd);
    const meshFn = b.kind === "floor" ? makeFloorMesh
                 : b.kind === "wall"  ? makeWallMesh
                 : makePlatformMesh;
    const obj = upsertObjectByEid(eid, () => meshFn(b.hw, b.hh, b.hd));
    obj.position.set(b.x, b.y, b.z);
    terrainMeshes.push(obj);
  }));

  await engine.build_navmesh();

  // --- Player ---
  const playerEid = await engine.spawn_box_entity(0, 5, 0, 0.4, 0.9, 0.4, 100, NET_LOCAL);
  upsertObjectByEid(playerEid, () => makePersonMesh(0x4488cc, 0xffe082));
  ownership.addOwnedEntity(playerEid);
  ownedEids.push(playerEid);

  // --- Monsters (populated by spawnMonsters) ---
  const monsterEids: number[] = [];

  // --- Projectiles ---
  type Projectile = { eid: number; frames: number };
  const projectiles: Projectile[] = [];

  // --- Input state ---
  const heldKeys = new Set<string>();
  let yaw = 0;
  let jumpRequested = false;
  let prevSpaceHeld = false;
  let jumpsUsed = 0;

  // --- Camera orbit state ---
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

  // Grounded state for the player — used for double-jump tracking.
  const unsubHud = hudChannel.subscribe(() => {
    const patches = hudChannel.getSnapshot();
    for (const p of patches) {
      if (p.entity === playerEid && p.grounded !== undefined) {
        if (p.grounded && jumpsUsed > 0) jumpsUsed = 0;
      }
    }
  });

  // --- Hit events from the engine ---
  // Engine reports bullet–monster collisions via hitsChannel; TS handles respawn.
  const unsubHits = hitsChannel.subscribe(() => {
    const hits = hitsChannel.getSnapshot();
    for (const hit of hits) {
      // Clean up bullet (both present-in-world and out-of-bounds cases).
      const projIdx = projectiles.findIndex(p => p.eid === hit.bullet_eid);
      if (projIdx >= 0) projectiles.splice(projIdx, 1);
      engine.destroy_entity(hit.bullet_eid);
      removeObjectByEid(hit.bullet_eid);

      if (hit.target_eid !== null) {
        // Monster was hit — remove it and spawn a replacement at a random map edge.
        engine.destroy_entity(hit.target_eid);
        removeObjectByEid(hit.target_eid, { dispose: true });
        const idx = monsterEids.indexOf(hit.target_eid);
        if (idx >= 0) monsterEids.splice(idx, 1);

        const angle = Math.random() * Math.PI * 2;
        const radius = 30 + Math.random() * 10;
        const rx = Math.cos(angle) * radius;
        const rz = Math.sin(angle) * radius;
        void engine.spawn_box_entity(rx, 10, rz, 0.4, 0.9, 0.4, 50, NET_LOCAL | NET_MONSTER).then((newEid) => {
          const newObj = upsertObjectByEid(newEid, () => makePersonMesh(0xcc4444, 0xff8800));
          newObj.position.set(rx, 10, rz);
          monsterEids.push(newEid);
          ownedEids.push(newEid);
          ownership.addOwnedEntity(newEid);
        });
      }
    }
  });

  function onKeyDown(e: KeyboardEvent) { heldKeys.add(e.code); }
  function onKeyUp(e: KeyboardEvent) { heldKeys.delete(e.code); }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  function onContextMenu(e: MouseEvent) { e.preventDefault(); }
  document.addEventListener("contextmenu", onContextMenu);

  function onMouseDown(e: MouseEvent) {
    if (e.button !== 0) {
      e.preventDefault();
      return;
    }
    if (canvas && e.target === canvas && document.pointerLockElement !== canvas) {
      void canvas.requestPointerLock();
    }

    const sinY = Math.sin(yaw);
    const cosY = Math.cos(yaw);
    let spawnX = 0, spawnY = 0, spawnZ = 0;
    applyToObjectByEid(playerEid, (obj) => {
      spawnX = obj.position.x + sinY * 1.1;
      spawnY = obj.position.y + 0.4;
      spawnZ = obj.position.z + cosY * 1.1;
    });

    const aimCos = Math.cos(aimPitch);
    const aimSin = Math.sin(aimPitch);
    void engine.spawn_bullet(
      spawnX, spawnY, spawnZ,
      sinY * aimCos * PROJ_SPEED,
      aimSin * PROJ_SPEED,
      cosY * aimCos * PROJ_SPEED,
    ).then((eid) => {
      const obj = upsertObjectByEid(eid, makeProjectileMesh);
      obj.position.set(spawnX, spawnY, spawnZ);
      projectiles.push({ eid, frames: 0 });
    });
  }
  window.addEventListener("mousedown", onMouseDown);

  function onCameraDrag(deltaX: number, deltaY: number) {
    camYaw -= deltaX * CAM_YAW_SENSITIVITY;
    camPitch = Math.max(CAM_PITCH_MIN, Math.min(CAM_PITCH_MAX, camPitch - deltaY * CAM_PITCH_SENSITIVITY));
    camOrbitActive = true;
  }

  function onCameraReset() {
    camYaw = yaw + Math.PI;
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

  // --- Per-frame game logic ---
  function onFrame() {
    const now = performance.now();
    const dt = Math.min((now - lastFrameTime) / 1000, 0.1);
    lastFrameTime = now;

    const inPointerLock = Boolean(canvas && document.pointerLockElement === canvas);
    if (inPointerLock) {
      yaw = camYaw - Math.PI;
    } else {
      const turnDir =
        (heldKeys.has("ArrowRight") || heldKeys.has("KeyD") ? 1 : 0) -
        (heldKeys.has("ArrowLeft")  || heldKeys.has("KeyA") ? 1 : 0);
      yaw += turnDir * TURN_SPEED * dt;
    }

    const sinY = Math.sin(yaw);
    const cosY = Math.cos(yaw);

    const fwd =
      (heldKeys.has("KeyW") || heldKeys.has("ArrowUp")   ? 1 : 0) -
      (heldKeys.has("KeyS") || heldKeys.has("ArrowDown")  ? 1 : 0);
    const strafe = inPointerLock
      ? (heldKeys.has("KeyA") || heldKeys.has("KeyQ") ? 1 : 0) - (heldKeys.has("KeyD") || heldKeys.has("KeyE") ? 1 : 0)
      : (heldKeys.has("KeyQ") ? 1 : 0) - (heldKeys.has("KeyE") ? 1 : 0);

    let vx = fwd * sinY + strafe * cosY;
    let vz = fwd * cosY - strafe * sinY;

    const hlen = Math.sqrt(vx * vx + vz * vz);
    if (hlen > 1) { vx /= hlen; vz /= hlen; }
    vx *= WALK_SPEED;
    vz *= WALK_SPEED;

    const spaceHeld = heldKeys.has("Space");
    if (spaceHeld && !prevSpaceHeld && jumpsUsed < 2) {
      jumpRequested = true;
      jumpsUsed++;
    }
    prevSpaceHeld = spaceHeld;

    const vy = jumpRequested ? JUMP_VEL : 0;
    jumpRequested = false;

    engine.set_entity_velocity(playerEid, vx, vy, vz);

    // --- Bullet lifetime ---
    // Bullet hit detection and out-of-bounds are handled by the Rust engine, which
    // emits hit events via hitsChannel (subscribed above). Here we only enforce the
    // maximum-lifetime limit so bullets that never hit anything are eventually cleaned up.
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const proj = projectiles[i]!;
      proj.frames++;
      if (proj.frames > PROJ_MAX_FRAMES) {
        engine.destroy_entity(proj.eid);
        removeObjectByEid(proj.eid);
        projectiles.splice(i, 1);
      }
    }

    // --- Tell the engine where monsters should be heading ---
    applyToObjectByEid(playerEid, (obj) => {
      engine.update_monster_goal(obj.position.x, obj.position.z);
    });

    // --- Camera orbit follow ---
    applyToObjectByEid(playerEid, (obj) => {
      const px = obj.position.x;
      const py = obj.position.y;
      const pz = obj.position.z;

      obj.rotation.y = yaw;

      const aimCos = Math.cos(aimPitch);
      const aimSin = Math.sin(aimPitch);
      aimOriginVec.set(px + sinY * 1.1, py + 0.4, pz + cosY * 1.1);
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
          if (cx * cx + cy * cy + cz * cz < PROJ_HIT_RADIUS_SQ) {
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
  }

  // --- Spawn monsters ---
  async function spawnMonsters(count: number): Promise<void> {
    await Promise.all(
      Array.from({ length: count }, async (_, i) => {
        const angle = (i / count) * Math.PI * 2;
        const radius = 10 + (i % 3) * 4;
        const x = Math.cos(angle) * radius;
        const z = Math.sin(angle) * radius;
        const eid = await engine.spawn_box_entity(x, 5, z, 0.4, 0.9, 0.4, 50, NET_LOCAL | NET_MONSTER);
        const mObj = upsertObjectByEid(eid, () => makePersonMesh(0xcc4444, 0xff8800));
        mObj.position.set(x, 5, z);
        monsterEids.push(eid);
        ownedEids.push(eid);
        ownership.addOwnedEntity(eid);
      }),
    );
  }

  function onRemoteEntityHit(_eid: number) {}

  function cleanup() {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("mousedown", onMouseDown);
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("pointerlockchange", onPointerLockChange);
    document.removeEventListener("contextmenu", onContextMenu);
    if (canvas && document.pointerLockElement === canvas) document.exitPointerLock();
    unsubHud();
    unsubHits();
  }

  return { playerEid, ownedEids, onRemoteEntityHit, spawnMonsters, onFrame, onCameraDrag, onCameraReset, cleanup };
}
