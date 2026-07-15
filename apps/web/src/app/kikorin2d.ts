import {
  lifecycleChannel,
  netChannel,
  hudChannel,
  NET_BULLET,
  NET_LOCAL,
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
  BoxGeometry,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshLambertMaterial,
  MeshBasicMaterial,
  SphereGeometry,
  type Object3D,
} from "three";
import { KIKORIN_2D_MAP, BLOCK_Z_HALF_DEPTH } from "./kikorin2dMap";

// This file is UI + IO only, mirroring kikorin.ts's split for the 3D game —
// but it does NOT use the engine's player controller (register_player/
// set_player_input), monster AI, or navmesh/pathfinding at all. Those are
// written in terms of an X/Z ground plane + Y height and aren't meaningful
// for a side-view 2D game (see crates/engine/engine.spec.md's "Physics
// Dimension" section). Movement, shooting, monster patrol, and hit detection
// are all plain TypeScript here, driving the engine only through its
// dimension-agnostic primitives: spawn_box_entity, spawn_bullet,
// spawn_floor_entity, set_entity_velocity, destroy_entity.

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
const HIT_RADIUS_SQ = 0.6 * 0.6;

const MONSTER_HALF = 0.4;
const MONSTER_HEALTH = 30;
const MONSTER_PATROL_SPEED = 2.0;
const MONSTER_PATROL_RANGE = 3.0;
const MONSTER_SPAWN_Y = 4.0;
const MONSTER_SPAWN_X_SPREAD = 9.0;

const CAM_Y_OFFSET = 1.0;
const CAM_Z = 5.0;

function makeFlatBox(hw: number, hh: number, color: number, edgeColor: number): Object3D {
  const geo = new BoxGeometry(hw * 2, hh * 2, BLOCK_Z_HALF_DEPTH * 2);
  const mesh = new Mesh(geo, new MeshLambertMaterial({ color }));
  mesh.receiveShadow = false;
  mesh.castShadow = false;
  const line = new LineSegments(new EdgesGeometry(geo), new LineBasicMaterial({ color: edgeColor }));
  line.renderOrder = 1;
  line.scale.setScalar(1.0005);
  mesh.add(line);
  return mesh;
}

function makePersonMesh(bodyColor: number, frontColor: number): Object3D {
  const group = new Group();
  const geo = new BoxGeometry(PLAYER_HALF_W * 2, PLAYER_HALF_H * 2, PLAYER_HALF_D * 2);
  const bodyMat = new MeshLambertMaterial({ color: bodyColor });
  const frontMat = new MeshLambertMaterial({ color: frontColor });
  const body = new Mesh(geo, [bodyMat, bodyMat, bodyMat, bodyMat, frontMat, bodyMat]);
  group.add(body);
  return group;
}

const PROJ_GEO = new SphereGeometry(0.15, 10, 8);
const PROJ_MAT = new MeshBasicMaterial({ color: 0xf97316 });
function makeProjectileMesh(): Object3D {
  return new Mesh(PROJ_GEO, PROJ_MAT);
}

type OwnershipCallbacks = {
  addOwnedEntity: (eid: number) => void;
  removeOwnedEntity: (eid: number) => void;
  signalEntityDestroyed: (eid: number) => void;
  signalHitOnRemoteEntity: (localMirrorEid: number) => void;
};

export type SetupGame2DResult = {
  playerEid: number;
  ownedEids: number[];
  onRemoteEntityHit: (eid: number) => void;
  spawnMonsters: (count: number) => void;
  onFrame: () => void;
  cleanup: () => void;
};

type Monster = { eid: number; originX: number; dir: 1 | -1 };

