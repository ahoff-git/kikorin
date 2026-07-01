import { hudChannel } from "@kikorin/adapter";
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

// NET_LOCAL flag: entity is simulated locally, included in render patches every tick
const NET_LOCAL = 0x01;

const WALK_SPEED = 15;
const TURN_SPEED = 1.8; // radians / second
const JUMP_VEL = 12;

// Camera orbit — spherical coords around the player
const CAM_DISTANCE = 9.5;
const DEFAULT_CAM_PITCH = Math.atan2(5, 8); // ≈ 0.56 rad, matches old fixed 8/5 offset
const CAM_PITCH_MIN = 0.15;
const CAM_PITCH_MAX = Math.PI * 0.45;
const CAM_YAW_SENSITIVITY = 0.0025;
const CAM_PITCH_SENSITIVITY = 0.00125;
const CAM_LOOK_HEIGHT_OFFSET = 0.75;
const AIM_PITCH_MIN = -0.4; // ~23° below horizontal
const AIM_PITCH_MAX = +0.6; // ~34° above horizontal
const CAM_RESTORE_SPEED = 6.0;    // world-units/sec camera springs back after wall clears
const CAM_WALL_SEPARATION = 0.3;  // gap kept between camera face and wall

const PROJ_SPEED = 40;
const PROJ_MAX_FRAMES = 600; // ~10 s at 60 fps
const PROJ_HIT_RADIUS = 1.2;
const PROJ_HIT_RADIUS_SQ = PROJ_HIT_RADIUS * PROJ_HIT_RADIUS;
const AIM_FAR = 50; // fallback crosshair distance when no terrain or enemy in path

// Pre-allocated for per-frame aim raycasting — avoids GC churn in the hot path.
const aimRaycaster = new Raycaster();
const aimOriginVec = new Vector3();
const aimDirVec = new Vector3();

// Monster AI
const MONSTER_WALK_SPEED = 2.5;
const MONSTER_JUMP_SPEED = 13.0;
const MONSTER_JUMP_TRIGGER_DIST = 2.5;
const MONSTER_JUMP_COOLDOWN = 0.9;
const MONSTER_JUMP_HEIGHT_TOLERANCE = 0.5;
const MONSTER_WAYPOINT_REACH = 1.8;
const MONSTER_REPLAN_PLAYER_MOVE = 5;
const MONSTER_STUCK_SAMPLE_INTERVAL = 0.8;
const MONSTER_STUCK_MOVE_THRESHOLD = 0.5;
const MONSTER_STUCK_ESCAPE_AFTER = 1.6;
const MONSTER_SEPARATION_RADIUS = 2.0; // soft separation bubble radius (world units)

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
  // BoxGeometry groups: +X=0, -X=1, +Y=2, -Y=3, +Z=4 (front), -Z=5
  // "front" is the +Z face because forward direction is (sin(yaw), 0, cos(yaw))
  // and mesh.rotation.y = yaw rotates local +Z to face that world direction.
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

