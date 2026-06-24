import { hasComponent, query } from "bitecs";
import type { CoreWorld } from "@kikorin/ecs";
import { isProjectileType } from "@kikorin/ecs";
import { log, logLevels } from "@kikorin/util";
import { castRayFromTo, findHighestFloorTopAtPosition } from "@kikorin/system-physics";
import { lookCameraAt, readCameraPosition, setCameraPosition } from "@kikorin/system-rendering";

type Vec3 = { x: number; y: number; z: number };
type PartialVec3 = Partial<Vec3>;
type CameraMode = "off" | "follow" | "lookAt";

const DEFAULT_FOLLOW_OFFSET: Vec3 = { x: 0, y: 6, z: 10 };
const DEFAULT_FOLLOW_HORIZONTAL = Math.hypot(DEFAULT_FOLLOW_OFFSET.x, DEFAULT_FOLLOW_OFFSET.z);
const DEFAULT_FOLLOW_DISTANCE = Math.hypot(DEFAULT_FOLLOW_HORIZONTAL, DEFAULT_FOLLOW_OFFSET.y);
const DEFAULT_FOLLOW_PITCH = Math.atan2(DEFAULT_FOLLOW_OFFSET.y, DEFAULT_FOLLOW_HORIZONTAL);
const DEFAULT_STATIONARY_POSITION: Vec3 = { x: 0, y: 4, z: 10 };
const MIN_FOLLOW_DISTANCE = 0.1;
const MAX_FOLLOW_PITCH = Math.PI * 0.48;
const CAMERA_GROUND_CLEARANCE = 0.1;
// Small gap to keep between the camera and the wall face it is pulled in front of.
const CAMERA_WALL_SEPARATION = 0.3;
// Speed (world-units per second) at which the camera zooms back out after a wall clears.
// The camera always snaps in instantly; it only springs back slowly.
const CAMERA_RESTORE_SPEED = 6.0;
// How high above the entity's position the camera looks, in world units.
// Keeps the player character framed above their feet rather than staring at the ground.
const LOOK_AT_HEIGHT_OFFSET = 0.75;
const CAMERA_PITCH_DRAG_MIN_RESPONSE = 0.2;
const CAMERA_PITCH_DRAG_EDGE_EXPONENT = 2;
const CAMERA_DEBUG_FRAME_INTERVAL = 30;

let cameraFollowFrameCount = 0;
let lastSkipReason: string | null = null;

const scratchDesiredPos: Vec3 = { x: 0, y: 0, z: 0 };
const scratchCurrentPos: Vec3 = { x: 0, y: 0, z: 0 };

const cameraState: {
  mode: CameraMode;
  targetEid: number;
  followOffset: Vec3;
  followDistance: number;
  // Current rendered camera distance. Snaps in when a wall blocks the view;
  // springs back toward followDistance at CAMERA_RESTORE_SPEED when the path clears.
  actualCameraDistance: number;
  followYaw: number;
  followPitch: number;
  lastTargetYaw: number;
  orbitControlActive: boolean;
  stationaryPosition: Vec3;
} = {
  mode: "off",
  targetEid: -1,
  followOffset: { ...DEFAULT_FOLLOW_OFFSET },
  followDistance: 1,
  actualCameraDistance: DEFAULT_FOLLOW_DISTANCE,
  followYaw: 0,
  followPitch: 0,
  lastTargetYaw: Number.NaN,
  orbitControlActive: false,
  stationaryPosition: { ...DEFAULT_STATIONARY_POSITION },
};

function assignVec3(target: Vec3, source?: PartialVec3) {
  if (!source) return;
  if (source.x !== undefined) target.x = source.x;
  if (source.y !== undefined) target.y = source.y;
  if (source.z !== undefined) target.z = source.z;
}

function clampFollowPitch(pitch: number): number {
  return Math.max(-MAX_FOLLOW_PITCH, Math.min(MAX_FOLLOW_PITCH, pitch));
}

function normalizeAngleDelta(delta: number): number {
  if (!Number.isFinite(delta)) return 0;
  if (delta <= -Math.PI || delta > Math.PI) {
    return Math.atan2(Math.sin(delta), Math.cos(delta));
  }
  return delta;
}

