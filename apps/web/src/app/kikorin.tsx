import {
  castEntityCollider,
  CoreFlags,
  ControlSources,
  destroyEntity,
  evaluateFlaginatorFlag,
  getCollisionBounceDelta,
  getContactBounceDelta,
  getTouchingEntities,
  getEntityForward,
  getYawFromXZDirection,
  hasEntityComponents,
  hasNetFlag,
  isProjectileType,
  KeyboardControls,
  markFlaginatorComponentChanged,
  NET,
  PointerControls,
  queryEntities,
  rotateLocalVectorByEntityRotation,
  rotateLocalVectorByYaw,
  setEntityPosition,
  setEntityRotation,
  setEntityVelocity,
  spawnEntity,
  type CoreWorld,
  type CoreWorldBox,
  type Player,
  type Position,
  type Rotation,
  type Vec3,
  type Velocity,
} from "@kikorin/engine";
import { castRayFromTo, findHighestFloorTopAtPosition } from "@kikorin/system-physics";
import { NavMesh, findPath, type Waypoint } from "@kikorin/system-pathfinding";
import { clamp, rng } from "@kikorin/util";
import {
  BoxGeometry,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshLambertMaterial,
  SphereGeometry,
} from "three";
import { PlayerReactControls } from "./kikorinControls";
import { eventBus } from "@kikorin/events";

const PERSON_COLLIDER = {
  halfWidth: 0.5,
  halfHeight: 0.5,
  halfDepth: 0.5,
};
const PERSON_GEOMETRY = new BoxGeometry(
  PERSON_COLLIDER.halfWidth * 2,
  PERSON_COLLIDER.halfHeight * 2,
  PERSON_COLLIDER.halfDepth * 2,
);
const PERSON_EDGE_GEOMETRY = new EdgesGeometry(PERSON_GEOMETRY);
const PERSON_BODY_COLOR = 0x66ccff;
const PERSON_FRONT_COLOR = 0xffe082;
const PERSON_TOUCH_COLOR = 0xff6b3d;
const PERSON_TOUCH_FRONT_COLOR = 0xffc46b;
const PERSON_EDGE_MATERIAL = new LineBasicMaterial({ color: 0x16324f });
const PROJECTILE_RADIUS = 0.12;
const PROJECTILE_SCALE = {
  x: 0.82,
  y: 0.82,
  z: 1.35,
};
const PROJECTILE_COLLIDER = {
  halfWidth: PROJECTILE_RADIUS * PROJECTILE_SCALE.x,
  halfHeight: PROJECTILE_RADIUS * PROJECTILE_SCALE.y,
  halfDepth: PROJECTILE_RADIUS * PROJECTILE_SCALE.z,
};
const PROJECTILE_GEOMETRY = new SphereGeometry(PROJECTILE_RADIUS, 14, 10);
const PROJECTILE_BODY_COLOR = 0xf97316;
const PROJECTILE_TOUCH_COLOR = 0xea580c;
const PROJECTILE_BASE_MATERIAL = new MeshLambertMaterial({
  color: PROJECTILE_BODY_COLOR,
});
const PROJECTILE_TOUCH_MATERIAL = new MeshLambertMaterial({
  color: PROJECTILE_TOUCH_COLOR,
});
const FLOOR_COLLIDER = {
  halfWidth: 240,
  halfHeight: 1,
  halfDepth: 240,
};
const FLOOR_TOP_Y = 0;
const FLOOR_GEOMETRY = new BoxGeometry(
  FLOOR_COLLIDER.halfWidth * 2,
  FLOOR_COLLIDER.halfHeight * 2,
  FLOOR_COLLIDER.halfDepth * 2,
);
const FLOOR_EDGE_GEOMETRY = new EdgesGeometry(FLOOR_GEOMETRY);
const FLOOR_BASE_MATERIAL = new MeshLambertMaterial({ color: 0x445342 });
const FLOOR_EDGE_MATERIAL = new LineBasicMaterial({ color: 0x243022 });
const FLOOR_POSITION = {
  x: 0,
  y: FLOOR_TOP_Y - FLOOR_COLLIDER.halfHeight,
  z: 0,
};
const WALL_BASE_MATERIAL = new MeshLambertMaterial({ color: 0xb0a090 });
const WALL_EDGE_MATERIAL = new LineBasicMaterial({ color: 0x5a4a3a });
const RAMP_BASE_MATERIAL = new MeshLambertMaterial({ color: 0x6a7f55 });
const RAMP_EDGE_MATERIAL = new LineBasicMaterial({ color: 0x3a4f35 });
const STEP_BASE_MATERIAL = new MeshLambertMaterial({ color: 0x8a9a7a });
const STEP_EDGE_MATERIAL = new LineBasicMaterial({ color: 0x4a5a3a });
const PLAYER_ACCELERATION = 30;
const PLAYER_MAX_SPEED = 18;
const PLAYER_DRAG_PER_SECOND = 4;
const PLAYER_JUMP_SPEED = 8;
const PLAYER_FORWARD_BOOST = 10;
const PLAYER_SPRINT_ACCELERATION_MULTIPLIER = 1.8;
const PLAYER_SPRINT_MAX_SPEED_MULTIPLIER = 1.6;
const PLAYER_SPRINT_STAMINA_MAX = 1.0;
const PLAYER_SPRINT_DRAIN_PER_SECOND = 0.35;
const PLAYER_SPRINT_REGEN_PER_SECOND = 0.2;
const PLAYER_SPRINT_KEYS = [KeyboardControls.ShiftLeft];
const PLAYER_FORWARD_KEYS = [
  KeyboardControls.KeyW,
  KeyboardControls.ArrowUp,
];
const PLAYER_BACKWARD_KEYS = [
  KeyboardControls.KeyS,
  KeyboardControls.ArrowDown,
];
const PLAYER_STRAFE_LEFT_KEYS = [KeyboardControls.KeyQ];
const PLAYER_STRAFE_RIGHT_KEYS = [KeyboardControls.KeyE];
const PLAYER_LOOK_LEFT_KEYS = [
  KeyboardControls.KeyA,
  KeyboardControls.ArrowLeft,
];
const PLAYER_LOOK_RIGHT_KEYS = [
  KeyboardControls.KeyD,
  KeyboardControls.ArrowRight,
];
const PLAYER_PITCH_UP_KEYS = [KeyboardControls.KeyI];
const PLAYER_PITCH_DOWN_KEYS = [KeyboardControls.KeyK];
const PLAYER_PITCH_SPEED = 1.5;
const MOUSE_PITCH_SENSITIVITY = 0.003;
const MOUSE_YAW_SENSITIVITY = 0.003;
const PLAYER_YAW_SPEED = 1.5;
const PLAYER_MAX_PITCH = Math.PI * 0.45;
const PROJECTILE_SPEED = 42;
const PROJECTILE_TTL_TICKS = 84;
const PROJECTILE_FORWARD_SPAWN_OFFSET =
  PERSON_COLLIDER.halfDepth + PROJECTILE_COLLIDER.halfDepth + 0.24;
