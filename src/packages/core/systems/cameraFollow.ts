import { hasComponent } from "bitecs";
import type { CameraSettings, CameraViewMode, CoreWorld } from "../types";
import { findHighestFloorTopAtPosition, getFloorCollisionEids } from "./gravity";
import {
  applyToObjectByEid,
  lookCameraAt,
  readCameraPosition,
  setCameraPosition,
} from "./render";

type Vec3 = { x: number; y: number; z: number };
type PartialVec3 = Partial<Vec3>;
type CameraMode = "off" | "follow" | "lookAt";

const DEFAULT_FOLLOW_OFFSET: Vec3 = { x: 0, y: 4, z: 10 };
const DEFAULT_STATIONARY_POSITION: Vec3 = { x: 0, y: 4, z: 10 };
const MIN_FOLLOW_DISTANCE = 0.1;
const MAX_FOLLOW_PITCH = Math.PI * 0.48;
const CAMERA_GROUND_CLEARANCE = 0.1;
const CAMERA_PITCH_DRAG_MIN_RESPONSE = 0.2;
const CAMERA_PITCH_DRAG_EDGE_EXPONENT = 2;
const FIRST_PERSON_EYE_HEIGHT = 0.35;
const FIRST_PERSON_LOOK_DISTANCE = 10;
const CAMERA_DEBUG = false;
const CAMERA_DEBUG_FRAME_INTERVAL = 30;

let cameraFollowFrameCount = 0;
let lastSkipReason: string | null = null;
let hiddenFollowTargetEid = -1;

const cameraState: {
  mode: CameraMode;
  targetEid: number;
  followOffset: Vec3;
  followDistance: number;
  followYaw: number;
  followPitch: number;
  viewMode: CameraViewMode;
  lastTargetYaw: number;
  orbitControlActive: boolean;
  stationaryPosition: Vec3;
} = {
  mode: "off",
  targetEid: -1,
  followOffset: { ...DEFAULT_FOLLOW_OFFSET },
  followDistance: 1,
  followYaw: 0,
  followPitch: 0,
  viewMode: "follow",
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

function clampFollowDistance(distance: number): number {
  return Math.max(MIN_FOLLOW_DISTANCE, distance);
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
  const distance = clampFollowDistance(Math.hypot(horizontalDistance, y));

  cameraState.followDistance = distance;
  cameraState.followYaw = Math.atan2(x, z);
  cameraState.followPitch = clampFollowPitch(Math.atan2(y, horizontalDistance));
}

function syncFollowOffsetFromOrbit() {
  const horizontalDistance =
    Math.cos(cameraState.followPitch) * cameraState.followDistance;

  cameraState.followOffset.x = Math.sin(cameraState.followYaw) * horizontalDistance;
  cameraState.followOffset.y =
    Math.sin(cameraState.followPitch) * cameraState.followDistance;
  cameraState.followOffset.z = Math.cos(cameraState.followYaw) * horizontalDistance;
}

function logCameraDebug(message: string, data?: Record<string, unknown>) {
  if (!CAMERA_DEBUG) return;
  if (data) {
    console.log(`[cameraFollow] ${message}`, data);
    return;
  }
  console.log(`[cameraFollow] ${message}`);
}

function logSkipOnce(reason: string, data?: Record<string, unknown>) {
  if (!CAMERA_DEBUG) return;
  if (lastSkipReason === reason) return;
  lastSkipReason = reason;
  logCameraDebug(`skipping update: ${reason}`, data);
}

function clearSkipReason() {
  lastSkipReason = null;
}

function setTargetVisibility(eid: number, visible: boolean) {
  if (eid < 0) return;
  applyToObjectByEid(eid, (obj) => {
    obj.visible = visible;
  });
}

function syncFollowTargetVisibility() {
  const desiredHiddenEid =
    cameraState.mode === "follow" && cameraState.viewMode === "firstPerson"
      ? cameraState.targetEid
      : -1;

  if (
    hiddenFollowTargetEid >= 0 &&
    hiddenFollowTargetEid !== desiredHiddenEid
  ) {
    setTargetVisibility(hiddenFollowTargetEid, true);
  }

  hiddenFollowTargetEid = desiredHiddenEid;

  if (hiddenFollowTargetEid >= 0) {
    setTargetVisibility(hiddenFollowTargetEid, false);
  }
}

function getForwardVectorFromRotation(pitch: number, yaw: number) {
  const horizontalScale = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * horizontalScale,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * horizontalScale,
  };
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
  const floorEids = getFloorCollisionEids(world);
  if (floorEids.length === 0) return false;

  // Ignore floors above the current camera height so the camera does not jump to ceilings.
  const maxFloorTop =
    Math.max(currentCameraPosition.y, desiredPosition.y) + CAMERA_GROUND_CLEARANCE;
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
  syncFollowTargetVisibility();
  logCameraDebug("reset target", {
    mode: cameraState.mode,
    targetEid: cameraState.targetEid,
  });
}

export function setCameraFollowTarget(
  eid: number,
  opts: { offset?: PartialVec3 } = {},
) {
  cameraState.mode = "follow";
  cameraState.targetEid = eid;
  cameraState.lastTargetYaw = Number.NaN;
  assignVec3(cameraState.followOffset, opts.offset);
  syncFollowOrbitFromOffset();
  syncFollowTargetVisibility();
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
      viewMode: cameraState.viewMode,
    },
  });
}