// Multi-zone map ported from the old TypeScript engine version.
// Ramps are approximated as solid stacked steps (physics engine only supports AABB colliders).
// Layout zones: central courtyard → east wing (y=4) → west wing (y=4) → north bridge →
//               north keep → keep stairs → upper keep (y=8) → south terrace (y=3).
const TERRAIN: TerrainBlock[] = [
  // ── MAIN FLOOR ───────────────────────────────────────────────────────────
  { x: 0, y: -1, z: -5, hw: 60, hh: 1, hd: 75, kind: "floor" },

  // ── EAST WING — ramp steps going east (x=10→22, y=0→4, z=12 centre) ────
  // Solid stacked blocks so each step's top surface is at y=1,2,3,4.
  { x: 11.5, y: 0.5, z: 12, hw: 1.5, hh: 0.5, hd: 5 },
  { x: 14.5, y: 1.0, z: 12, hw: 1.5, hh: 1.0, hd: 5 },
  { x: 17.5, y: 1.5, z: 12, hw: 1.5, hh: 1.5, hd: 5 },
  { x: 20.5, y: 2.0, z: 12, hw: 1.5, hh: 2.0, hd: 5 },
  // Large east platform (top at y=4, extends z=-28→16)
  { x: 31,   y: 3.7, z: -6, hw: 9,   hh: 0.3, hd: 22 },
  // Narrow walkway east off the platform
  { x: 42,   y: 3.7, z: 0,  hw: 2,   hh: 0.3, hd: 3  },
  // Small balcony overlook
  { x: 47,   y: 3.7, z: 0,  hw: 3,   hh: 0.3, hd: 4  },

  // ── WEST WING — staircase going west, solid blocks ────────────────────
  { x: -12, y: 0.5, z: 5, hw: 1.5, hh: 0.5, hd: 2.5 },
  { x: -15, y: 1.0, z: 5, hw: 1.5, hh: 1.0, hd: 2.5 },
  { x: -18, y: 1.5, z: 5, hw: 1.5, hh: 1.5, hd: 2.5 },
  { x: -21, y: 2.0, z: 5, hw: 1.5, hh: 2.0, hd: 2.5 },
  // Large west platform (top at y=4, mirrors east)
  { x: -31, y: 3.7, z: -6, hw: 9, hh: 0.3, hd: 22 },

  // ── NORTH BRIDGE (y=4) — connects east and west wings ────────────────
  { x: 0, y: 3.7, z: -26, hw: 22, hh: 0.3, hd: 5 },

  // ── NORTH KEEP (y=4) ─────────────────────────────────────────────────
  { x: 0, y: 3.7, z: -37, hw: 8, hh: 0.3, hd: 6 },
  // Keep stairs from y=4 to y=8 (each step 1 unit higher, spaced 3 units apart in z)
  { x: 0, y: 4.5, z: -44, hw: 4, hh: 0.5, hd: 1.5 },
  { x: 0, y: 5.5, z: -47, hw: 4, hh: 0.5, hd: 1.5 },
  { x: 0, y: 6.5, z: -50, hw: 4, hh: 0.5, hd: 1.5 },
  { x: 0, y: 7.5, z: -53, hw: 4, hh: 0.5, hd: 1.5 },

  // ── UPPER KEEP (top at y=8) ───────────────────────────────────────────
  { x: 0, y: 7.7, z: -58, hw: 5, hh: 0.3, hd: 4 },
  // Far parapet wall
  { x: 0, y: 9.5, z: -62, hw: 5, hh: 1.5, hd: 0.4, kind: "wall" },

  // ── SOUTH TERRACE — ramp steps going north (z=30→22, y=0→3) ──────────
  { x: 0, y: 0.5, z: 28.5, hw: 8, hh: 0.5, hd: 1.5 },
  { x: 0, y: 1.0, z: 25.5, hw: 8, hh: 1.0, hd: 1.5 },
  { x: 0, y: 1.5, z: 22.5, hw: 8, hh: 1.5, hd: 1.5 },
  // Terrace platform (top at y=3)
  { x: 0, y: 2.7, z: 17, hw: 12, hh: 0.3, hd: 5 },

  // ── WALLS & PARAPETS ─────────────────────────────────────────────────
  // Courtyard cover near spawn
  { x: -5, y: 1.5, z: -7,  hw: 0.5, hh: 1.5, hd: 3,  kind: "wall" },
  { x:  5, y: 1.5, z: -7,  hw: 0.5, hh: 1.5, hd: 3,  kind: "wall" },
  // East platform east parapet
  { x:  40, y: 4.8, z: -6, hw: 0.3, hh: 0.8, hd: 22, kind: "wall" },
  // West platform west parapet
  { x: -40, y: 4.8, z: -6, hw: 0.3, hh: 0.8, hd: 22, kind: "wall" },
  // North bridge north parapets (split at centre to leave an opening)
  { x: -11, y: 4.8, z: -31, hw: 11, hh: 0.8, hd: 0.4, kind: "wall" },
  { x:  11, y: 4.8, z: -31, hw: 11, hh: 0.8, hd: 0.4, kind: "wall" },
];