const PROJECTILE_SPAWN_HEIGHT = PERSON_COLLIDER.halfHeight * 0.35;
const PROJECTILE_BOUNCE_REPEAT_COOLDOWN_TICKS = 6;
const PROJECTILE_SWEEP_REWIND_TOI = 0.002;
const PROJECTILE_BOUNCE_SEPARATION_DISTANCE = 0.04;
const PROJECTILE_FALLBACK_BOUNCE_RESTITUTION = 0.8;
const CROSSHAIR_MAX_DIST = 120;
const AMBIENT_PERSON_COUNT = 30;
const BOX_MIN_SPEED = 2;
const BOX_MAX_SPEED = 5;
const BOX_MAX_STEER_RADIANS_PER_SECOND = 1.5;
// At max misalignment (180°), speed drops to this fraction and turn rate scales up by (1 + this).
const BOX_STEER_SPEED_MIN_FRACTION = 0.35;
const BOX_STEER_TURN_BOOST = 1.5;
// Monsters repel each other when closer than this distance (monsters are 1 unit wide).
const MONSTER_SEPARATION_RADIUS = 2.5;
const MONSTER_SEPARATION_STRENGTH = 0;
// Monsters probe ahead for walls and steer away before hitting them.
const WALL_AVOIDANCE_LOOKAHEAD = 4.0;
const WALL_AVOIDANCE_STRENGTH = 4.0;
// Path-following: advance to next waypoint once within this horizontal distance.
const MONSTER_WAYPOINT_REACH = 1.8;
// Seconds between A* replans per monster.
const MONSTER_REPLAN_INTERVAL = 0.5;
// Upward velocity applied to step up a staircase.
const MONSTER_JUMP_SPEED = 9.0;
// Horizontal proximity to a jump waypoint at which the impulse fires.
const MONSTER_JUMP_TRIGGER_DIST = 2.5;
// Seconds before a monster can jump again (avoids repeated impulses in mid-air).
const MONSTER_JUMP_COOLDOWN = 0.9;
// Per-monster goal offset radius (world units) for sub-optimal path variety.
const MONSTER_GOAL_JITTER_RADIUS = 8;
// How long a monster keeps the same path bias before picking a new one (seconds).
const MONSTER_GOAL_JITTER_INTERVAL_MIN = 2.0;
const MONSTER_GOAL_JITTER_INTERVAL_MAX = 5.0;
// Distance range over which the goal bias fades out — full variety far away, none up close.
const MONSTER_GOAL_BIAS_FADE_START = 22;
const MONSTER_GOAL_BIAS_FADE_END = 8;
// Stuck detection: how often to sample position, minimum movement to be "not stuck",
// and how long stuck samples must accumulate before triggering an escape.
const MONSTER_STUCK_SAMPLE_INTERVAL = 0.8;
const MONSTER_STUCK_MOVE_THRESHOLD = 0.5;
const MONSTER_STUCK_ESCAPE_AFTER = 1.6;
// Goal offset magnitude applied when breaking out of a stuck state.
const MONSTER_STUCK_ESCAPE_RADIUS = 14;
const PRIME_SPAWN_POSITION = { x: 0, y: 12, z: 0 };
const PRIME_PLAYER_NAME = "DoomPrime";

function createPersonFaceMaterials(bodyColor: number, frontColor: number) {
  return [
    ...Array.from({ length: 5 }, () => {
      return new MeshLambertMaterial({ color: bodyColor });
    }),
    // BoxGeometry groups are +X, -X, +Y, -Y, +Z, -Z. This project treats -Z as forward.
    new MeshLambertMaterial({ color: frontColor }),
  ];
}

const PERSON_BASE_MATERIALS = createPersonFaceMaterials(
  PERSON_BODY_COLOR,
  PERSON_FRONT_COLOR,
);
const PERSON_TOUCH_MATERIALS = createPersonFaceMaterials(
  PERSON_TOUCH_COLOR,
  PERSON_TOUCH_FRONT_COLOR,
);
type World = CoreWorld;

type OwnershipCallbacks = {
  addOwnedEntity: (eid: number) => void;
  removeOwnedEntity: (eid: number) => void;
  signalEntityDestroyed: (eid: number) => void;
  signalHitOnRemoteEntity: (localMirrorEid: number) => void;
};

type FloorEids = ArrayLike<number>;
type MonsterPathState = {
  path: Waypoint[] | null;
  waypointIndex: number;
  timeSinceReplan: number;
  jumpCooldown: number;
  goalBiasX: number;
  goalBiasZ: number;
  timeSinceJitter: number;
  jitterInterval: number;
  stuckTimer: number;
  lastSampleX: number;
  lastSampleZ: number;
  stuckSampleTimer: number;
};
type ProjectileState = {
  remainingTicks: number;
  bounceCooldownsByTarget: Map<number, number>;
};
type ProjectileRegistry = Map<number, ProjectileState>;

function createPersonRenderMesh() {
  const mesh = new Mesh(PERSON_GEOMETRY, PERSON_BASE_MATERIALS);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const outline = new LineSegments(PERSON_EDGE_GEOMETRY, PERSON_EDGE_MATERIAL);
  outline.renderOrder = 1;
  outline.scale.setScalar(1.001);
  mesh.userData.baseMaterial = PERSON_BASE_MATERIALS;
  mesh.userData.touchMaterial = PERSON_TOUCH_MATERIALS;
  mesh.add(outline);
  return mesh;
}

function createFloorRenderMesh() {
  const mesh = new Mesh(FLOOR_GEOMETRY, FLOOR_BASE_MATERIAL);
  mesh.receiveShadow = true;
  const outline = new LineSegments(FLOOR_EDGE_GEOMETRY, FLOOR_EDGE_MATERIAL);
  outline.renderOrder = 1;
  outline.scale.setScalar(1.0005);
  mesh.add(outline);
  return mesh;
}

function createWallRenderMesh(halfWidth: number, halfHeight: number, halfDepth: number) {
  const geometry = new BoxGeometry(halfWidth * 2, halfHeight * 2, halfDepth * 2);
  const edgeGeometry = new EdgesGeometry(geometry);
  const mesh = new Mesh(geometry, WALL_BASE_MATERIAL);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const outline = new LineSegments(edgeGeometry, WALL_EDGE_MATERIAL);
  outline.renderOrder = 1;
  outline.scale.setScalar(1.0005);
  mesh.add(outline);
  return mesh;
}

function createWall(
  world: World,
  position: Position,
  halfWidth: number,
  halfHeight: number,
  halfDepth: number,
) {
  return spawnEntity(world, {
    floor: true,
    position,
    collider: { halfWidth, halfHeight, halfDepth },
    renderMesh: () => createWallRenderMesh(halfWidth, halfHeight, halfDepth),
  });
}


function createProjectileRenderMesh() {
  const mesh = new Mesh(PROJECTILE_GEOMETRY, PROJECTILE_BASE_MATERIAL);
  mesh.castShadow = true;
  mesh.scale.set(
    PROJECTILE_SCALE.x,
    PROJECTILE_SCALE.y,
    PROJECTILE_SCALE.z,
  );
  mesh.userData.baseMaterial = PROJECTILE_BASE_MATERIAL;
  mesh.userData.touchMaterial = PROJECTILE_TOUCH_MATERIAL;
  return mesh;
}

function createMonsterPathState(timeSinceReplan = 0): MonsterPathState {
  const angle = rng(0, Math.PI * 2);
  const dist = rng(3, MONSTER_GOAL_JITTER_RADIUS);
  return {
    path: null,
    waypointIndex: 0,
    timeSinceReplan,
    jumpCooldown: 0,
    goalBiasX: Math.cos(angle) * dist,
    goalBiasZ: Math.sin(angle) * dist,
    timeSinceJitter: rng(0, MONSTER_GOAL_JITTER_INTERVAL_MAX),
    jitterInterval: rng(MONSTER_GOAL_JITTER_INTERVAL_MIN, MONSTER_GOAL_JITTER_INTERVAL_MAX),
    stuckTimer: 0,
    lastSampleX: Infinity,
    lastSampleZ: Infinity,
    stuckSampleTimer: rng(0, MONSTER_STUCK_SAMPLE_INTERVAL),
  };
}

