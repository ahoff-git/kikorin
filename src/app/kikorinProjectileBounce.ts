import {
  castEntityCollider,
  getBounceSuggestion,
  getCollisionBounceDelta,
  getTouchingEntities,
  getYawFromXZDirection,
  rotateLocalVectorByEntityRotation,
  setEntityPosition,
  setEntityRotation,
  setEntityVelocity,
  type CoreWorld,
  type Position,
  type Vec3,
  type Velocity,
} from "@/packages/core/core";
import { clamp } from "@/packages/util/random";
import {
  addVectors,
  dotVectors,
  invertVector,
  normalizeVectorOrNull,
  scaleVector,
} from "./kikorinProjectileMath";

const PROJECTILE_BOUNCE_REPEAT_COOLDOWN_TICKS = 6;
const PROJECTILE_SWEEP_REWIND_TOI = 0.002;
const PROJECTILE_BOUNCE_SEPARATION_DISTANCE = 0.04;
const PROJECTILE_FALLBACK_BOUNCE_RESTITUTION = 0.8;

export type ProjectileBounceState = {
  bounceCooldownsByTarget: Map<number, number>;
};

export type ProjectileMotion = {
  position: Position;
  velocity: Velocity;
};

export function readProjectileMotion(
  world: CoreWorld,
  projectileEid: number,
): ProjectileMotion {
  const { Position, Velocity } = world.components;
  return {
    position: {
      x: Position.x[projectileEid],
      y: Position.y[projectileEid],
      z: Position.z[projectileEid],
    },
    velocity: {
      x: Velocity.x[projectileEid],
      y: Velocity.y[projectileEid],
      z: Velocity.z[projectileEid],
    },
  };
}

export function createFreshProjectileBounceTargetFilter(
  world: CoreWorld,
  projectile: ProjectileBounceState,
) {
  const { Floor } = world.components;
  return (targetEid: number) => {
    return (
      !Floor[targetEid] &&
      (projectile.bounceCooldownsByTarget.get(targetEid) ?? 0) === 0
    );
  };
}

function setProjectileBounceCooldowns(
  projectile: ProjectileBounceState,
  targetEids: readonly number[],
) {
  for (let i = 0; i < targetEids.length; i += 1) {
    projectile.bounceCooldownsByTarget.set(
      targetEids[i]!,
      PROJECTILE_BOUNCE_REPEAT_COOLDOWN_TICKS,
    );
  }
}