// ---- Monster pathfinding ----

type MonsterPathState = {
  path: Array<{ x: number; y: number; z: number; requiresJump: boolean; isLedgeDrop: boolean }> | null;
  waypointIndex: number;
  lastGoalX: number;
  lastGoalZ: number;
  jumpCooldown: number;
  stuckTimer: number;
  lastSampleX: number;
  lastSampleZ: number;
  stuckSampleTimer: number;
  pendingPath: boolean;
};

function createMonsterPathState(): MonsterPathState {
  return {
    path: null,
    waypointIndex: 0,
    lastGoalX: Infinity,
    lastGoalZ: Infinity,
    jumpCooldown: 0,
    stuckTimer: 0,
    lastSampleX: Infinity,
    lastSampleZ: Infinity,
    stuckSampleTimer: Math.random() * MONSTER_STUCK_SAMPLE_INTERVAL,
    pendingPath: false,
  };
}

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

  // --- Terrain (parallel spawn — all requests sent at once, resolved as acks arrive) ---
  // Terrain meshes are also used for camera wall-separation raycasting.
  const terrainMeshes: Object3D[] = [];
  await Promise.all(TERRAIN.map(async (b) => {
    const eid = await engine.spawn_floor_entity(b.x, b.y, b.z, b.hw, b.hh, b.hd);
    const meshFn = b.kind === "floor" ? makeFloorMesh
                 : b.kind === "wall"  ? makeWallMesh
                 : makePlatformMesh;
    // Static entities never emit render patches — position them directly in Three.js.
    const obj = upsertObjectByEid(eid, () => meshFn(b.hw, b.hh, b.hd));
    obj.position.set(b.x, b.y, b.z);
    terrainMeshes.push(obj);
  }));

  // Build navmesh from Rapier floor geometry — must happen after all floor entities spawned.
  await engine.build_navmesh();

  // --- Player ---
  const playerEid = await engine.spawn_box_entity(0, 5, 0, 0.4, 0.9, 0.4, 100, NET_LOCAL);
  upsertObjectByEid(playerEid, () => makePersonMesh(0x4488cc, 0xffe082));
  ownership.addOwnedEntity(playerEid);
  ownedEids.push(playerEid);

  // --- Monsters list (populated by spawnMonsters) ---
  const monsterEids: number[] = [];
  const monsterPathStates = new Map<number, MonsterPathState>();
  // Grounded state per entity — populated from semantic patches for all NET_LOCAL entities.
  const groundedByEid = new Map<number, boolean>();

  // --- Projectiles ---
  type Projectile = { eid: number; frames: number };
  const projectiles: Projectile[] = [];

  // --- Input state ---
  const heldKeys = new Set<string>();
  let yaw = 0; // radians — player facing direction
  let jumpRequested = false;
  let prevSpaceHeld = false;
  let jumpsUsed = 0; // double jump counter; reset to 0 on landing

  // --- Camera orbit state ---
  let camYaw = Math.PI;       // start behind player
  let camPitch = DEFAULT_CAM_PITCH;
  let camOrbitActive = false; // true once user has manually orbited
  let aimPitch = 0;           // vertical aim angle in pointer-lock, radians (0 = horizontal)
  let lastFrameTime = performance.now();
  // Camera wall-separation: actual distance springs toward CAM_DISTANCE when clear.
  let camFollowDist = CAM_DISTANCE;
  const camRaycaster = new Raycaster();
  // Skip geometry within the player's body radius — walls the player is touching
  // are at ~0.4 units from the look-at origin. Without this, physics jitter causes
  // the ray to alternate hit/miss at near-zero distance, snapping the camera on every frame.
  camRaycaster.near = 0.5;
  const camLookAtVec = new Vector3();
  const camRayDirVec = new Vector3();

  // --- Grounded state (updated from semantic patches for all NET_LOCAL entities) ---
  // groundedByEid tracks monsters; player landing resets jumpsUsed for double jump.
  const unsubHud = hudChannel.subscribe(() => {
    const patches = hudChannel.getSnapshot();
    for (const p of patches) {
      if (p.grounded !== undefined) {
        const wasGrounded = groundedByEid.get(p.entity) ?? false;
        groundedByEid.set(p.entity, p.grounded);
        if (p.entity === playerEid && p.grounded && !wasGrounded) {
          jumpsUsed = 0;
        }
      }
    }
  });

  function onKeyDown(e: KeyboardEvent) { heldKeys.add(e.code); }
  function onKeyUp(e: KeyboardEvent) { heldKeys.delete(e.code); }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  // Prevent the context menu from appearing while the game is running so right-click
  // cannot trigger the browser's pointer-lock exit path.
  function onContextMenu(e: MouseEvent) { e.preventDefault(); }
  document.addEventListener("contextmenu", onContextMenu);

  // --- Shoot on left click; lock pointer when clicking the canvas ---
  function onMouseDown(e: MouseEvent) {
    if (e.button !== 0) {
      e.preventDefault(); // block right-click context menu before browser processes it
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

  // --- Camera orbit callbacks ---
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

  // Route pointer-lock mouse movement to yaw + aim pitch (not camera orbit pitch).
  // Middle-drag orbit controls camPitch (camera height). Mouse-look controls aimPitch
  // (vertical aim angle) so bullets and the crosshair both respond to vertical input.
  function onMouseMove(e: MouseEvent) {
    if (!canvas || document.pointerLockElement !== canvas) return;
    camYaw -= e.movementX * CAM_YAW_SENSITIVITY;
    aimPitch = Math.max(AIM_PITCH_MIN, Math.min(AIM_PITCH_MAX, aimPitch - e.movementY * CAM_PITCH_SENSITIVITY));
  }
  document.addEventListener("mousemove", onMouseMove);

  // Resume auto-trailing when the pointer lock is released (Escape).
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
    // In pointer lock, yaw tracks the camera so mouse look steers the player.
    // Without pointer lock, A/D and arrow keys turn the player.
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

    // W/S / arrows: forward/back.
    // Strafe: Q/E always; A/D also strafe in pointer-lock (FPS mode) since mouse handles turning.
    const fwd =
      (heldKeys.has("KeyW") || heldKeys.has("ArrowUp")   ? 1 : 0) -
      (heldKeys.has("KeyS") || heldKeys.has("ArrowDown")  ? 1 : 0);
    const strafe = inPointerLock
      ? (heldKeys.has("KeyA") || heldKeys.has("KeyQ") ? 1 : 0) - (heldKeys.has("KeyD") || heldKeys.has("KeyE") ? 1 : 0)
      : (heldKeys.has("KeyQ") ? 1 : 0) - (heldKeys.has("KeyE") ? 1 : 0);

    let vx = fwd * sinY + strafe * cosY;
    let vz = fwd * cosY - strafe * sinY;

    // Normalise diagonal movement
    const hlen = Math.sqrt(vx * vx + vz * vz);
    if (hlen > 1) { vx /= hlen; vz /= hlen; }
    vx *= WALK_SPEED;
    vz *= WALK_SPEED;

    // Jump — rising edge; allows one extra mid-air jump (double jump)
    const spaceHeld = heldKeys.has("Space");
    if (spaceHeld && !prevSpaceHeld && jumpsUsed < 2) {
      jumpRequested = true;
      jumpsUsed++;
    }
    prevSpaceHeld = spaceHeld;

    // vy=0 preserves current Y so gravity accumulates; non-zero overrides for jump
    const vy = jumpRequested ? JUMP_VEL : 0;
    jumpRequested = false;

    engine.set_entity_velocity(playerEid, vx, vy, vz);

    // --- Projectile lifetime and hit detection ---
    // Bullet position comes from render patches (applyToObjectByEid).
    // Engine integrates ballistic trajectory; TypeScript owns lifetime and hit detection.
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const proj = projectiles[i];
      proj.frames++;

      if (proj.frames > PROJ_MAX_FRAMES) {
        engine.destroy_entity(proj.eid);
        removeObjectByEid(proj.eid);
        projectiles.splice(i, 1);
        continue;
      }

      let projDead = false;
      applyToObjectByEid(proj.eid, (pObj) => {
        if (pObj.position.y < -20) { projDead = true; return; }

        for (let j = monsterEids.length - 1; j >= 0; j--) {
          if (projDead) break;
          applyToObjectByEid(monsterEids[j], (mObj) => {
            const dx = pObj.position.x - mObj.position.x;
            const dy = pObj.position.y - mObj.position.y;
            const dz = pObj.position.z - mObj.position.z;
            if (dx * dx + dy * dy + dz * dz < PROJ_HIT_RADIUS_SQ) {
              engine.destroy_entity(monsterEids[j]!);
              removeObjectByEid(monsterEids[j]!, { dispose: true });
              monsterPathStates.delete(monsterEids[j]!);
              monsterEids.splice(j, 1);
              projDead = true;
              // Spawn a replacement at a random map-edge position to keep the horde alive.
              const angle = Math.random() * Math.PI * 2;
              const radius = 30 + Math.random() * 10;
              const rx = Math.cos(angle) * radius;
              const rz = Math.sin(angle) * radius;
              void engine.spawn_box_entity(rx, 10, rz, 0.4, 0.9, 0.4, 50, NET_LOCAL).then((newEid) => {
                const newObj = upsertObjectByEid(newEid, () => makePersonMesh(0xcc4444, 0xff8800));
                newObj.position.set(rx, 10, rz);
                monsterEids.push(newEid);
                monsterPathStates.set(newEid, createMonsterPathState());
                ownedEids.push(newEid);
                ownership.addOwnedEntity(newEid);
              });
            }
          });
        }
      });

      if (projDead) {
        engine.destroy_entity(proj.eid);
        removeObjectByEid(proj.eid);
        projectiles.splice(i, 1);
      }
    }

    // --- Monster AI: A* pathfinding toward the player ---
    applyToObjectByEid(playerEid, (playerObj) => {
      const goalX = playerObj.position.x;
      const goalZ = playerObj.position.z;

      for (const mEid of monsterEids) {
        const pathState = monsterPathStates.get(mEid);
        if (!pathState) continue;

        applyToObjectByEid(mEid, (mObj) => {
          const mx = mObj.position.x;
          const my = mObj.position.y;
          const mz = mObj.position.z;
          const dx = goalX - mx;
          const dz = goalZ - mz;
          const dist = Math.hypot(dx, dz);

          if (dist < 0.001) return;

          // Tick down jump cooldown
          pathState.jumpCooldown = Math.max(0, pathState.jumpCooldown - dt);

          // Stuck detection: sample displacement every STUCK_SAMPLE_INTERVAL seconds
          pathState.stuckSampleTimer += dt;
          if (pathState.stuckSampleTimer >= MONSTER_STUCK_SAMPLE_INTERVAL) {
            pathState.stuckSampleTimer = 0;
            const moved = Math.hypot(mx - pathState.lastSampleX, mz - pathState.lastSampleZ);
            if (moved < MONSTER_STUCK_MOVE_THRESHOLD) {
              pathState.stuckTimer += MONSTER_STUCK_SAMPLE_INTERVAL;
              if (pathState.stuckTimer >= MONSTER_STUCK_ESCAPE_AFTER) {
                pathState.path = null;
                pathState.lastGoalX = Infinity;
                pathState.lastGoalZ = Infinity;
                pathState.stuckTimer = 0;
              }
            } else {
              pathState.stuckTimer = 0;
            }
            pathState.lastSampleX = mx;
            pathState.lastSampleZ = mz;
          }

          // Replan when the player moves significantly from the last planned goal.
          // find_path is async (crosses to the worker); mark goal immediately to prevent
          // redundant replans while the response is in flight.
          const playerMoved =
            Math.hypot(goalX - pathState.lastGoalX, goalZ - pathState.lastGoalZ) >
            MONSTER_REPLAN_PLAYER_MOVE;
          if (playerMoved && !pathState.pendingPath) {
            pathState.lastGoalX = goalX;
            pathState.lastGoalZ = goalZ;
            pathState.pendingPath = true;
            const monsterFloorY = my - 0.9;
            void engine.find_path(mx, monsterFloorY, mz, goalX, goalZ, true).then(path => {
              const ps = monsterPathStates.get(mEid);
              if (ps) {
                ps.path = path;
                ps.waypointIndex = 0;
                ps.pendingPath = false;
              }
            });
          }

          // Soft separation: push away from player and nearby monsters so they
          // can squish past each other rather than hard-blocking movement.
          let sepX = 0, sepZ = 0;
          if (dist < MONSTER_SEPARATION_RADIUS && dist > 0.001) {
            const f = 1.0 - dist / MONSTER_SEPARATION_RADIUS;
            sepX -= (dx / dist) * f;
            sepZ -= (dz / dist) * f;
          }
          for (const otherEid of monsterEids) {
            if (otherEid === mEid) continue;
            applyToObjectByEid(otherEid, (oObj) => {
              const odx = oObj.position.x - mx;
              const odz = oObj.position.z - mz;
              const od = Math.hypot(odx, odz);
              if (od < MONSTER_SEPARATION_RADIUS && od > 0.001) {
                const f = 1.0 - od / MONSTER_SEPARATION_RADIUS;
                sepX -= (odx / od) * f;
                sepZ -= (odz / od) * f;
              }
            });
          }

          let desiredX: number;
          let desiredZ: number;

          const path = pathState.path;
          if (path !== null && path.length > 0 && pathState.waypointIndex < path.length) {
            // Advance past waypoints already reached (skip jump waypoint until climbed)
            while (pathState.waypointIndex < path.length) {
              const wp = path[pathState.waypointIndex]!;
              if (Math.hypot(wp.x - mx, wp.z - mz) >= MONSTER_WAYPOINT_REACH) break;
              if (wp.requiresJump && my - 0.9 < wp.y - MONSTER_JUMP_HEIGHT_TOLERANCE) break;
              pathState.waypointIndex++;
            }

            if (pathState.waypointIndex >= path.length) {
              pathState.path = null;
              pathState.lastGoalX = Infinity;
              pathState.lastGoalZ = Infinity;
            }

            if (pathState.waypointIndex < path.length) {
              const wp = path[pathState.waypointIndex]!;
              const wpDX = wp.x - mx;
              const wpDZ = wp.z - mz;
              const wpDist = Math.hypot(wpDX, wpDZ);
              desiredX = wpDist > 0 ? wpDX / wpDist : dx / dist;
              desiredZ = wpDist > 0 ? wpDZ / wpDist : dz / dist;

              // Fire jump impulse when close to a step-up waypoint and grounded
              const monsterGrounded = groundedByEid.get(mEid) ?? false;
              if (
                wp.requiresJump &&
                pathState.jumpCooldown <= 0 &&
                monsterGrounded &&
                wpDist < MONSTER_JUMP_TRIGGER_DIST
              ) {
                mObj.rotation.y = Math.atan2(desiredX, desiredZ);
                engine.set_entity_velocity(
                  mEid,
                  (desiredX + sepX) * MONSTER_WALK_SPEED,
                  MONSTER_JUMP_SPEED,
                  (desiredZ + sepZ) * MONSTER_WALK_SPEED,
                );
                pathState.jumpCooldown = MONSTER_JUMP_COOLDOWN;
                return;
              }
            } else {
              desiredX = dx / dist;
              desiredZ = dz / dist;
            }
          } else {
            // No path — fall back to direct pursuit
            desiredX = dx / dist;
            desiredZ = dz / dist;
          }

          mObj.rotation.y = Math.atan2(desiredX, desiredZ);
          engine.set_entity_velocity(mEid, (desiredX + sepX) * MONSTER_WALK_SPEED, 0, (desiredZ + sepZ) * MONSTER_WALK_SPEED);
        });
      }
    });

    // --- Camera orbit follow ---
    applyToObjectByEid(playerEid, (obj) => {
      const px = obj.position.x;
      const py = obj.position.y;
      const pz = obj.position.z;

      obj.rotation.y = yaw;

      // Raycast along the aim direction so the crosshair lands on the first
      // surface or enemy a bullet would actually reach. aimDirVec is unit-length:
      // ||(sinY·aimCos, aimSin, cosY·aimCos)||² = aimCos²+aimSin² = 1.
      const aimCos = Math.cos(aimPitch);
      const aimSin = Math.sin(aimPitch);
      aimOriginVec.set(px + sinY * 1.1, py + 0.4, pz + cosY * 1.1);
      aimDirVec.set(sinY * aimCos, aimSin, cosY * aimCos);
      aimRaycaster.set(aimOriginVec, aimDirVec);

      let aimDist = AIM_FAR;

      // recursive=false skips LineSegments edge-highlight children — their line-proximity
      // threshold causes false hits on nearby edges and was the source of the snapping.
      const terrainHits = aimRaycaster.intersectObjects(terrainMeshes, false);
      if (terrainHits.length > 0) {
        aimDist = terrainHits[0].distance;
      }

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

      // Always project at AIM_FAR — fixed distance means the screen position depends
      // only on aim direction (yaw/pitch), not on what's in the path. Using the terrain
      // hit distance causes parallax drift as distance changes through the offset camera.
      eventBus.emit("ui:crosshairAimPoint", {
        wx: aimOriginVec.x + aimDirVec.x * AIM_FAR,
        wy: aimOriginVec.y + aimDirVec.y * AIM_FAR,
        wz: aimOriginVec.z + aimDirVec.z * AIM_FAR,
      });

      if (!camOrbitActive) {
        // Trail player yaw when not manually orbiting; smooth to avoid snapping on sharp turns
        const targetYaw = yaw + Math.PI;
        const delta = Math.atan2(Math.sin(targetYaw - camYaw), Math.cos(targetYaw - camYaw));
        camYaw += delta * 0.12;
      }

      const horizDist = Math.cos(camPitch) * CAM_DISTANCE;
      const followX = Math.sin(camYaw) * horizDist;
      const followY = Math.sin(camPitch) * CAM_DISTANCE;
      const followZ = Math.cos(camYaw) * horizDist;

      // Cast a ray from the look-at point toward the desired camera position.
      // Snap camera in immediately when terrain blocks the path; spring back when clear.
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
          hits.length > 0 && hits[0].distance < rayLen
            ? Math.max(0, ((hits[0].distance - CAM_WALL_SEPARATION) / rayLen) * CAM_DISTANCE)
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
        const eid = await engine.spawn_box_entity(x, 5, z, 0.4, 0.9, 0.4, 50, NET_LOCAL);
        const mObj = upsertObjectByEid(eid, () => makePersonMesh(0xcc4444, 0xff8800));
        mObj.position.set(x, 5, z);
        monsterEids.push(eid);
        monsterPathStates.set(eid, createMonsterPathState());
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
    // Three.js objects and engine entities are cleaned up by disposeRenderer() on unmount.
  }

  return { playerEid, ownedEids, onRemoteEntityHit, spawnMonsters, onFrame, onCameraDrag, onCameraReset, cleanup };
}