function registerBoxSteering(
  world: CoreWorld,
  boxEids: number[],
  baseSpeeds: Map<number, number>,
  primeEid: number,
  navmesh: NavMesh,
  pathStates: Map<number, MonsterPathState>,
): () => void {
  return world.controls.onTick((activeWorld, tick) => {
    if (tick.deltaSeconds === 0) return;
    if (!hasEntityComponents(activeWorld, primeEid, ["Position"])) return;

    const { Position, Velocity, Collider, Floor, Gravity } = activeWorld.components;
    const targetX = Position.x[primeEid];
    const targetZ = Position.z[primeEid];
    // Predict where the player will be shortly — monsters cut off movement instead of trailing.
    const goalX = targetX + Velocity.x[primeEid] * 0.4;
    const goalZ = targetZ + Velocity.z[primeEid] * 0.4;
    const maxSteer = BOX_MAX_STEER_RADIANS_PER_SECOND * tick.deltaSeconds;

    for (const eid of boxEids) {
      if (!hasEntityComponents(activeWorld, eid, ["Position", "Velocity"])) continue;

      const currentSpeed = Math.hypot(Velocity.x[eid], Velocity.z[eid]);
      if (currentSpeed === 0) continue;

      const monsterX = Position.x[eid];
      const monsterZ = Position.z[eid];
      const dx = targetX - monsterX;
      const dz = targetZ - monsterZ;
      const distToTarget = Math.hypot(dx, dz);
      if (distToTarget === 0) continue;

      // Desired direction from A* waypoints inside the navmesh, direct pursuit outside.
      let desiredX: number;
      let desiredZ: number;

      const pathState = pathStates.get(eid);
      if (pathState !== undefined && navmesh.inBounds(monsterX, monsterZ)) {
        pathState.jumpCooldown = Math.max(0, pathState.jumpCooldown - tick.deltaSeconds);
        pathState.timeSinceReplan += tick.deltaSeconds;

        // Rotate path bias on schedule so each monster takes a different sub-optimal route.
        pathState.timeSinceJitter += tick.deltaSeconds;
        if (pathState.timeSinceJitter >= pathState.jitterInterval) {
          const angle = rng(0, Math.PI * 2);
          const dist = rng(3, MONSTER_GOAL_JITTER_RADIUS);
          pathState.goalBiasX = Math.cos(angle) * dist;
          pathState.goalBiasZ = Math.sin(angle) * dist;
          pathState.timeSinceJitter = 0;
          pathState.jitterInterval = rng(MONSTER_GOAL_JITTER_INTERVAL_MIN, MONSTER_GOAL_JITTER_INTERVAL_MAX);
          pathState.timeSinceReplan = MONSTER_REPLAN_INTERVAL;
        }

        // Stuck detection: sample position periodically; if stuck for long enough, pick a
        // random escape direction and force an immediate replan via a large goal bias.
        pathState.stuckSampleTimer += tick.deltaSeconds;
        if (pathState.stuckSampleTimer >= MONSTER_STUCK_SAMPLE_INTERVAL) {
          pathState.stuckSampleTimer = 0;
          const displacement = Math.hypot(monsterX - pathState.lastSampleX, monsterZ - pathState.lastSampleZ);
          if (displacement < MONSTER_STUCK_MOVE_THRESHOLD) {
            pathState.stuckTimer += MONSTER_STUCK_SAMPLE_INTERVAL;
            if (pathState.stuckTimer >= MONSTER_STUCK_ESCAPE_AFTER) {
              const escapeAngle = rng(0, Math.PI * 2);
              pathState.goalBiasX = Math.cos(escapeAngle) * MONSTER_STUCK_ESCAPE_RADIUS;
              pathState.goalBiasZ = Math.sin(escapeAngle) * MONSTER_STUCK_ESCAPE_RADIUS;
              pathState.stuckTimer = 0;
              pathState.timeSinceReplan = MONSTER_REPLAN_INTERVAL;
            }
          } else {
            pathState.stuckTimer = 0;
          }
          pathState.lastSampleX = monsterX;
          pathState.lastSampleZ = monsterZ;
        }

        if (pathState.path === null || pathState.timeSinceReplan >= MONSTER_REPLAN_INTERVAL) {
          const monsterFloorY = Position.y[eid] - PERSON_COLLIDER.halfHeight;
          const biasScale = clamp(
            (distToTarget - MONSTER_GOAL_BIAS_FADE_END) / (MONSTER_GOAL_BIAS_FADE_START - MONSTER_GOAL_BIAS_FADE_END),
            0, 1,
          );
          pathState.path = findPath(navmesh, monsterX, monsterZ, goalX + pathState.goalBiasX * biasScale, goalZ + pathState.goalBiasZ * biasScale, monsterFloorY);
          pathState.waypointIndex = 0;
          pathState.timeSinceReplan = 0;
        }

        const path = pathState.path;
        if (path !== null && path.length > 0 && pathState.waypointIndex < path.length) {
          // Advance past waypoints already reached.
          while (pathState.waypointIndex < path.length) {
            const wp = path[pathState.waypointIndex]!;
            if (Math.hypot(wp.x - monsterX, wp.z - monsterZ) >= MONSTER_WAYPOINT_REACH) break;
            pathState.waypointIndex++;
          }

          // Path exhausted — force replan on next tick.
          if (pathState.waypointIndex >= path.length) {
            pathState.timeSinceReplan = MONSTER_REPLAN_INTERVAL;
          }

          if (pathState.waypointIndex < path.length) {
            const wp = path[pathState.waypointIndex]!;
            const wpDX = wp.x - monsterX;
            const wpDZ = wp.z - monsterZ;
            const wpHorizDist = Math.hypot(wpDX, wpDZ);

            desiredX = wpHorizDist > 0 ? wpDX / wpHorizDist : dx / distToTarget;
            desiredZ = wpHorizDist > 0 ? wpDZ / wpHorizDist : dz / distToTarget;

            // Fire jump impulse when approaching a step-up waypoint while grounded.
            if (
              wp.requiresJump &&
              pathState.jumpCooldown <= 0 &&
              Gravity.Grounded[eid] === 1 &&
              wpHorizDist < MONSTER_JUMP_TRIGGER_DIST
            ) {
              setEntityVelocity(activeWorld, eid, {
                x: Velocity.x[eid],
                y: MONSTER_JUMP_SPEED,
                z: Velocity.z[eid],
              });
              pathState.jumpCooldown = MONSTER_JUMP_COOLDOWN;
            }
          } else {
            desiredX = dx / distToTarget;
            desiredZ = dz / distToTarget;
          }
        } else {
          desiredX = dx / distToTarget;
          desiredZ = dz / distToTarget;
        }
      } else {
        desiredX = dx / distToTarget;
        desiredZ = dz / distToTarget;
      }
      for (const otherId of boxEids) {
        if (otherId === eid) continue;
        const odx = Position.x[eid] - Position.x[otherId];
        const odz = Position.z[eid] - Position.z[otherId];
        const dist = Math.hypot(odx, odz);
        if (dist === 0 || dist >= MONSTER_SEPARATION_RADIUS) continue;
        const strength = MONSTER_SEPARATION_STRENGTH * (1 - dist / MONSTER_SEPARATION_RADIUS);
        desiredX += (odx / dist) * strength;
        desiredZ += (odz / dist) * strength;
      }

      // Wall avoidance: probe ahead in the desired direction; push away from any wall found.
      const desiredLen = Math.hypot(desiredX, desiredZ);
      if (desiredLen > 0) {
        const probeX = (desiredX / desiredLen) * WALL_AVOIDANCE_LOOKAHEAD;
        const probeZ = (desiredZ / desiredLen) * WALL_AVOIDANCE_LOOKAHEAD;
        const monsterPos = { x: Position.x[eid], y: Position.y[eid], z: Position.z[eid] };
        const wallHit = castEntityCollider(activeWorld, eid, monsterPos, { x: probeX, y: 0, z: probeZ }, {
          filterPredicate: (targetEid) =>
            !Floor[targetEid] &&
            !Collider.Sensor[targetEid] &&
            !hasEntityComponents(activeWorld, targetEid, ["Player"]) &&
            !isProjectileType(activeWorld, targetEid),
        });
        if (wallHit) {
          const strength = WALL_AVOIDANCE_STRENGTH * (1 - wallHit.toi);
          desiredX += wallHit.normal1.x * strength;
          desiredZ += wallHit.normal1.z * strength;
        }
      }

      const currentAngle = Math.atan2(Velocity.x[eid], Velocity.z[eid]);
      const targetAngle = Math.atan2(desiredX, desiredZ);
      let angleDiff = targetAngle - currentAngle;
      if (angleDiff > Math.PI) angleDiff -= Math.PI * 2;
      else if (angleDiff < -Math.PI) angleDiff += Math.PI * 2;

      // Scale turn rate up and speed down proportionally to misalignment angle.
      // A monster facing away slows to BOX_STEER_SPEED_MIN_FRACTION and turns tighter.
      // baseSpeed is the monster's intended full speed; targetSpeed recovers toward it as
      // the monster re-aligns, so slow-down from turning doesn't compound across ticks.
      const angleFraction = Math.abs(angleDiff) / Math.PI; // 0 = on-target, 1 = fully reversed
      const boostedMaxSteer = maxSteer * (1 + angleFraction * BOX_STEER_TURN_BOOST);
      const steer = clamp(angleDiff, -boostedMaxSteer, boostedMaxSteer);
      const baseSpeed = baseSpeeds.get(eid) ?? currentSpeed;
      const targetSpeed = baseSpeed * (1 - angleFraction * (1 - BOX_STEER_SPEED_MIN_FRACTION));

      if (steer === 0 && Math.abs(currentSpeed - targetSpeed) < 0.01) continue;

      const newAngle = currentAngle + steer;
      setEntityVelocity(activeWorld, eid, {
        x: Math.sin(newAngle) * targetSpeed,
        y: Velocity.y[eid],
        z: Math.cos(newAngle) * targetSpeed,
      });
    }
  });
}

