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
import { findHighestFloorTopAtPosition } from "@kikorin/system-physics";
import { clamp, rng } from "@kikorin/util";
import {
  BoxGeometry,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
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
const PROJECTILE_BASE_MATERIAL = new MeshBasicMaterial({
  color: PROJECTILE_BODY_COLOR,
});
const PROJECTILE_TOUCH_MATERIAL = new MeshBasicMaterial({
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
const FLOOR_BASE_MATERIAL = new MeshBasicMaterial({ color: 0x445342 });
const FLOOR_EDGE_MATERIAL = new LineBasicMaterial({ color: 0x243022 });
const FLOOR_POSITION = {
  x: 0,
  y: FLOOR_TOP_Y - FLOOR_COLLIDER.halfHeight,
  z: 0,
};
const WALL_BASE_MATERIAL = new MeshBasicMaterial({ color: 0xb0a090 });
const WALL_EDGE_MATERIAL = new LineBasicMaterial({ color: 0x5a4a3a });
const RAMP_BASE_MATERIAL = new MeshBasicMaterial({ color: 0x6a7f55 });
const RAMP_EDGE_MATERIAL = new LineBasicMaterial({ color: 0x3a4f35 });
const STEP_BASE_MATERIAL = new MeshBasicMaterial({ color: 0x8a9a7a });
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
const AMBIENT_PERSON_COUNT = 30;
const BOX_MIN_SPEED = 2;
const BOX_MAX_SPEED = 5;
const BOX_MAX_STEER_RADIANS_PER_SECOND = 1.5;
// At max misalignment (180°), speed drops to this fraction and turn rate scales up by (1 + this).
const BOX_STEER_SPEED_MIN_FRACTION = 0.35;
const BOX_STEER_TURN_BOOST = 1.5;
// Monsters repel each other when closer than this distance (monsters are 1 unit wide).
const MONSTER_SEPARATION_RADIUS = 2.5;
const MONSTER_SEPARATION_STRENGTH = 2.0;
const PRIME_SPAWN_POSITION = { x: 0, y: 12, z: 0 };
const PRIME_PLAYER_NAME = "DoomPrime";

function createPersonFaceMaterials(bodyColor: number, frontColor: number) {
  return [
    ...Array.from({ length: 5 }, () => {
      return new MeshBasicMaterial({ color: bodyColor });
    }),
    // BoxGeometry groups are +X, -X, +Y, -Y, +Z, -Z. This project treats -Z as forward.
    new MeshBasicMaterial({ color: frontColor }),
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
type ProjectileState = {
  remainingTicks: number;
  bounceCooldownsByTarget: Map<number, number>;
};
type ProjectileRegistry = Map<number, ProjectileState>;

function createPersonRenderMesh() {
  const mesh = new Mesh(PERSON_GEOMETRY, PERSON_BASE_MATERIALS);
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
    position,
    collider: { halfWidth, halfHeight, halfDepth },
    renderMesh: () => createWallRenderMesh(halfWidth, halfHeight, halfDepth),
  });
}

function spawnSampleWalls(world: World) {
  const HALF_H = 4;
  const THICK = 0.5;
  const Y = FLOOR_TOP_Y + HALF_H;

  // North wall — closes the U ahead of spawn
  createWall(world, { x: 0, y: Y, z: -12 }, 8, HALF_H, THICK);
  // East arm of the U
  createWall(world, { x: 8, y: Y, z: -3 }, THICK, HALF_H, 9);
  // West arm of the U
  createWall(world, { x: -8, y: Y, z: -3 }, THICK, HALF_H, 9);
  // Freestanding pillar to the east
  createWall(world, { x: 20, y: Y, z: 5 }, 1, HALF_H, 1);
  // Long wall to the south
  createWall(world, { x: 0, y: Y, z: 18 }, 14, HALF_H, THICK);
}

function createProjectileRenderMesh() {
  const mesh = new Mesh(PROJECTILE_GEOMETRY, PROJECTILE_BASE_MATERIAL);
  mesh.scale.set(
    PROJECTILE_SCALE.x,
    PROJECTILE_SCALE.y,
    PROJECTILE_SCALE.z,
  );
  mesh.userData.baseMaterial = PROJECTILE_BASE_MATERIAL;
  mesh.userData.touchMaterial = PROJECTILE_TOUCH_MATERIAL;
  return mesh;
}

function registerBoxSteering(
  world: CoreWorld,
  boxEids: number[],
  baseSpeeds: Map<number, number>,
  primeEid: number,
): () => void {
  return world.controls.onTick((activeWorld, tick) => {
    if (tick.deltaSeconds === 0) return;
    if (!hasEntityComponents(activeWorld, primeEid, ["Position"])) return;

    const { Position, Velocity } = activeWorld.components;
    const targetX = Position.x[primeEid];
    const targetZ = Position.z[primeEid];
    const maxSteer = BOX_MAX_STEER_RADIANS_PER_SECOND * tick.deltaSeconds;

    for (const eid of boxEids) {
      if (!hasEntityComponents(activeWorld, eid, ["Position", "Velocity"])) continue;

      const currentSpeed = Math.hypot(Velocity.x[eid], Velocity.z[eid]);
      if (currentSpeed === 0) continue;

      const dx = targetX - Position.x[eid];
      const dz = targetZ - Position.z[eid];
      const distToTarget = Math.hypot(dx, dz);
      if (distToTarget === 0) continue;

      // Desired direction: unit vector toward player plus repulsion from nearby monsters.
      let desiredX = dx / distToTarget;
      let desiredZ = dz / distToTarget;
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
  spawnSampleWalls(engine.world);
  spawnTerrain(engine.world);

  const floorEids = queryFloorEids(engine.world);
  let primeEid = createPrimePlayer(engine.world, floorEids);
  engine.setCameraFollowTarget(primeEid);

  const baseSpeeds = new Map<number, number>();
  const boxEids = spawnAmbientPeople(engine.world, floorEids, baseSpeeds);
  let nextMonsterIndex = boxEids.length;

  const onMonsterHit = (world: CoreWorld, monsterEid: number) => {
    const idx = boxEids.indexOf(monsterEid);
    if (idx !== -1) boxEids.splice(idx, 1);
    baseSpeeds.delete(monsterEid);
    ownership.signalEntityDestroyed(monsterEid);
    destroyEntity(world, monsterEid);

    const newEid = spawnEdgeMonster(world, floorEids, `Doom${nextMonsterIndex++}`, baseSpeeds);
    boxEids.push(newEid);
    ownership.addOwnedEntity(newEid);
  };

  let cleanupPrimeControls = registerPrimeControls(engine.world, primeEid, ownership, onMonsterHit);
  let cleanupBoxSteering = registerBoxSteering(engine.world, boxEids, baseSpeeds, primeEid);

  engine.world.controls.onTick((activeWorld) => {
    if (hasEntityComponents(activeWorld, primeEid, ["Player"])) return;

    cleanupPrimeControls();
    cleanupBoxSteering();

    primeEid = createPrimePlayer(activeWorld, floorEids);
    engine.setCameraFollowTarget(primeEid);
    ownership.addOwnedEntity(primeEid);
    cleanupPrimeControls = registerPrimeControls(activeWorld, primeEid, ownership, onMonsterHit);
    cleanupBoxSteering = registerBoxSteering(activeWorld, boxEids, baseSpeeds, primeEid);
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
): () => void {
  const projectiles: ProjectileRegistry = new Map();

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
    if (!evaluateFlaginatorFlag(activeWorld, CoreFlags.OnGround, eid)) return;

    Velocity.y[eid] = clamp(
      PLAYER_JUMP_SPEED,
      -PLAYER_MAX_SPEED,
      PLAYER_MAX_SPEED,
    );
    Gravity.Grounded[eid] = 0;
    markFlaginatorComponentChanged(activeWorld, "Velocity", eid);
    markFlaginatorComponentChanged(activeWorld, "Gravity", eid);
  };

  const fireProjectile = (activeWorld: CoreWorld) => {
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
    ownership.addOwnedEntity(projectileEid);
  };

  const updateProjectiles = (
    activeWorld: CoreWorld,
    deltaSeconds: number,
  ) => {
    const { Floor, Position, Velocity } = activeWorld.components;
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
        projectiles.delete(projectileEid);
        continue;
      }

      updateProjectileBounceCooldowns(projectile);
      projectile.remainingTicks -= 1;
      if (projectile.remainingTicks <= 0) {
        ownership.signalEntityDestroyed(projectileEid);
        destroyEntity(activeWorld, projectileEid);
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
          !Floor[targetEid] &&
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
          onMonsterHit(activeWorld, hitOwnedMonster);
          ownership.signalEntityDestroyed(projectileEid);
          destroyEntity(activeWorld, projectileEid);
          projectiles.delete(projectileEid);
          continue;
        }

        const hitRemoteMonster = freshOverlapTargets.find(t =>
          isMonsterPlayer(t) && !hasNetFlag(activeWorld, t, NET.OWNED)
        );
        if (hitRemoteMonster !== undefined) {
          ownership.signalHitOnRemoteEntity(hitRemoteMonster);
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
        if (hasNetFlag(activeWorld, sweptHit.colliderEid, NET.OWNED)) {
          onMonsterHit(activeWorld, sweptHit.colliderEid);
        } else {
          ownership.signalHitOnRemoteEntity(sweptHit.colliderEid);
        }
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

  const unsubMovement = world.controls.onTick((activeWorld, tick, controls) => {
    if (!isControllingPrime(activeWorld)) return;

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

    const localAcceleration = {
      x:
        controls.getAxis(
          PLAYER_STRAFE_LEFT_KEYS,
          PLAYER_STRAFE_RIGHT_KEYS,
          ControlSources.Keyboard,
        ) * sprintAccel,
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
    const yawAxis = controls.getAxis(
      PLAYER_LOOK_RIGHT_KEYS,
      PLAYER_LOOK_LEFT_KEYS,
      ControlSources.Keyboard,
    );
    const worldAcceleration = rotateLocalVectorByEntityRotation(
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

    if (pitchAxis === 0 && yawAxis === 0) return;

    const nextRotation: Partial<Rotation> = {};
    if (pitchAxis !== 0) {
      nextRotation.pitch = clamp(
        Rotation.pitch[eid] + pitchAxis * PLAYER_PITCH_SPEED * dt,
        -PLAYER_MAX_PITCH,
        PLAYER_MAX_PITCH,
      );
    }
    if (yawAxis !== 0) {
      nextRotation.yaw = Rotation.yaw[eid] + yawAxis * PLAYER_YAW_SPEED * dt;
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
      const forward = getEntityForward(activeWorld, eid);
      Velocity.x[eid] = clamp(
        Velocity.x[eid] + forward.x * PLAYER_FORWARD_BOOST,
        -PLAYER_MAX_SPEED,
        PLAYER_MAX_SPEED,
      );
      Velocity.y[eid] = clamp(
        Velocity.y[eid] + forward.y * PLAYER_FORWARD_BOOST,
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

  return () => {
    unsubProjectiles();
    unsubMovement();
    unsubJump();
    unsubBoost();
    unsubFire();
  };
}

function clampSpawnPositionToFloor(
  world: World,
  position: Position,
  halfHeight: number,
  floorEids: FloorEids = queryFloorEids(world),
) {
  const floorTop = findHighestFloorTopAtPosition(
    world,
    floorEids,
    position.x,
    position.z,
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
  baseMaterial: MeshBasicMaterial,
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
      const outline = new LineSegments(edgeGeometry, edgeMaterial);
      outline.renderOrder = 1;
      outline.scale.setScalar(1.0005);
      mesh.add(outline);
      return mesh;
    },
  });
}

// Ramp: rises 4 units over a 15-unit horizontal run, running north (-Z).
// Center Y is chosen so the south end surface sits at FLOOR_TOP_Y and the
// north end surface sits at FLOOR_TOP_Y + 4.
const RAMP_HW = 4;
const RAMP_HH = 0.5;
const RAMP_HZ = 7.5; // horizontal half-run = 7.5, total run = 15
const RAMP_RISE = 4;
const RAMP_PITCH = Math.atan2(RAMP_RISE, RAMP_HZ * 2);
// surfaceY = cy + hh/cos(p) ± tan(p)*hz; mean = cy + hh/cos(p) = midpoint of [0, 4] = 2
const RAMP_CY = FLOOR_TOP_Y + 2 - RAMP_HH / Math.cos(RAMP_PITCH);

function spawnTerrain(world: World) {
  // Ramp — east of the arena, runs from z=10 (ground level) north to z=-5 (4 units up)
  const RAMP_CX = 30;
  const RAMP_CZ = 2.5; // midpoint between z=-5 and z=10
  createFloorSlab(
    world,
    { x: RAMP_CX, y: RAMP_CY, z: RAMP_CZ },
    RAMP_HW, RAMP_HH, RAMP_HZ,
    RAMP_BASE_MATERIAL, RAMP_EDGE_MATERIAL,
    RAMP_PITCH,
  );

  // Elevated landing platform at the top of the ramp
  createFloorSlab(
    world,
    { x: RAMP_CX, y: FLOOR_TOP_Y + RAMP_RISE - 0.25, z: -10 },
    RAMP_HW, 0.25, 5,
    RAMP_BASE_MATERIAL, RAMP_EDGE_MATERIAL,
  );

  // Steps — west of the arena, each 1 unit above the previous, jumpable in sequence.
  // Max jump height ≈ v²/2g = 8²/(2*24) ≈ 1.33 units, so 1-unit steps are always reachable.
  const STEP_X = -28;
  const STEP_HW = 3;
  const STEP_RISE = 1.0;
  for (let i = 0; i < 4; i++) {
    const stepTop = FLOOR_TOP_Y + STEP_RISE * (i + 1);
    createFloorSlab(
      world,
      { x: STEP_X, y: stepTop - STEP_RISE / 2, z: 8 - i * 5 },
      STEP_HW, STEP_RISE / 2, 2,
      STEP_BASE_MATERIAL, STEP_EDGE_MATERIAL,
    );
  }
}

export { setupGame };