function syncFollowOrbitFromOffset() {
  const { x, y, z } = cameraState.followOffset;
  const horizontalDistance = Math.hypot(x, z);
  const distance = Math.max(MIN_FOLLOW_DISTANCE, Math.hypot(horizontalDistance, y));

  cameraState.followDistance = distance;
  cameraState.followYaw = Math.atan2(x, z);
  cameraState.followPitch = clampFollowPitch(Math.atan2(y, horizontalDistance));
}

function syncFollowOffsetFromOrbit() {
  const horizontalDistance = Math.cos(cameraState.followPitch) * cameraState.followDistance;

  cameraState.followOffset.x = Math.sin(cameraState.followYaw) * horizontalDistance;
  cameraState.followOffset.y = Math.sin(cameraState.followPitch) * cameraState.followDistance;
  cameraState.followOffset.z = Math.cos(cameraState.followYaw) * horizontalDistance;
}

function logCameraDebug(message: string, data?: Record<string, unknown>) {
  if (data) {
    log(logLevels.debug, `[cameraFollow] ${message}`, ["camera"], data);
  } else {
    log(logLevels.debug, `[cameraFollow] ${message}`, ["camera"]);
  }
}

function logSkipOnce(reason: string, data?: Record<string, unknown>) {
  if (lastSkipReason === reason) return;
  lastSkipReason = reason;
  logCameraDebug(`skipping update: ${reason}`, data);
}

function clearSkipReason() {
  lastSkipReason = null;
}

function reduceFollowPitchDelta(deltaPitch: number): number {
  if (deltaPitch === 0) return 0;

  const normalizedPitch = Math.min(
    1,
    Math.abs(cameraState.followPitch) / MAX_FOLLOW_PITCH,
  );
  const response =
    CAMERA_PITCH_DRAG_MIN_RESPONSE +
    (1 - CAMERA_PITCH_DRAG_MIN_RESPONSE) *
      (1 - Math.pow(normalizedPitch, CAMERA_PITCH_DRAG_EDGE_EXPONENT));

  return deltaPitch * response;
}

function clampCameraHeightToFloor(
  world: CoreWorld,
  desiredPosition: Vec3,
  currentCameraPosition: Vec3,
): boolean {
  const { Collider, Floor, Position, Rotation } = world.components;
  const floorEids = query(world, [Floor, Position, Rotation, Collider]);
  if (floorEids.length === 0) return false;

  // Ignore floors above the current camera height so the camera does not jump to ceilings.
  const maxFloorTop = Math.max(currentCameraPosition.y, desiredPosition.y) + CAMERA_GROUND_CLEARANCE;
  const floorTop = findHighestFloorTopAtPosition(
    world,
    floorEids,
    desiredPosition.x,
    desiredPosition.z,
    maxFloorTop,
  );
  if (floorTop === null) return false;

  const minCameraY = floorTop + CAMERA_GROUND_CLEARANCE;
  if (desiredPosition.y >= minCameraY) return false;

  desiredPosition.y = minCameraY;
  return true;
}

syncFollowOrbitFromOffset();

export function resetCameraTarget() {
  cameraState.mode = "off";
  cameraState.targetEid = -1;
  cameraState.lastTargetYaw = Number.NaN;
  cameraState.orbitControlActive = false;
  logCameraDebug("reset target", {
    mode: cameraState.mode,
    targetEid: cameraState.targetEid,
  });
}

export function setCameraFollowTarget(
  eid: number,
  opts: { offset?: PartialVec3 } = {}
) {
  cameraState.mode = "follow";
  cameraState.targetEid = eid;
  cameraState.lastTargetYaw = Number.NaN;
  assignVec3(cameraState.followOffset, opts.offset);
  syncFollowOrbitFromOffset();
  cameraState.actualCameraDistance = cameraState.followDistance;
  logCameraDebug("set follow target", {
    targetEid: cameraState.targetEid,
    followOffset: {
      x: cameraState.followOffset.x,
      y: cameraState.followOffset.y,
      z: cameraState.followOffset.z,
    },
    followOrbit: {
      distance: cameraState.followDistance,
      yaw: cameraState.followYaw,
      pitch: cameraState.followPitch,
    },
  });
}