function spawnEdgeMonster(
  world: World,
  floorEids: FloorEids,
  name: string,
  baseSpeeds: Map<number, number>,
): number {
  const EDGE_INSET = 8;
  const maxX = FLOOR_COLLIDER.halfWidth - EDGE_INSET;
  const maxZ = FLOOR_COLLIDER.halfDepth - EDGE_INSET;

  // Pick one of four edges: 0=North, 1=South, 2=East, 3=West
  const side = Math.floor(rng(0, 3.99));
  const x = side < 2 ? rng(-maxX, maxX) : side === 2 ? maxX : -maxX;
  const z = side >= 2 ? rng(-maxZ, maxZ) : side === 0 ? -maxZ : maxZ;

  const position = { x, y: FLOOR_TOP_Y + 4, z };
  const dx = -x;
  const dz = -z;
  const len = Math.hypot(dx, dz);
  const speed = rng(BOX_MIN_SPEED, BOX_MAX_SPEED, 1);
  const velocity = len > 0
    ? { x: (dx / len) * speed, y: 0, z: (dz / len) * speed }
    : { x: 0, y: 0, z: -speed };

  const eid = createPerson(
    world,
    position,
    velocity,
    { pitch: 0, yaw: getYawFromXZDirection(velocity.x, velocity.z), roll: 0 },
    true,
    100,
    { level: 0, experience: 0, name },
    floorEids,
  );
  baseSpeeds.set(eid, speed);
  return eid;
}

function setupGame(
  engine: CoreWorldBox,
  ownership: OwnershipCallbacks,
): { playerEid: number; ownedEids: number[]; onRemoteEntityHit: (eid: number) => void } {
  createFloor(engine.world, FLOOR_POSITION);
  spawnTerrain(engine.world);

  const floorEids = queryFloorEids(engine.world);
  // Build the navmesh once after terrain is spawned. Monsters inside its bounds
  // use A* to navigate ramps, stairs, and ledges; outside they fall back to direct pursuit.
  const navmesh = new NavMesh(engine.world, floorEids);
  let primeEid = createPrimePlayer(engine.world, floorEids);
  engine.setCameraFollowTarget(primeEid);

  const baseSpeeds = new Map<number, number>();
  const pathStates = new Map<number, MonsterPathState>();
  const boxEids = spawnAmbientPeople(engine.world, floorEids, baseSpeeds);
  // Stagger initial replans so 30 monsters don't all run A* on the same tick.
  for (let i = 0; i < boxEids.length; i++) {
    pathStates.set(boxEids[i]!, createMonsterPathState(i * (MONSTER_REPLAN_INTERVAL / boxEids.length)));
  }
  let nextMonsterIndex = boxEids.length;

  const onMonsterHit = (world: CoreWorld, monsterEid: number) => {
    const idx = boxEids.indexOf(monsterEid);
    if (idx !== -1) boxEids.splice(idx, 1);
    baseSpeeds.delete(monsterEid);
    pathStates.delete(monsterEid);
    ownership.signalEntityDestroyed(monsterEid);
    destroyEntity(world, monsterEid);

    const newEid = spawnEdgeMonster(world, floorEids, `Doom${nextMonsterIndex++}`, baseSpeeds);
    boxEids.push(newEid);
    pathStates.set(newEid, createMonsterPathState());
    ownership.addOwnedEntity(newEid);
  };

  const onDebugMonsterHit = (world: CoreWorld, monsterEid: number) => {
    const { Position, Velocity, Rotation, Health, Player } = world.components;
    const pathState = pathStates.get(monsterEid);
    const baseSpeed = baseSpeeds.get(monsterEid);
    console.log("[DEBUG MONSTER]", {
      eid: monsterEid,
      name: Player[monsterEid]?.name,
      health: Health[monsterEid],
      baseSpeed,
      position: {
        x: Position.x[monsterEid],
        y: Position.y[monsterEid],
        z: Position.z[monsterEid],
      },
      velocity: {
        x: Velocity.x[monsterEid],
        y: Velocity.y[monsterEid],
        z: Velocity.z[monsterEid],
      },
      rotation: {
        pitch: Rotation.pitch[monsterEid],
        yaw: Rotation.yaw[monsterEid],
        roll: Rotation.roll[monsterEid],
      },
      pathState: pathState
        ? {
            waypointIndex: pathState.waypointIndex,
            totalWaypoints: pathState.path?.length ?? 0,
            timeSinceReplan: pathState.timeSinceReplan,
            jumpCooldown: pathState.jumpCooldown,
            goalBias: { x: pathState.goalBiasX, z: pathState.goalBiasZ },
            timeSinceJitter: pathState.timeSinceJitter,
            jitterInterval: pathState.jitterInterval,
            stuckTimer: pathState.stuckTimer,
            stuckSampleTimer: pathState.stuckSampleTimer,
            path: pathState.path,
          }
        : null,
    });
  };

  let cleanupPrimeControls = registerPrimeControls(engine.world, primeEid, ownership, onMonsterHit, onDebugMonsterHit);
  let cleanupBoxSteering = registerBoxSteering(engine.world, boxEids, baseSpeeds, primeEid, navmesh, pathStates);

  engine.world.controls.onTick((activeWorld) => {
    if (hasEntityComponents(activeWorld, primeEid, ["Player"])) return;

    cleanupPrimeControls();
    cleanupBoxSteering();

    primeEid = createPrimePlayer(activeWorld, floorEids);
    engine.setCameraFollowTarget(primeEid);
    ownership.addOwnedEntity(primeEid);
    cleanupPrimeControls = registerPrimeControls(activeWorld, primeEid, ownership, onMonsterHit, onDebugMonsterHit);
    cleanupBoxSteering = registerBoxSteering(activeWorld, boxEids, baseSpeeds, primeEid, navmesh, pathStates);
  });

  return {
    playerEid: primeEid,
    ownedEids: [primeEid, ...boxEids],
    onRemoteEntityHit: (eid: number) => onMonsterHit(engine.world, eid),
  };
}

function queryFloorEids(world: World): FloorEids {
  return queryEntities(world, ["Floor", "Position", "Rotation", "Collider"]);
}

function createPrimePlayer(world: CoreWorld, floorEids: FloorEids) {
  return createPerson(
    world,
    PRIME_SPAWN_POSITION,
    { x: 0, y: 0, z: 0 },
    { pitch: 0, yaw: 0, roll: 0 },
    false,
    100,
    { level: 0, experience: 0, name: PRIME_PLAYER_NAME },
    floorEids,
  );
}

function spawnAmbientPeople(
  world: CoreWorld,
  floorEids: FloorEids,
  baseSpeeds: Map<number, number>,
  count = AMBIENT_PERSON_COUNT,
): number[] {
  const spawnRangeX = FLOOR_COLLIDER.halfWidth - 4;
  const spawnRangeZ = FLOOR_COLLIDER.halfDepth - 4;
  const eids: number[] = [];

  for (let i = 0; i < count; i += 1) {
    const position = {
      x: rng(-spawnRangeX, spawnRangeX),
      y: rng(FLOOR_TOP_Y + 4, FLOOR_TOP_Y + 60),
      z: rng(-spawnRangeZ, spawnRangeZ),
    };

    const dx = PRIME_SPAWN_POSITION.x - position.x;
    const dz = PRIME_SPAWN_POSITION.z - position.z;
    const len = Math.hypot(dx, dz);
    const speed = rng(BOX_MIN_SPEED, BOX_MAX_SPEED, 1);
    const velocity = len > 0
      ? { x: (dx / len) * speed, y: 0, z: (dz / len) * speed }
      : { x: 0, y: 0, z: -speed };

    const eid = createPerson(
      world,
      position,
      velocity,
      {
        pitch: 0,
        yaw: getYawFromXZDirection(velocity.x, velocity.z),
        roll: 0,
      },
      true,
      100,
      {
        level: 0,
        experience: 0,
        name: `Doom${i}`,
      },
      floorEids,
    );
    baseSpeeds.set(eid, speed);
    eids.push(eid);
  }

  return eids;
}

