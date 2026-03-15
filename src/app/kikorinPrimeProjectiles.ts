import {
  ControlSources,
  destroyEntity,
  hasEntityComponents,
  PointerControls,
  rotateLocalVectorByEntityRotation,
  spawnEntity,
  type CoreWorld,
  type Position,
  type Velocity,
} from "@/packages/core/core";
import {
  advanceProjectileBySweep,
  createFreshProjectileBounceTargetFilter,
  readProjectileMotion,
  tryApplyProjectileOverlapBounce,
  updateProjectileBounceCooldowns,
  type ProjectileBounceState,
} from "./kikorinProjectileBounce";
import { normalizeVector, scaleVector } from "./kikorinProjectileMath";
import { isPrimePlayerControlled } from "./kikorinPrimeMovement";
import {
  clampSpawnPositionToFloor,
} from "./kikorinScene";
import {
  createProjectileRenderMesh,
  PERSON_COLLIDER,
  PROJECTILE_COLLIDER,
} from "./kikorinSceneMeshes";

const PROJECTILE_SPEED = 42;
const PROJECTILE_TTL_TICKS = 84;
const PROJECTILE_FORWARD_SPAWN_OFFSET =
  PERSON_COLLIDER.halfDepth + PROJECTILE_COLLIDER.halfDepth + 0.24;
const PROJECTILE_SPAWN_HEIGHT = PERSON_COLLIDER.halfHeight * 0.35;

type ProjectileState = ProjectileBounceState & {
  remainingTicks: number;
};

type ProjectileRegistry = Map<number, ProjectileState>;

function createProjectileState(): ProjectileState {
  return {
    remainingTicks: PROJECTILE_TTL_TICKS,
    bounceCooldownsByTarget: new Map(),
  };
}

function createProjectileSpawnPosition(
  world: CoreWorld,
  eid: number,
  forward: Velocity,
): Position {
  const { Position } = world.components;
  return clampSpawnPositionToFloor(
    world,
    {
      x: Position.x[eid] + forward.x * PROJECTILE_FORWARD_SPAWN_OFFSET,
      y:
        Position.y[eid] +
        PROJECTILE_SPAWN_HEIGHT +
        forward.y * PROJECTILE_FORWARD_SPAWN_OFFSET,
      z: Position.z[eid] + forward.z * PROJECTILE_FORWARD_SPAWN_OFFSET,
    },
    PROJECTILE_COLLIDER.halfHeight,
  );
}

function spawnProjectileFromEntity(
  world: CoreWorld,
  eid: number,
  projectiles: ProjectileRegistry,
) {
  if (!hasEntityComponents(world, eid, ["Position", "Rotation", "Velocity"])) {
    return;
  }

  const { Rotation } = world.components;
  const forward = normalizeVector(
    rotateLocalVectorByEntityRotation(world, eid, {
      x: 0,
      y: 0,
      z: -1,
    }),
  );
  const projectileEid = spawnEntity(world, {
    position: createProjectileSpawnPosition(world, eid, forward),
    velocity: scaleVector(forward, PROJECTILE_SPEED),
    rotation: {
      pitch: Rotation.pitch[eid],
      yaw: Rotation.yaw[eid],
      roll: 0,
    },
    projectile: true,
    collider: PROJECTILE_COLLIDER,
    renderMesh: createProjectileRenderMesh,
  });

  projectiles.set(projectileEid, createProjectileState());
}

function isProjectileActive(world: CoreWorld, projectileEid: number) {
  return hasEntityComponents(world, projectileEid, [
    "Position",
    "Rotation",
    "Velocity",
    "Collider",
  ]);
}

function expireProjectile(
  world: CoreWorld,
  projectileEid: number,
  projectile: ProjectileState,
  projectiles: ProjectileRegistry,
) {
  projectile.remainingTicks -= 1;
  if (projectile.remainingTicks > 0) {
    return false;
  }

  destroyEntity(world, projectileEid);
  projectiles.delete(projectileEid);
  return true;
}

function updateProjectileEntity(
  world: CoreWorld,
  projectileEid: number,
  projectile: ProjectileState,
  projectiles: ProjectileRegistry,
  deltaSeconds: number,
) {
  if (!isProjectileActive(world, projectileEid)) {
    projectiles.delete(projectileEid);
    return;
  }

  updateProjectileBounceCooldowns(projectile);
  if (expireProjectile(world, projectileEid, projectile, projectiles)) {
    return;
  }

  const motion = readProjectileMotion(world, projectileEid);
  const isFreshBounceTarget = createFreshProjectileBounceTargetFilter(
    world,
    projectile,
  );
  if (
    tryApplyProjectileOverlapBounce(
      world,
      projectileEid,
      projectile,
      motion,
      isFreshBounceTarget,
    )
  ) {
    return;
  }

  advanceProjectileBySweep(
    world,
    projectileEid,
    projectile,
    motion,
    deltaSeconds,
    isFreshBounceTarget,
  );
}

function updateProjectiles(
  world: CoreWorld,
  projectiles: ProjectileRegistry,
  deltaSeconds: number,
) {
  for (const [projectileEid, projectile] of projectiles) {
    updateProjectileEntity(
      world,
      projectileEid,
      projectile,
      projectiles,
      deltaSeconds,
    );
  }
}

export function registerPrimeProjectileControls(world: CoreWorld, eid: number) {
  const projectiles: ProjectileRegistry = new Map();

  world.controls.onTick((activeWorld, tick) => {
    updateProjectiles(activeWorld, projectiles, tick.deltaSeconds);
  });

  world.controls.on(
    {
      source: ControlSources.Pointer,
      controlId: PointerControls.Primary,
      phase: "trigger",
    },
    (activeWorld) => {
      if (!isPrimePlayerControlled(activeWorld, eid)) return;
      spawnProjectileFromEntity(activeWorld, eid, projectiles);
    },
  );
}