export function adjustCameraFollowOrbit(deltaYaw: number, deltaPitch: number) {
  if (cameraState.mode !== "follow") return;
  if (cameraState.viewMode === "firstPerson") return;
  if (deltaYaw === 0 && deltaPitch === 0) return;

  const reducedDeltaPitch = reduceFollowPitchDelta(deltaPitch);
  cameraState.followYaw += deltaYaw;
  cameraState.followPitch = clampFollowPitch(
    cameraState.followPitch + reducedDeltaPitch,
  );
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
      viewMode: cameraState.viewMode,
    },
  });
}

export function setCameraFollowDistance(distance: number) {
  if (!Number.isFinite(distance)) return;
  cameraState.followDistance = clampFollowDistance(distance);
  syncFollowOffsetFromOrbit();

  logCameraDebug("set follow distance", {
    followDistance: cameraState.followDistance,
    followOffset: {
      x: cameraState.followOffset.x,
      y: cameraState.followOffset.y,
      z: cameraState.followOffset.z,
    },
  });
}

export function readCameraFollowDistance() {
  return cameraState.followDistance;
}

export function setCameraViewMode(viewMode: CameraViewMode) {
  cameraState.viewMode = viewMode;
  cameraState.orbitControlActive = false;
  syncFollowTargetVisibility();
}

export function readCameraFollowSettings(): Pick<
  CameraSettings,
  "followDistance" | "viewMode"
> {
  return {
    followDistance: cameraState.followDistance,
    viewMode: cameraState.viewMode,
  };
}

export function setCameraFollowOrbitControlActive(active: boolean) {
  if (cameraState.mode !== "follow") return;
  if (cameraState.viewMode === "firstPerson") return;
  cameraState.orbitControlActive = active;
}

export function setCameraLookAtTarget(
  eid: number,
  opts: { position?: PartialVec3 } = {},
) {
  cameraState.mode = "lookAt";
  cameraState.targetEid = eid;
  syncFollowTargetVisibility();
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
  let lookTargetX = tx;
  let lookTargetY = ty;
  let lookTargetZ = tz;
  let firstPersonForward: Vec3 | null = null;

  if (cameraState.mode === "follow") {
    const targetYaw = hasComponent(world, eid, Rotation) ? Rotation.yaw[eid] : Number.NaN;
    const targetPitch = hasComponent(world, eid, Rotation)
      ? Rotation.pitch[eid]
      : 0;

    if (Number.isFinite(targetYaw)) {
      if (cameraState.viewMode === "firstPerson") {
        cameraState.followYaw = targetYaw;
        syncFollowOffsetFromOrbit();
      } else if (
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

    if (cameraState.viewMode === "firstPerson") {
      const forward = getForwardVectorFromRotation(
        Number.isFinite(targetPitch) ? targetPitch : 0,
        Number.isFinite(targetYaw) ? targetYaw : 0,
      );
      firstPersonForward = forward;

      desiredCameraX = tx;
      desiredCameraY = ty + FIRST_PERSON_EYE_HEIGHT;
      desiredCameraZ = tz;
      lookTargetX = desiredCameraX + forward.x * FIRST_PERSON_LOOK_DISTANCE;
      lookTargetY = desiredCameraY + forward.y * FIRST_PERSON_LOOK_DISTANCE;
      lookTargetZ = desiredCameraZ + forward.z * FIRST_PERSON_LOOK_DISTANCE;
    } else {
      const offset = cameraState.followOffset;
      desiredCameraX = tx + offset.x;
      desiredCameraY = ty + offset.y;
      desiredCameraZ = tz + offset.z;
    }

    syncFollowTargetVisibility();
  } else {
    const p = cameraState.stationaryPosition;
    desiredCameraX = p.x;
    desiredCameraY = p.y;
    desiredCameraZ = p.z;
  }

  const desiredCameraPosition = {
    x: desiredCameraX,
    y: desiredCameraY,
    z: desiredCameraZ,
  };
  const currentCameraPosition = { ...desiredCameraPosition };
  readCameraPosition(currentCameraPosition);
  const cameraClampedToFloor = clampCameraHeightToFloor(
    world,
    desiredCameraPosition,
    currentCameraPosition,
  );
  desiredCameraX = desiredCameraPosition.x;
  desiredCameraY = desiredCameraPosition.y;
  desiredCameraZ = desiredCameraPosition.z;

  if (firstPersonForward) {
    lookTargetX = desiredCameraX + firstPersonForward.x * FIRST_PERSON_LOOK_DISTANCE;
    lookTargetY = desiredCameraY + firstPersonForward.y * FIRST_PERSON_LOOK_DISTANCE;
    lookTargetZ = desiredCameraZ + firstPersonForward.z * FIRST_PERSON_LOOK_DISTANCE;
  }

  const setPositionOk = setCameraPosition(
    desiredCameraX,
    desiredCameraY,
    desiredCameraZ,
  );
  const lookAtOk = lookCameraAt(lookTargetX, lookTargetY, lookTargetZ);
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
      lookTarget: {
        x: lookTargetX,
        y: lookTargetY,
        z: lookTargetZ,
      },
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
                yaw: cameraState.followYaw,
                pitch: cameraState.followPitch,
                viewMode: cameraState.viewMode,
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