function registerPrimeControls(
  world: CoreWorld,
  eid: number,
  ownership: OwnershipCallbacks,
  onMonsterHit: (world: CoreWorld, monsterEid: number) => void,
  onDebugMonsterHit: (world: CoreWorld, monsterEid: number) => void,
): () => void {
  const projectiles: ProjectileRegistry = new Map();
  const debugProjectiles = new Set<number>();

  const isControllingPrime = (activeWorld: CoreWorld) => {
    return (
      hasEntityComponents(activeWorld, eid, [
        "Player",
        "Velocity",
        "Rotation",
        "Gravity",
      ]) && activeWorld.components.Player[eid]?.name === PRIME_PLAYER_NAME
    );
  };

  const jump = (activeWorld: CoreWorld) => {
    if (!isControllingPrime(activeWorld)) return;

    const { Gravity, Velocity } = activeWorld.components;
    const isGrounded = evaluateFlaginatorFlag(activeWorld, CoreFlags.OnGround, eid);
    if (!isGrounded && airJumpsUsed >= 1) return;

    Velocity.y[eid] = clamp(
      PLAYER_JUMP_SPEED,
      -PLAYER_MAX_SPEED,
      PLAYER_MAX_SPEED,
    );
    Gravity.Grounded[eid] = 0;
    if (!isGrounded) airJumpsUsed++;
    markFlaginatorComponentChanged(activeWorld, "Velocity", eid);
    markFlaginatorComponentChanged(activeWorld, "Gravity", eid);
  };

  const fireProjectile = (activeWorld: CoreWorld, debug = false) => {
    if (
      !hasEntityComponents(activeWorld, eid, [
        "Position",
        "Rotation",
        "Velocity",
      ])
    ) {
      return;
    }

    const { Position, Rotation } = activeWorld.components;
    const forward = getEntityForward(activeWorld, eid);
    const spawnPosition = clampSpawnPositionToFloor(
      activeWorld,
      {
        x:
          Position.x[eid] + forward.x * PROJECTILE_FORWARD_SPAWN_OFFSET,
        y:
          Position.y[eid] +
          PROJECTILE_SPAWN_HEIGHT +
          forward.y * PROJECTILE_FORWARD_SPAWN_OFFSET,
        z:
          Position.z[eid] + forward.z * PROJECTILE_FORWARD_SPAWN_OFFSET,
      },
      PROJECTILE_COLLIDER.halfHeight,
    );
    const projectileEid = spawnEntity(activeWorld, {
      position: spawnPosition,
      velocity: {
        x: forward.x * PROJECTILE_SPEED,
        y: forward.y * PROJECTILE_SPEED,
        z: forward.z * PROJECTILE_SPEED,
      },
      rotation: {
        pitch: Rotation.pitch[eid],
        yaw: Rotation.yaw[eid],
        roll: 0,
      },
      // PROJECTILE marks entity type (bullet mesh on remote, life/death signaling).
      // addOwnedEntity below adds OWNED|SHARED so state is broadcast to peers.
      netFlags: NET.PROJECTILE,
      collider: PROJECTILE_COLLIDER,
      renderMesh: createProjectileRenderMesh,
    });

    projectiles.set(projectileEid, {
      remainingTicks: PROJECTILE_TTL_TICKS,
      bounceCooldownsByTarget: new Map(),
    });
    if (debug) debugProjectiles.add(projectileEid);
    ownership.addOwnedEntity(projectileEid);
  };

  const updateProjectiles = (
    activeWorld: CoreWorld,
    deltaSeconds: number,
  ) => {
    const { Position, Velocity } = activeWorld.components;
    // Only monsters (non-prime players) should be hit by projectiles.
    const isMonsterPlayer = (t: number) =>
      hasEntityComponents(activeWorld, t, ["Player"]) &&
      activeWorld.components.Player[t]?.name !== PRIME_PLAYER_NAME;

    for (const [projectileEid, projectile] of projectiles) {
      if (
        !hasEntityComponents(activeWorld, projectileEid, [
          "Position",
          "Rotation",
          "Velocity",
          "Collider",
        ])
      ) {
        ownership.signalEntityDestroyed(projectileEid);
        debugProjectiles.delete(projectileEid);
        projectiles.delete(projectileEid);
        continue;
      }

      updateProjectileBounceCooldowns(projectile);
      projectile.remainingTicks -= 1;
      if (projectile.remainingTicks <= 0) {
        ownership.signalEntityDestroyed(projectileEid);
        destroyEntity(activeWorld, projectileEid);
        debugProjectiles.delete(projectileEid);
        projectiles.delete(projectileEid);
        continue;
      }

      const currentPosition = {
        x: Position.x[projectileEid],
        y: Position.y[projectileEid],
        z: Position.z[projectileEid],
      };
      const currentVelocity = {
        x: Velocity.x[projectileEid],
        y: Velocity.y[projectileEid],
        z: Velocity.z[projectileEid],
      };
      const isFreshBounceTarget = (targetEid: number) => {
        return (
          targetEid !== eid &&
          !isProjectileType(activeWorld, targetEid) &&
          (projectile.bounceCooldownsByTarget.get(targetEid) ?? 0) === 0
        );
      };

      // Overlap bounce: projectile is already inside something (tunneled last tick).
      // Compute the bounce fresh per-target using the actual contact normal so
      // stale accumulated suggestions from already-bounced surfaces don't corrupt
      // corner hits.
      const freshOverlapTargets = getTouchingEntities(activeWorld, projectileEid)
        .filter(isFreshBounceTarget);

      if (freshOverlapTargets.length > 0) {
        const hitOwnedMonster = freshOverlapTargets.find(t =>
          isMonsterPlayer(t) && hasNetFlag(activeWorld, t, NET.OWNED)
        );
        if (hitOwnedMonster !== undefined) {
          if (debugProjectiles.has(projectileEid)) {
            onDebugMonsterHit(activeWorld, hitOwnedMonster);
          } else {
            onMonsterHit(activeWorld, hitOwnedMonster);
          }
          debugProjectiles.delete(projectileEid);
          ownership.signalEntityDestroyed(projectileEid);
          destroyEntity(activeWorld, projectileEid);
          projectiles.delete(projectileEid);
          continue;
        }

        const hitRemoteMonster = freshOverlapTargets.find(t =>
          isMonsterPlayer(t) && !hasNetFlag(activeWorld, t, NET.OWNED)
        );
        if (hitRemoteMonster !== undefined) {
          if (debugProjectiles.has(projectileEid)) {
            onDebugMonsterHit(activeWorld, hitRemoteMonster);
          } else {
            ownership.signalHitOnRemoteEntity(hitRemoteMonster);
          }
          debugProjectiles.delete(projectileEid);
          ownership.signalEntityDestroyed(projectileEid);
          destroyEntity(activeWorld, projectileEid);
          projectiles.delete(projectileEid);
          continue;
        }

        let bouncedVelocity = currentVelocity;
        let didBounce = false;

        for (let i = 0; i < freshOverlapTargets.length; i += 1) {
          const bounceDelta = getContactBounceDelta(
            activeWorld,
            projectileEid,
            freshOverlapTargets[i]!,
          );
          if (!bounceDelta) continue;
          bouncedVelocity = addVectors(bouncedVelocity, bounceDelta);
          didBounce = true;
        }

        if (didBounce) {
          const separatedPosition = getProjectileSeparatedPosition(
            currentPosition,
            bouncedVelocity,
          );
          setEntityPosition(activeWorld, projectileEid, separatedPosition);
          setEntityVelocity(activeWorld, projectileEid, bouncedVelocity);
          faceEntityAlongVelocity(activeWorld, projectileEid, bouncedVelocity);

          for (let i = 0; i < freshOverlapTargets.length; i += 1) {
            projectile.bounceCooldownsByTarget.set(
              freshOverlapTargets[i]!,
              PROJECTILE_BOUNCE_REPEAT_COOLDOWN_TICKS,
            );
          }

          continue;
        }
      }

      if (deltaSeconds <= 0) {
        continue;
      }

      const movementDelta = scaleVector(currentVelocity, deltaSeconds);
      if (
        movementDelta.x === 0 &&
        movementDelta.y === 0 &&
        movementDelta.z === 0
      ) {
        continue;
      }

      const sweptHit = castEntityCollider(
        activeWorld,
        projectileEid,
        currentPosition,
        movementDelta,
        {
          filterPredicate: isFreshBounceTarget,
        },
      );
      if (sweptHit && isMonsterPlayer(sweptHit.colliderEid)) {
        if (debugProjectiles.has(projectileEid)) {
          onDebugMonsterHit(activeWorld, sweptHit.colliderEid);
        } else if (hasNetFlag(activeWorld, sweptHit.colliderEid, NET.OWNED)) {
          onMonsterHit(activeWorld, sweptHit.colliderEid);
        } else {
          ownership.signalHitOnRemoteEntity(sweptHit.colliderEid);
        }
        debugProjectiles.delete(projectileEid);
        ownership.signalEntityDestroyed(projectileEid);
        destroyEntity(activeWorld, projectileEid);
        projectiles.delete(projectileEid);
        continue;
      }

      if (!sweptHit) {
        setEntityPosition(activeWorld, projectileEid, {
          x: currentPosition.x + movementDelta.x,
          y: currentPosition.y + movementDelta.y,
          z: currentPosition.z + movementDelta.z,
        });
        continue;
      }

      const resolvedBounce = resolveProjectileSweepBounce(
        activeWorld,
        projectileEid,
        sweptHit.colliderEid,
        currentVelocity,
        {
          x: sweptHit.normal1.x,
          y: sweptHit.normal1.y,
          z: sweptHit.normal1.z,
        },
      );
      const correctedToi = clamp(
        sweptHit.toi - PROJECTILE_SWEEP_REWIND_TOI,
        0,
        1,
      );
      const impactPosition = {
        x: currentPosition.x + movementDelta.x * correctedToi,
        y: currentPosition.y + movementDelta.y * correctedToi,
        z: currentPosition.z + movementDelta.z * correctedToi,
      };
      if (!resolvedBounce) {
        setEntityPosition(activeWorld, projectileEid, impactPosition);
        continue;
      }

      const bouncedVelocity = addVectors(
        currentVelocity,
        resolvedBounce.bounceDelta,
      );
      const correctedPosition = getProjectileSeparatedPosition(
        impactPosition,
        bouncedVelocity,
      );
      setEntityPosition(activeWorld, projectileEid, correctedPosition);
      setEntityVelocity(activeWorld, projectileEid, bouncedVelocity);
      faceEntityAlongVelocity(activeWorld, projectileEid, bouncedVelocity);

      projectile.bounceCooldownsByTarget.set(
        sweptHit.colliderEid,
        PROJECTILE_BOUNCE_REPEAT_COOLDOWN_TICKS,
      );
    }
  };

  const unsubProjectiles = world.controls.onTick((activeWorld, tick) => {
    updateProjectiles(activeWorld, tick.deltaSeconds);
  });

  let sprintStamina = PLAYER_SPRINT_STAMINA_MAX;
  let lastEmittedSprintStamina = sprintStamina;
  let airJumpsUsed = 0;
  let wasGrounded = true;
  let pendingMousePitchDelta = 0;
  let pendingMouseYawDelta = 0;

  const unsubMousePitch = world.controls.on(
    { source: ControlSources.Pointer, controlId: PointerControls.Move, phase: "change" },
    (_activeWorld, event) => {
      if (typeof document === "undefined" || !document.pointerLockElement) return;
      const payload = event.payload as { movementX: number; movementY: number };
      pendingMousePitchDelta += payload.movementY;
      pendingMouseYawDelta -= payload.movementX;
    },
  );

  const unsubMovement = world.controls.onTick((activeWorld, tick, controls) => {
    if (!isControllingPrime(activeWorld)) return;

    const isGrounded = activeWorld.components.Gravity.Grounded[eid] === 1;
    if (isGrounded && !wasGrounded) airJumpsUsed = 0;
    wasGrounded = isGrounded;

    const dt = tick.deltaSeconds;
    if (dt === 0) return;

    const isSprinting =
      controls.isActive(KeyboardControls.ShiftLeft, ControlSources.Keyboard) &&
      sprintStamina > 0;

    if (isSprinting) {
      sprintStamina = Math.max(0, sprintStamina - PLAYER_SPRINT_DRAIN_PER_SECOND * dt);
    } else {
      sprintStamina = Math.min(
        PLAYER_SPRINT_STAMINA_MAX,
        sprintStamina + PLAYER_SPRINT_REGEN_PER_SECOND * dt,
      );
    }

    if (Math.abs(sprintStamina - lastEmittedSprintStamina) > 0.005) {
      eventBus.emit("ui:sprintStaminaUpdate", { stamina: sprintStamina });
      lastEmittedSprintStamina = sprintStamina;
    }

    const sprintAccel = isSprinting
      ? PLAYER_ACCELERATION * PLAYER_SPRINT_ACCELERATION_MULTIPLIER
      : PLAYER_ACCELERATION;
    const sprintMaxSpeed = isSprinting
      ? PLAYER_MAX_SPEED * PLAYER_SPRINT_MAX_SPEED_MULTIPLIER
      : PLAYER_MAX_SPEED;

    const drag = Math.max(0, 1 - PLAYER_DRAG_PER_SECOND * dt);
    const { Velocity, Rotation } = activeWorld.components;
    const previousVelocityX = Velocity.x[eid];
    const previousVelocityY = Velocity.y[eid];
    const previousVelocityZ = Velocity.z[eid];
    Velocity.x[eid] *= drag;
    Velocity.z[eid] *= drag;

    const isRightClickHeld = controls.isActive(PointerControls.Secondary, ControlSources.Pointer);
    const adStrafeAxis = isRightClickHeld
      ? controls.getAxis(PLAYER_LOOK_LEFT_KEYS, PLAYER_LOOK_RIGHT_KEYS, ControlSources.Keyboard)
      : 0;
    const localAcceleration = {
      x:
        (controls.getAxis(
          PLAYER_STRAFE_LEFT_KEYS,
          PLAYER_STRAFE_RIGHT_KEYS,
          ControlSources.Keyboard,
        ) + adStrafeAxis) * sprintAccel,
      y: 0,
      z:
        controls.getAxis(
          PLAYER_FORWARD_KEYS,
          PLAYER_BACKWARD_KEYS,
          ControlSources.Keyboard,
        ) * sprintAccel,
    };
    const pitchAxis = controls.getAxis(
      PLAYER_PITCH_DOWN_KEYS,
      PLAYER_PITCH_UP_KEYS,
      ControlSources.Keyboard,
    );
    const yawAxis = isRightClickHeld
      ? 0
      : controls.getAxis(
          PLAYER_LOOK_RIGHT_KEYS,
          PLAYER_LOOK_LEFT_KEYS,
          ControlSources.Keyboard,
        );
    const worldAcceleration = rotateLocalVectorByYaw(
      activeWorld,
      eid,
      localAcceleration,
    );

    Velocity.x[eid] = clamp(
      Velocity.x[eid] + worldAcceleration.x * dt,
      -sprintMaxSpeed,
      sprintMaxSpeed,
    );
    Velocity.y[eid] = clamp(
      Velocity.y[eid] + worldAcceleration.y * dt,
      -PLAYER_MAX_SPEED,
      PLAYER_MAX_SPEED,
    );
    Velocity.z[eid] = clamp(
      Velocity.z[eid] + worldAcceleration.z * dt,
      -sprintMaxSpeed,
      sprintMaxSpeed,
    );

    if (
      Velocity.x[eid] !== previousVelocityX ||
      Velocity.y[eid] !== previousVelocityY ||
      Velocity.z[eid] !== previousVelocityZ
    ) {
      markFlaginatorComponentChanged(activeWorld, "Velocity", eid);
    }

    const mousePitchDelta = pendingMousePitchDelta;
    pendingMousePitchDelta = 0;
    const mouseYawDelta = pendingMouseYawDelta;
    pendingMouseYawDelta = 0;

    if (pitchAxis === 0 && yawAxis === 0 && mousePitchDelta === 0 && mouseYawDelta === 0) return;

    const nextRotation: Partial<Rotation> = {};
    if (pitchAxis !== 0 || mousePitchDelta !== 0) {
      nextRotation.pitch = clamp(
        Rotation.pitch[eid] +
          pitchAxis * PLAYER_PITCH_SPEED * dt -
          mousePitchDelta * MOUSE_PITCH_SENSITIVITY,
        -PLAYER_MAX_PITCH,
        PLAYER_MAX_PITCH,
      );
    }
    if (yawAxis !== 0 || mouseYawDelta !== 0) {
      nextRotation.yaw = Rotation.yaw[eid] + yawAxis * PLAYER_YAW_SPEED * dt + mouseYawDelta * MOUSE_YAW_SENSITIVITY;
    }
    setEntityRotation(activeWorld, eid, nextRotation);
  });

  const unsubJump = world.controls.on(
    {
      source: ControlSources.Keyboard,
      controlId: KeyboardControls.Space,
      phase: "start",
    },
    (activeWorld) => {
      jump(activeWorld);
    },
  );

  const unsubBoost = world.controls.on(
    {
      source: ControlSources.React,
      controlId: PlayerReactControls.BoostForward,
      phase: "trigger",
    },
    (activeWorld) => {
      if (!isControllingPrime(activeWorld)) return;

      const { Velocity } = activeWorld.components;
      const forward = rotateLocalVectorByYaw(activeWorld, eid, { x: 0, y: 0, z: -1 });
      Velocity.x[eid] = clamp(
        Velocity.x[eid] + forward.x * PLAYER_FORWARD_BOOST,
        -PLAYER_MAX_SPEED,
        PLAYER_MAX_SPEED,
      );
      Velocity.z[eid] = clamp(
        Velocity.z[eid] + forward.z * PLAYER_FORWARD_BOOST,
        -PLAYER_MAX_SPEED,
        PLAYER_MAX_SPEED,
      );
      markFlaginatorComponentChanged(activeWorld, "Velocity", eid);
    },
  );

  const unsubFire = world.controls.on(
    {
      source: ControlSources.Pointer,
      controlId: PointerControls.Primary,
      phase: "trigger",
    },
    (activeWorld) => {
      if (!isControllingPrime(activeWorld)) return;
      fireProjectile(activeWorld);
    },
  );

  const unsubDebugFire = world.controls.on(
    {
      source: ControlSources.Keyboard,
      controlId: "Digit1",
      phase: "start",
    },
    (activeWorld) => {
      if (!isControllingPrime(activeWorld)) return;
      fireProjectile(activeWorld, true);
    },
  );

  const unsubCrosshair = world.controls.onTick((activeWorld) => {
    if (!isControllingPrime(activeWorld)) return;
    const { Position } = activeWorld.components;
    const forward = getEntityForward(activeWorld, eid);
    const spawnOrigin = clampSpawnPositionToFloor(
      activeWorld,
      {
        x: Position.x[eid]! + forward.x * PROJECTILE_FORWARD_SPAWN_OFFSET,
        y: Position.y[eid]! + PROJECTILE_SPAWN_HEIGHT + forward.y * PROJECTILE_FORWARD_SPAWN_OFFSET,
        z: Position.z[eid]! + forward.z * PROJECTILE_FORWARD_SPAWN_OFFSET,
      },
      PROJECTILE_COLLIDER.halfHeight,
    );
    const ox = spawnOrigin.x;
    const oy = spawnOrigin.y;
    const oz = spawnOrigin.z;
    const ex = ox + forward.x * CROSSHAIR_MAX_DIST;
    const ey = oy + forward.y * CROSSHAIR_MAX_DIST;
    const ez = oz + forward.z * CROSSHAIR_MAX_DIST;
    const hit = castRayFromTo(
      activeWorld,
      { x: ox, y: oy, z: oz },
      { x: ex, y: ey, z: ez },
      { filterPredicate: (otherEid) => otherEid !== eid && !isProjectileType(activeWorld, otherEid) },
    );
    eventBus.emit("ui:crosshairAimPoint", {
      wx: ex, wy: ey, wz: ez,
      hasHit: hit !== null,
      hitWx: hit ? ox + (ex - ox) * hit.toi : ex,
      hitWy: hit ? oy + (ey - oy) * hit.toi : ey,
      hitWz: hit ? oz + (ez - oz) * hit.toi : ez,
    });
  });

  return () => {
    unsubProjectiles();
    unsubMovement();
    unsubMousePitch();
    unsubJump();
    unsubBoost();
    unsubFire();
    unsubDebugFire();
    unsubCrosshair();
  };
}