export async function setupGame2D(
  engine: WorkerEngineProxy,
  ownership: OwnershipCallbacks,
  _canvas?: HTMLCanvasElement,
): Promise<SetupGame2DResult> {
  // --- Terrain: spawned directly (no load_map/navmesh — this game has no
  // pathfinding to build one for). ---
  for (const b of KIKORIN_2D_MAP) {
    const eid = await engine.spawn_floor_entity(b.x, b.y, 0, b.hw, b.hh, BLOCK_Z_HALF_DEPTH);
    const obj = upsertObjectByEid(eid, () => makeFlatBox(b.hw, b.hh, 0x445342, 0x243022));
    obj.position.set(b.x, b.y, 0);
  }

  // --- Player ---
  const playerEid = await engine.spawn_box_entity(
    0, 3, 0, PLAYER_HALF_W, PLAYER_HALF_H, PLAYER_HALF_D, PLAYER_HEALTH, NET_LOCAL | NET_REPLICATED,
  );
  upsertObjectByEid(playerEid, () => makePersonMesh(0x4488cc, 0xffe082));
  ownership.addOwnedEntity(playerEid);
  const ownedEids: number[] = [playerEid];

  // --- Bullets: created locally, tracked here for hit detection; the engine
  // integrates/destroys them on its own schedule (TTL/kill-plane/hit), so
  // lifecycle "despawned" is the only place we need to stop tracking one. ---
  const bulletEids = new Set<number>();
  const unsubLifecycle = lifecycleChannel.subscribe(() => {
    for (const l of lifecycleChannel.getSnapshot()) {
      if (l.kind === "spawned") {
        if (l.entity === playerEid) continue; // already created above
        if (l.flags & NET_BULLET) {
          bulletEids.add(l.entity);
          upsertObjectByEid(l.entity, () => makeProjectileMesh());
        }
      } else {
        bulletEids.delete(l.entity);
        removeObjectByEid(l.entity, { dispose: true });
      }
    }
  });

  // --- Remote peers' mirrors ---
  const unsubNet = netChannel.subscribe(() => {
    for (const p of netChannel.getSnapshot()) {
      if (p.kind === "spawned") {
        const flags = p.flags ?? 0;
        upsertObjectByEid(p.entity, () => (flags & NET_BULLET) ? makeProjectileMesh() : makePersonMesh(0x9c27b0, 0xe1bee7));
      } else if (p.kind === "despawned") {
        removeObjectByEid(p.entity, { dispose: true });
      }
    }
  });

  // --- Grounded tracking for jump edge-detection (no built-in player
  // controller here, so this game does its own — see the module doc above). ---
  let grounded = false;
  const unsubHud = hudChannel.subscribe(() => {
    for (const s of hudChannel.getSnapshot()) {
      if (s.entity === playerEid && s.grounded !== undefined) grounded = s.grounded;
    }
  });

  // --- Monsters: plain locally-owned boxes, no NET_MONSTER flag — this game
  // drives their patrol and hit detection itself rather than using the
  // engine's navmesh-based monster AI (not meaningful for a side view). ---
  const monsters: Monster[] = [];
  async function spawnMonsters(count: number) {
    for (let i = 0; i < count; i++) {
      const x = (Math.random() - 0.5) * 2 * MONSTER_SPAWN_X_SPREAD;
      const eid = await engine.spawn_box_entity(
        x, MONSTER_SPAWN_Y, 0, MONSTER_HALF, MONSTER_HALF, MONSTER_HALF, MONSTER_HEALTH, NET_LOCAL | NET_REPLICATED,
      );
      upsertObjectByEid(eid, () => makePersonMesh(0xcc4444, 0xff8800));
      monsters.push({ eid, originX: x, dir: Math.random() < 0.5 ? 1 : -1 });
    }
  }

  // --- Raw input ---
  const heldKeys = new Set<string>();
  function onKeyDown(e: KeyboardEvent) { heldKeys.add(e.code); }
  function onKeyUp(e: KeyboardEvent) { heldKeys.delete(e.code); }
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);

  function onContextMenu(e: MouseEvent) { e.preventDefault(); }
  document.addEventListener("contextmenu", onContextMenu);

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
    if (grounded) jumpsUsed = 0;
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

    for (const m of monsters) {
      applyToObjectByEid(m.eid, (obj) => {
        if (obj.position.x > m.originX + MONSTER_PATROL_RANGE) m.dir = -1;
        else if (obj.position.x < m.originX - MONSTER_PATROL_RANGE) m.dir = 1;
        engine.set_entity_velocity(m.eid, m.dir * MONSTER_PATROL_SPEED, 0, 0);
      });
    }

    // Bullet-vs-monster hit detection: this game's monsters aren't
    // NET_MONSTER-flagged, so the engine's own bullet hit detection doesn't
    // see them — a simple distance check on last-rendered positions instead.
    for (const bulletEid of [...bulletEids]) {
      applyToObjectByEid(bulletEid, (bulletObj) => {
        // Snapshot: the inner loop's own hit handling below splices `monsters`
        // mid-iteration, which would silently skip an element if we iterated
        // the live array directly.
        for (const m of [...monsters]) {
          if (!bulletEids.has(bulletEid)) return; // already consumed this frame
          applyToObjectByEid(m.eid, (monsterObj) => {
            const dx = bulletObj.position.x - monsterObj.position.x;
            const dy = bulletObj.position.y - monsterObj.position.y;
            if (dx * dx + dy * dy > HIT_RADIUS_SQ) return;
            engine.destroy_entity(bulletEid);
            engine.destroy_entity(m.eid);
            bulletEids.delete(bulletEid);
            const idx = monsters.indexOf(m);
            if (idx >= 0) monsters.splice(idx, 1);
          });
        }
      });
    }
  }

  function onRemoteEntityHit(_eid: number) {}

  await spawnMonsters(INITIAL_MONSTER_COUNT);

  function cleanup() {
    window.removeEventListener("keydown", onKeyDown);
    window.removeEventListener("keyup", onKeyUp);
    window.removeEventListener("mousedown", onMouseDown);
    document.removeEventListener("contextmenu", onContextMenu);
    unsubLifecycle();
    unsubNet();
    unsubHud();
  }

  return { playerEid, ownedEids, onRemoteEntityHit, spawnMonsters, onFrame, cleanup };
}
