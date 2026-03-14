import {
  castEntityCollider,
  CoreFlags,
  ControlSources,
  destroyEntity,
  evaluateFlaginatorFlag,
  getBounceSuggestion,
  getCollisionBounceDelta,
  getTouchingEntities,
  getYawFromXZDirection,
  hasEntityComponents,
  KeyboardControls,
  markFlaginatorComponentChanged,
  PointerControls,
  queryEntities,
  rotateLocalVectorByEntityRotation,
  setEntityPosition,
  setEntityRotation,
  setEntityVelocity,
  setupCoreWorld,
  spawnEntity,
  type CoreWorld,
  type CoreWorldBox,
  type Player,
  type Position,
  type Rotation,
  type Vec3,
  type Velocity,
} from "@/packages/core/core";
import { findHighestFloorTopAtPosition } from "@/packages/core/systems/gravity";
import { clamp, rng } from "@/packages/util/random";
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
const PLAYER_ACCELERATION = 30;
const PLAYER_MAX_SPEED = 18;
const PLAYER_DRAG_PER_SECOND = 4;
const PLAYER_JUMP_SPEED = 8;
const PLAYER_FORWARD_BOOST = 10;
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
const AMBIENT_PERSON_COUNT = 8000;

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
export type World = CoreWorld;
export type WorldBox = CoreWorldBox;

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

function setupWorld(canvas: HTMLCanvasElement | null) {
  const worldBox: WorldBox = setupCoreWorld({
    canvas,
    autoStart: true,
  });
  createFloor(worldBox.world, FLOOR_POSITION);

  const floorEids = queryFloorEids(worldBox.world);
  const prime = createPrimePlayer(worldBox.world, floorEids);
  registerPrimeControls(worldBox.world, prime);
  worldBox.setCameraFollowTarget(prime);
  spawnAmbientPeople(worldBox.world, floorEids);

  return worldBox;
}

function queryFloorEids(world: World): FloorEids {
  return queryEntities(world, ["Floor", "Position", "Rotation", "Collider"]);
}

function createPrimePlayer(world: CoreWorld, floorEids: FloorEids) {
  return createPerson(
    world,
    { x: 0, y: 12, z: 0 },
    { x: 0, y: 0, z: 0 },
    { pitch: 0, yaw: 0, roll: 0 },
    false,
    100,
    { level: 0, experience: 0, name: "DoomPrime" },
    floorEids,
  );
}

function spawnAmbientPeople(
  world: CoreWorld,
  floorEids: FloorEids,
  count = AMBIENT_PERSON_COUNT,
) {
  const spawnRangeX = FLOOR_COLLIDER.halfWidth - 4;
  const spawnRangeZ = FLOOR_COLLIDER.halfDepth - 4;

  for (let i = 0; i < count; i += 1) {
    const moving = rng(0, 10) > 9; // 10% chance to be moving
    const velocity = {
      x: moving ? rng(-10, 10, 2) : 0,
      y: 0,
      z: moving ? rng(-10, 10, 2) : 0,
    };
    const position = {
      x: rng(-spawnRangeX, spawnRangeX),
      y: rng(FLOOR_TOP_Y + 4, FLOOR_TOP_Y + 60),
      z: rng(-spawnRangeZ, spawnRangeZ),
    };

    createPerson(
      world,
      position,
      velocity,
      {
        pitch: 0,
        yaw: moving
          ? getYawFromXZDirection(velocity.x, velocity.z)
          : rng(0, Math.PI * 2, 3),
        roll: 0,
      },
      moving,
      100,
      {
        level: 0,
        experience: 0,
        name: `Doom${i}`,
      },
      floorEids,
    );
  }
}

function registerPrimeControls(world: CoreWorld, eid: number) {
  const projectiles: ProjectileRegistry = new Map();

  const isControllingPrime = (activeWorld: CoreWorld) => {
    return (
      hasEntityComponents(activeWorld, eid, [
        "Player",
        "Velocity",
        "Rotation",
        "Gravity",
      ]) && activeWorld.components.Player[eid]?.name === "DoomPrime"
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
    const forward = normalizeVector(
      rotateLocalVectorByEntityRotation(activeWorld, eid, {
        x: 0,
        y: 0,
        z: -1,
      }),
    );
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
      projectile: true,
      collider: PROJECTILE_COLLIDER,
      renderMesh: createProjectileRenderMesh,
    });

    projectiles.set(projectileEid, {
      remainingTicks: PROJECTILE_TTL_TICKS,
      bounceCooldownsByTarget: new Map(),
    });
  };

  const updateProjectiles = (
    activeWorld: CoreWorld,
    deltaSeconds: number,
  ) => {
    const { Floor, Position, Velocity } = activeWorld.components;

    for (const [projectileEid, projectile] of projectiles) {
      if (
        !hasEntityComponents(activeWorld, projectileEid, [
          "Position",
          "Rotation",
          "Velocity",
          "Collider",
        ])
      ) {
        projectiles.delete(projectileEid);
        continue;
      }

      updateProjectileBounceCooldowns(projectile);
      projectile.remainingTicks -= 1;
      if (projectile.remainingTicks <= 0) {
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
          !Floor[targetEid] &&
          (projectile.bounceCooldownsByTarget.get(targetEid) ?? 0) === 0
        );
      };

      const bounce = getBounceSuggestion(activeWorld, projectileEid);
      const freshOverlapTargets = getTouchingEntities(
        activeWorld,
        projectileEid,
      ).filter(isFreshBounceTarget);

      if (bounce && freshOverlapTargets.length > 0) {
        const bouncedVelocity = addVectors(currentVelocity, bounce);
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

  world.controls.onTick((activeWorld, tick) => {
    updateProjectiles(activeWorld, tick.deltaSeconds);
  });

  world.controls.onTick((activeWorld, tick, controls) => {
    if (!isControllingPrime(activeWorld)) return;

    const dt = tick.deltaSeconds;
    if (dt === 0) return;

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
        ) * PLAYER_ACCELERATION,
      y: 0,
      z:
        controls.getAxis(
          PLAYER_FORWARD_KEYS,
          PLAYER_BACKWARD_KEYS,
          ControlSources.Keyboard,
        ) * PLAYER_ACCELERATION,
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
      -PLAYER_MAX_SPEED,
      PLAYER_MAX_SPEED,
    );
    Velocity.y[eid] = clamp(
      Velocity.y[eid] + worldAcceleration.y * dt,
      -PLAYER_MAX_SPEED,
      PLAYER_MAX_SPEED,
    );
    Velocity.z[eid] = clamp(
      Velocity.z[eid] + worldAcceleration.z * dt,
      -PLAYER_MAX_SPEED,
      PLAYER_MAX_SPEED,
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

  world.controls.on(
    {
      source: ControlSources.Keyboard,
      controlId: KeyboardControls.Space,
      phase: "start",
    },
    (activeWorld) => {
      jump(activeWorld);
    },
  );

  world.controls.on(
    {
      source: ControlSources.React,
      controlId: PlayerReactControls.BoostForward,
      phase: "trigger",
    },
    (activeWorld) => {
      if (!isControllingPrime(activeWorld)) return;

      const { Velocity } = activeWorld.components;
      Velocity.z[eid] = clamp(
        Velocity.z[eid] - PLAYER_FORWARD_BOOST,
        -PLAYER_MAX_SPEED,
        PLAYER_MAX_SPEED,
      );
      markFlaginatorComponentChanged(activeWorld, "Velocity", eid);
    },
  );

  world.controls.on(
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

export { setupWorld };