function clampSpawnPositionToFloor(
  world: World,
  position: Position,
  halfHeight: number,
  floorEids: FloorEids = queryFloorEids(world),
) {
  // Only consider floors at or below the spawn Y so platforms above the player
  // don't push the spawn position up through raised geometry.
  const floorTop = findHighestFloorTopAtPosition(
    world,
    floorEids,
    position.x,
    position.z,
    position.y,
  );
  if (floorTop === null) {
    return position;
  }

  return {
    x: position.x,
    y: Math.max(position.y, floorTop + halfHeight),
    z: position.z,
  };
}

function normalizeVector(vector: Velocity): Velocity {
  const normalizedVector = normalizeVectorOrNull(vector);
  if (normalizedVector) {
    return normalizedVector;
  }

  return { x: 0, y: 0, z: -1 };
}

function normalizeVectorOrNull(vector: Velocity): Velocity | null {
  const length = Math.hypot(vector.x, vector.y, vector.z);
  if (length === 0) {
    return null;
  }

  return {
    x: vector.x / length,
    y: vector.y / length,
    z: vector.z / length,
  };
}

function scaleVector(vector: Velocity, scalar: number): Velocity {
  return {
    x: vector.x * scalar,
    y: vector.y * scalar,
    z: vector.z * scalar,
  };
}