export function adjustCameraFollowOrbit(deltaYaw: number, deltaPitch: number) {
  if (cameraState.mode !== "follow") return;
  if (deltaYaw === 0 && deltaPitch === 0) return;

  const reducedDeltaPitch = reduceFollowPitchDelta(deltaPitch);
  cameraState.followYaw += deltaYaw;
  cameraState.followPitch = clampFollowPitch(cameraState.followPitch + reducedDeltaPitch);
  syncFollowOffsetFromOrbit();

  logCameraDebug("adjust follow orbit", {
    deltaYaw,
    deltaPitch,
    reducedDeltaPitch,
    followOffset: {
      x: cameraState.followOffset.x,
      y: cameraState.followOffset.y,
      z: cameraState.followOffset.z,
    },
    followOrbit: {
      distance: cameraState.followDistance,
      yaw: cameraState.followYaw,
      pitch: cameraState.followPitch,
    },
  });
}

export function setCameraFollowOrbitControlActive(active: boolean) {
  if (cameraState.mode !== "follow") return;
  cameraState.orbitControlActive = active;
}

export function resetCameraFollowOrbitBehindTarget() {
  if (cameraState.mode !== "follow") return;
  if (!Number.isFinite(cameraState.lastTargetYaw)) return;
  cameraState.followYaw = cameraState.lastTargetYaw;
  cameraState.followPitch = DEFAULT_FOLLOW_PITCH;
  cameraState.followDistance = DEFAULT_FOLLOW_DISTANCE;
  cameraState.actualCameraDistance = DEFAULT_FOLLOW_DISTANCE;
  syncFollowOffsetFromOrbit();
}

export function setCameraLookAtTarget(
  eid: number,
  opts: { position?: PartialVec3 } = {}
) {
  cameraState.mode = "lookAt";
  cameraState.targetEid = eid;
  if (opts.position) {
    assignVec3(cameraState.stationaryPosition, opts.position);
  } else {
    const readOk = readCameraPosition(cameraState.stationaryPosition);
    logCameraDebug("captured stationary camera position from current camera", {
      readOk,
      stationaryPosition: {
        x: cameraState.stationaryPosition.x,
        y: cameraState.stationaryPosition.y,
        z: cameraState.stationaryPosition.z,
      },
    });
  }

  logCameraDebug("set lookAt target", {
    targetEid: cameraState.targetEid,
    stationaryPosition: {
      x: cameraState.stationaryPosition.x,
      y: cameraState.stationaryPosition.y,
      z: cameraState.stationaryPosition.z,
    },
  });
}