export function updateProjectileBounceCooldowns(
  projectile: ProjectileBounceState,
) {
  for (const [targetEid, remainingTicks] of projectile.bounceCooldownsByTarget) {
    if (remainingTicks <= 1) {
      projectile.bounceCooldownsByTarget.delete(targetEid);
      continue;
    }

    projectile.bounceCooldownsByTarget.set(targetEid, remainingTicks - 1);
  }
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

function applyProjectileMotion(
  world: CoreWorld,
  projectileEid: number,
  position: Position,
  velocity: Velocity,
) {
  setEntityPosition(world, projectileEid, position);
  setEntityVelocity(world, projectileEid, velocity);
  faceEntityAlongVelocity(world, projectileEid, velocity);
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

function applyProjectileBounce(
  world: CoreWorld,
  projectileEid: number,
  projectile: ProjectileBounceState,
  position: Position,
  velocity: Velocity,
  bounceDelta: Vec3,
  targetEids: readonly number[],
) {
  const bouncedVelocity = addVectors(velocity, bounceDelta);
  const separatedPosition = getProjectileSeparatedPosition(
    position,
    bouncedVelocity,
  );
  applyProjectileMotion(world, projectileEid, separatedPosition, bouncedVelocity);
  setProjectileBounceCooldowns(projectile, targetEids);
}

export function tryApplyProjectileOverlapBounce(
  world: CoreWorld,
  projectileEid: number,
  projectile: ProjectileBounceState,
  motion: ProjectileMotion,
  isFreshBounceTarget: (targetEid: number) => boolean,
) {
  const bounce = getBounceSuggestion(world, projectileEid);
  const freshOverlapTargets = getTouchingEntities(world, projectileEid).filter(
    isFreshBounceTarget,
  );
  if (!bounce || freshOverlapTargets.length === 0) {
    return false;
  }

  applyProjectileBounce(
    world,
    projectileEid,
    projectile,
    motion.position,
    motion.velocity,
    bounce,
    freshOverlapTargets,
  );
  return true;
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

function getCollisionBounceDeltaForNormal(
  world: CoreWorld,
  projectileEid: number,
  colliderEid: number,
  normal: Velocity,
) {
  return getCollisionBounceDelta(world, projectileEid, colliderEid, normal);
}

function getFallbackBounceDeltaForNormal(
  velocity: Velocity,
  normal: Velocity,
) {
  return getFallbackProjectileBounceDelta(velocity, normal);
}

function resolveProjectileBounceDeltaForNormal(
  world: CoreWorld,
  projectileEid: number,
  colliderEid: number,
  velocity: Velocity,
  normal: Velocity,
) {
  const collisionBounceDelta = getCollisionBounceDeltaForNormal(
    world,
    projectileEid,
    colliderEid,
    normal,
  );
  if (collisionBounceDelta) {
    return collisionBounceDelta;
  }

  return getFallbackBounceDeltaForNormal(velocity, normal);
}

function createProjectileSweepNormals(
  world: CoreWorld,
  projectileEid: number,
  sweepNormal: Vec3,
) {
  return [
    normalizeVectorOrNull(sweepNormal),
    normalizeVectorOrNull(
      rotateLocalVectorByEntityRotation(world, projectileEid, sweepNormal),
    ),
  ].filter((candidate): candidate is Velocity => candidate !== null);
}

function resolveProjectileSweepBounceDelta(
  world: CoreWorld,
  projectileEid: number,
  colliderEid: number,
  velocity: Velocity,
  sweepNormal: Vec3,
) {
  const candidateNormals = createProjectileSweepNormals(
    world,
    projectileEid,
    sweepNormal,
  );

  for (let i = 0; i < candidateNormals.length; i += 1) {
    const normal = candidateNormals[i]!;
    const bounceDelta = resolveProjectileBounceDeltaForNormal(
      world,
      projectileEid,
      colliderEid,
      velocity,
      normal,
    );
    if (bounceDelta) {
      return bounceDelta;
    }

    const invertedBounceDelta = resolveProjectileBounceDeltaForNormal(
      world,
      projectileEid,
      colliderEid,
      velocity,
      invertVector(normal),
    );
    if (invertedBounceDelta) {
      return invertedBounceDelta;
    }
  }

  return null;
}

function isZeroVelocity(velocity: Velocity) {
  return velocity.x === 0 && velocity.y === 0 && velocity.z === 0;
}

function getSweepImpactPosition(
  position: Position,
  movementDelta: Velocity,
  toi: number,
): Position {
  const correctedToi = clamp(toi - PROJECTILE_SWEEP_REWIND_TOI, 0, 1);
  return {
    x: position.x + movementDelta.x * correctedToi,
    y: position.y + movementDelta.y * correctedToi,
    z: position.z + movementDelta.z * correctedToi,
  };
}

function advanceProjectileWithoutCollision(
  world: CoreWorld,
  projectileEid: number,
  position: Position,
  movementDelta: Velocity,
) {
  setEntityPosition(world, projectileEid, {
    x: position.x + movementDelta.x,
    y: position.y + movementDelta.y,
    z: position.z + movementDelta.z,
  });
}

export function advanceProjectileBySweep(
  world: CoreWorld,
  projectileEid: number,
  projectile: ProjectileBounceState,
  motion: ProjectileMotion,
  deltaSeconds: number,
  isFreshBounceTarget: (targetEid: number) => boolean,
) {
  if (deltaSeconds <= 0) {
    return;
  }

  const movementDelta = scaleVector(motion.velocity, deltaSeconds);
  if (isZeroVelocity(movementDelta)) {
    return;
  }

  const sweptHit = castEntityCollider(
    world,
    projectileEid,
    motion.position,
    movementDelta,
    {
      filterPredicate: isFreshBounceTarget,
    },
  );
  if (!sweptHit) {
    advanceProjectileWithoutCollision(
      world,
      projectileEid,
      motion.position,
      movementDelta,
    );
    return;
  }

  const impactPosition = getSweepImpactPosition(
    motion.position,
    movementDelta,
    sweptHit.toi,
  );
  const bounceDelta = resolveProjectileSweepBounceDelta(
    world,
    projectileEid,
    sweptHit.colliderEid,
    motion.velocity,
    {
      x: sweptHit.normal1.x,
      y: sweptHit.normal1.y,
      z: sweptHit.normal1.z,
    },
  );
  if (!bounceDelta) {
    setEntityPosition(world, projectileEid, impactPosition);
    return;
  }

  applyProjectileBounce(
    world,
    projectileEid,
    projectile,
    impactPosition,
    motion.velocity,
    bounceDelta,
    [sweptHit.colliderEid],
  );
}