function addVectors(a: Velocity, b: Vec3): Velocity {
  return {
    x: a.x + b.x,
    y: a.y + b.y,
    z: a.z + b.z,
  };
}

function invertVector(vector: Vec3): Velocity {
  return {
    x: -vector.x,
    y: -vector.y,
    z: -vector.z,
  };
}

function dotVectors(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function getFallbackProjectileBounceDelta(
  velocity: Velocity,
  normal: Velocity,
): Velocity | null {
  const closingSpeed = dotVectors(velocity, normal);
  if (closingSpeed <= 0) {
    return null;
  }

  return {
    x:
      -normal.x *
      closingSpeed *
      (1 + PROJECTILE_FALLBACK_BOUNCE_RESTITUTION),
    y:
      -normal.y *
      closingSpeed *
      (1 + PROJECTILE_FALLBACK_BOUNCE_RESTITUTION),
    z:
      -normal.z *
      closingSpeed *
      (1 + PROJECTILE_FALLBACK_BOUNCE_RESTITUTION),
  };
}

function resolveProjectileSweepBounce(
  world: CoreWorld,
  projectileEid: number,
  colliderEid: number,
  velocity: Velocity,
  sweepNormal: Vec3,
) {
  const candidateNormals = [
    normalizeVectorOrNull(sweepNormal),
    normalizeVectorOrNull(
      rotateLocalVectorByEntityRotation(world, projectileEid, sweepNormal),
    ),
  ].filter((candidate): candidate is Velocity => candidate !== null);

  for (let i = 0; i < candidateNormals.length; i += 1) {
    const normal = candidateNormals[i]!;
    const bounceDelta = getCollisionBounceDelta(
      world,
      projectileEid,
      colliderEid,
      normal,
    );
    if (bounceDelta) {
      return { bounceDelta, impactNormal: normal };
    }

    const invertedNormal = invertVector(normal);
    const invertedBounceDelta = getCollisionBounceDelta(
      world,
      projectileEid,
      colliderEid,
      invertedNormal,
    );
    if (invertedBounceDelta) {
      return { bounceDelta: invertedBounceDelta, impactNormal: invertedNormal };
    }
  }

  for (let i = 0; i < candidateNormals.length; i += 1) {
    const normal = candidateNormals[i]!;
    const fallbackBounceDelta = getFallbackProjectileBounceDelta(
      velocity,
      normal,
    );
    if (fallbackBounceDelta) {
      return { bounceDelta: fallbackBounceDelta, impactNormal: normal };
    }

    const invertedNormal = invertVector(normal);
    const invertedFallbackBounceDelta = getFallbackProjectileBounceDelta(
      velocity,
      invertedNormal,
    );
    if (invertedFallbackBounceDelta) {
      return {
        bounceDelta: invertedFallbackBounceDelta,
        impactNormal: invertedNormal,
      };
    }
  }

  return null;
}

function getProjectileSeparatedPosition(
  position: Position,
  bouncedVelocity: Velocity,
): Position {
  const separationDirection = normalizeVectorOrNull(bouncedVelocity);
  if (!separationDirection) {
    return position;
  }

  return {
    x:
      position.x +
      separationDirection.x * PROJECTILE_BOUNCE_SEPARATION_DISTANCE,
    y:
      position.y +
      separationDirection.y * PROJECTILE_BOUNCE_SEPARATION_DISTANCE,
    z:
      position.z +
      separationDirection.z * PROJECTILE_BOUNCE_SEPARATION_DISTANCE,
  };
}

function faceEntityAlongVelocity(
  world: CoreWorld,
  eid: number,
  velocity: Velocity,
) {
  const normalizedVelocity = normalizeVectorOrNull(velocity);
  if (!normalizedVelocity) {
    return;
  }

  const horizontalSpeed = Math.hypot(
    normalizedVelocity.x,
    normalizedVelocity.z,
  );
  setEntityRotation(world, eid, {
    pitch: Math.asin(clamp(normalizedVelocity.y, -1, 1)),
    yaw:
      horizontalSpeed > 0
        ? getYawFromXZDirection(normalizedVelocity.x, normalizedVelocity.z)
        : undefined,
    roll: 0,
  });
}

function updateProjectileBounceCooldowns(projectile: ProjectileState) {
  for (const [targetEid, remainingTicks] of projectile.bounceCooldownsByTarget) {
    if (remainingTicks <= 1) {
      projectile.bounceCooldownsByTarget.delete(targetEid);
      continue;
    }

    projectile.bounceCooldownsByTarget.set(targetEid, remainingTicks - 1);
  }
}

function createPerson(
  world: World,
  position: Position,
  velocity: Velocity,
  rotation: Rotation,
  faceVelocity: boolean,
  health: number,
  player: Player,
  floorEids: FloorEids = queryFloorEids(world),
) {
  const spawnPosition = clampSpawnPositionToFloor(
    world,
    position,
    PERSON_COLLIDER.halfHeight,
    floorEids,
  );

  return spawnEntity(world, {
    position: spawnPosition,
    velocity,
    rotation,
    faceVelocity,
    gravity: true,
    health,
    player,
    collider: PERSON_COLLIDER,
    renderMesh: createPersonRenderMesh,
  });
}

function createFloor(world: World, position: Position) {
  return spawnEntity(world, {
    position,
    floor: true,
    collider: FLOOR_COLLIDER,
    renderMesh: createFloorRenderMesh,
  });
}

function createFloorSlab(
  world: World,
  position: Position,
  halfWidth: number,
  halfHeight: number,
  halfDepth: number,
  baseMaterial: MeshLambertMaterial,
  edgeMaterial: LineBasicMaterial,
  pitch = 0,
  yaw = 0,
) {
  const geometry = new BoxGeometry(halfWidth * 2, halfHeight * 2, halfDepth * 2);
  const edgeGeometry = new EdgesGeometry(geometry);
  return spawnEntity(world, {
    position,
    rotation: { pitch, yaw, roll: 0 },
    floor: true,
    collider: { halfWidth, halfHeight, halfDepth },
    renderMesh: () => {
      const mesh = new Mesh(geometry, baseMaterial);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const outline = new LineSegments(edgeGeometry, edgeMaterial);
      outline.renderOrder = 1;
      outline.scale.setScalar(1.0005);
      mesh.add(outline);
      return mesh;
    },
  });
}

// Yaw values for ramps: determines which direction goes "up" (surface rises that way).
// Derived from the closed-form surface equation: surfaceY = cy + hy/cos(p) - tan(p)*(sin(yaw)*(px-cx) + cos(yaw)*(pz-cz))
const RAMP_YAW = { north: 0, south: Math.PI, east: -Math.PI / 2, west: Math.PI / 2 } as const

// Spawn a ramp whose low end sits at FLOOR_TOP_Y and high end at FLOOR_TOP_Y+rise.
// cx/cz is the horizontal center; run is the total horizontal distance; halfWidthPerp is width.
function spawnRamp(
  world: World,
  cx: number,
  cz: number,
  run: number,
  rise: number,
  upward: keyof typeof RAMP_YAW,
  halfWidthPerp: number,
) {
  const pitch = Math.atan2(rise, run)
  const hzLocal = Math.hypot(rise, run) / 2
  const cy = FLOOR_TOP_Y + rise / 2 - 0.4 / Math.cos(pitch)
  createFloorSlab(world, { x: cx, y: cy, z: cz }, halfWidthPerp, 0.4, hzLocal,
    RAMP_BASE_MATERIAL, RAMP_EDGE_MATERIAL, pitch, RAMP_YAW[upward])
}

// Spawn a flat walkable platform whose top surface is at topY.
function spawnPlatform(
  world: World,
  cx: number,
  topY: number,
  cz: number,
  halfWidth: number,
  halfDepth: number,
) {
  const hh = 0.3
  createFloorSlab(world, { x: cx, y: topY - hh, z: cz }, halfWidth, hh, halfDepth,
    STEP_BASE_MATERIAL, STEP_EDGE_MATERIAL)
}

function spawnTerrain(world: World) {
  // ── EAST WING (y=4) ───────────────────────────────────────────────────────
  // Ramp: low at x=10 (ground), high at x=22 (y=4). run=12, rise=4, going east.
  spawnRamp(world, 16, 2, 12, 4, 'east', 5)
  // Large east platform. Extends far enough north to lap under the north bridge.
  spawnPlatform(world, 31, 4, -6, 9, 22)
  // Narrow walkway jutting east off the platform → small balcony overlook
  spawnPlatform(world, 43, 4, 0, 1.5, 3)
  spawnPlatform(world, 49, 4, 0, 3, 4)

  // ── WEST WING (y=4) ───────────────────────────────────────────────────────
  // Staircase going west — 4 steps of 1 unit each (max jump height ≈ 1.33 units).
  // Each step is a solid block from ground to its top so visually they stack.
  for (let i = 0; i < 4; i++) {
    const stepTop = FLOOR_TOP_Y + (i + 1)
    createFloorSlab(
      world,
      { x: -(12 + i * 3), y: stepTop / 2, z: 5 },
      1.5, stepTop / 2, 2.5,
      STEP_BASE_MATERIAL, STEP_EDGE_MATERIAL,
    )
  }
  // Large west platform. Same footprint as the east platform, mirrored.
  spawnPlatform(world, -31, 4, -6, 9, 22)

  // ── NORTH BRIDGE (y=4) ────────────────────────────────────────────────────
  // Wide walkway connecting both wings across the north end.
  spawnPlatform(world, 0, 4, -26, 22, 5)

  // ── NORTH KEEP (y=4) ──────────────────────────────────────────────────────
  // Fortified area hanging off the north end of the bridge.
  spawnPlatform(world, 0, 4, -37, 8, 6)
  createWall(world, { x: 0, y: 5.5, z: -43 }, 8, 1.5, 0.4)

  // Stairs from keep (y=4) up to upper keep (y=8). Each step 1 unit higher.
  for (let i = 0; i < 4; i++) {
    const stepTop = 4 + (i + 1)
    createFloorSlab(
      world,
      { x: 0, y: stepTop - 0.5, z: -(44 + i * 3) },
      4, 0.5, 1.5,
      STEP_BASE_MATERIAL, STEP_EDGE_MATERIAL,
    )
  }

  // ── UPPER KEEP (y=8) ──────────────────────────────────────────────────────
  spawnPlatform(world, 0, 8, -58, 5, 4)
  createWall(world, { x: 0, y: 9.5, z: -62 }, 5, 1.5, 0.4)

  // ── SOUTH TERRACE (y=3) ───────────────────────────────────────────────────
  // Ramp: low at z=30 (ground), high at z=22 (y=3). run=8, rise=3, going north.
  spawnRamp(world, 0, 26, 8, 3, 'north', 8)
  spawnPlatform(world, 0, 3, 17, 12, 5)

  // ── WALLS & PARAPETS ──────────────────────────────────────────────────────
  // Courtyard cover near spawn
  createWall(world, { x: -5, y: 1.5, z: -7 }, 0.5, 1.5, 3)
  createWall(world, { x:  5, y: 1.5, z: -7 }, 0.5, 1.5, 3)
  // East platform east parapet
  createWall(world, { x: 40, y: 4.8, z: -6 }, 0.3, 0.8, 22)
  // West platform west parapet
  createWall(world, { x: -40, y: 4.8, z: -6 }, 0.3, 0.8, 22)
  // North bridge north parapets (split at centre to leave an opening)
  createWall(world, { x: -11, y: 4.8, z: -31 }, 11, 0.8, 0.4)
  createWall(world, { x:  11, y: 4.8, z: -31 }, 11, 0.8, 0.4)
}

export { setupGame };