export function cameraFollowSystem(world: CoreWorld) {
  cameraFollowFrameCount += 1;

  if (cameraState.mode === "off") return;
  const eid = cameraState.targetEid;
  if (eid < 0) {
    logSkipOnce("invalid target eid", { eid });
    return;
  }

  const { Position, Rotation } = world.components;
  if (!hasComponent(world, eid, Position)) {
    resetCameraTarget();
    logSkipOnce("target entity no longer exists", { eid });
    return;
  }

  const tx = Position.x[eid];
  const ty = Position.y[eid];
  const tz = Position.z[eid];
  if (!Number.isFinite(tx) || !Number.isFinite(ty) || !Number.isFinite(tz)) {
    logSkipOnce("target position is not finite", { eid, tx, ty, tz });
    return;
  }
  clearSkipReason();

  let desiredCameraX: number;
  let desiredCameraY: number;
  let desiredCameraZ: number;

  if (cameraState.mode === "follow") {
    if (hasComponent(world, eid, Rotation)) {
      const targetYaw = Rotation.yaw[eid];
      if (Number.isFinite(targetYaw)) {
        if (
          Number.isFinite(cameraState.lastTargetYaw) &&
          !cameraState.orbitControlActive
        ) {
          cameraState.followYaw += normalizeAngleDelta(
            targetYaw - cameraState.lastTargetYaw,
          );
          syncFollowOffsetFromOrbit();
        }
        cameraState.lastTargetYaw = targetYaw;
      } else {
        cameraState.lastTargetYaw = Number.NaN;
      }
    } else {
      cameraState.lastTargetYaw = Number.NaN;
    }

    const { Floor, Player } = world.components;
    const { followOffset, followDistance } = cameraState;

    // Cast from the look-at point (player body centre) so walls that clip between
    // the camera and the player's head are detected, not just their feet.
    const lookAtOrigin = { x: tx, y: ty + LOOK_AT_HEIGHT_OFFSET, z: tz };
    const desiredCameraFull = {
      x: tx + followOffset.x,
      y: ty + followOffset.y,
      z: tz + followOffset.z,
    };

    const wallHit = castRayFromTo(world, lookAtOrigin, desiredCameraFull, {
      filterPredicate: (targetEid) =>
        !Floor[targetEid] &&
        !isProjectileType(world, targetEid) &&
        !hasComponent(world, targetEid, Player),
    });

    // toi is normalized to [0,1] over the look-at-to-camera ray.  Convert to a
    // maximum scale factor for followOffset, backing off by CAMERA_WALL_SEPARATION.
    const occlusionRayLen = Math.hypot(
      followOffset.x,
      followOffset.y - LOOK_AT_HEIGHT_OFFSET,
      followOffset.z,
    );
    const maxT = wallHit && wallHit.toi < 1
      ? Math.max(0, wallHit.toi - CAMERA_WALL_SEPARATION / occlusionRayLen)
      : 1;
    const maxDistance = maxT * followDistance;

    // Snap in immediately when blocked; spring back smoothly when the path clears.
    if (cameraState.actualCameraDistance > maxDistance) {
      cameraState.actualCameraDistance = maxDistance;
    } else {
      cameraState.actualCameraDistance = Math.min(
        followDistance,
        cameraState.actualCameraDistance + CAMERA_RESTORE_SPEED * world.time.delta,
      );
    }

    // Scale the follow offset proportionally to the current camera distance.
    const t = followDistance > 0 ? cameraState.actualCameraDistance / followDistance : 0;
    desiredCameraX = tx + followOffset.x * t;
    desiredCameraY = ty + followOffset.y * t;
    desiredCameraZ = tz + followOffset.z * t;
  } else {
    const p = cameraState.stationaryPosition;
    desiredCameraX = p.x;
    desiredCameraY = p.y;
    desiredCameraZ = p.z;
  }

  scratchDesiredPos.x = desiredCameraX;
  scratchDesiredPos.y = desiredCameraY;
  scratchDesiredPos.z = desiredCameraZ;
  scratchCurrentPos.x = desiredCameraX;
  scratchCurrentPos.y = desiredCameraY;
  scratchCurrentPos.z = desiredCameraZ;
  readCameraPosition(scratchCurrentPos);
  const desiredCameraPosition = scratchDesiredPos;
  const currentCameraPosition = scratchCurrentPos;
  const cameraClampedToFloor = clampCameraHeightToFloor(
    world,
    desiredCameraPosition,
    currentCameraPosition,
  );
  desiredCameraX = desiredCameraPosition.x;
  desiredCameraY = desiredCameraPosition.y;
  desiredCameraZ = desiredCameraPosition.z;

  const setPositionOk = setCameraPosition(
    desiredCameraX,
    desiredCameraY,
    desiredCameraZ,
  );
  const lookAtOk = lookCameraAt(tx, ty + LOOK_AT_HEIGHT_OFFSET, tz);
  const shouldLogFrame =
    cameraFollowFrameCount % CAMERA_DEBUG_FRAME_INTERVAL === 0 ||
    !setPositionOk ||
    !lookAtOk;

  if (shouldLogFrame) {
    const cameraPosition = { x: 0, y: 0, z: 0 };
    const readBackOk = readCameraPosition(cameraPosition);
    logCameraDebug("tick", {
      frame: cameraFollowFrameCount,
      mode: cameraState.mode,
      targetEid: eid,
      targetPosition: { x: tx, y: ty, z: tz },
      desiredCameraPosition: {
        x: desiredCameraX,
        y: desiredCameraY,
        z: desiredCameraZ,
      },
      cameraClampedToFloor,
      cameraReadBackOk: readBackOk,
      cameraReadBackPosition: {
        x: cameraPosition.x,
        y: cameraPosition.y,
        z: cameraPosition.z,
      },
      followOffset:
        cameraState.mode === "follow"
          ? {
              x: cameraState.followOffset.x,
              y: cameraState.followOffset.y,
              z: cameraState.followOffset.z,
            }
          : null,
      followOrbit:
        cameraState.mode === "follow"
          ? {
              distance: cameraState.followDistance,
              actualDistance: cameraState.actualCameraDistance,
              yaw: cameraState.followYaw,
              pitch: cameraState.followPitch,
              orbitControlActive: cameraState.orbitControlActive,
            }
          : null,
      worldTimeDelta: world.time.delta,
      worldTimeElapsed: world.time.elapsed,
      setPositionOk,
      lookAtOk,
    });
  }
}
