import type { CoreWorld } from "../core";
import { lookCameraAt, readCameraPosition, setCameraPosition } from "./render";

type Vec3 = { x: number; y: number; z: number };
type PartialVec3 = Partial<Vec3>;
type CameraMode = "off" | "follow" | "lookAt";

const DEFAULT_FOLLOW_OFFSET: Vec3 = { x: 0, y: 4, z: 10 };
const DEFAULT_STATIONARY_POSITION: Vec3 = { x: 0, y: 4, z: 10 };
const MIN_FOLLOW_DISTANCE = 0.1;
const MAX_FOLLOW_PITCH = Math.PI * 0.48;
const CAMERA_DEBUG = false;
const CAMERA_DEBUG_FRAME_INTERVAL = 30;

let cameraFollowFrameCount = 0;
let lastSkipReason: string | null = null;

const cameraState: {
  mode: CameraMode;
  targetEid: number;
  followOffset: Vec3;
  followDistance: number;
  followYaw: number;
  followPitch: number;
  stationaryPosition: Vec3;
} = {
  mode: "off",
  targetEid: -1,
  followOffset: { ...DEFAULT_FOLLOW_OFFSET },
  followDistance: 1,
  followYaw: 0,
  followPitch: 0,
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

syncFollowOrbitFromOffset();

export function resetCameraTarget() {
  cameraState.mode = "off";
  cameraState.targetEid = -1;
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
  assignVec3(cameraState.followOffset, opts.offset);
  syncFollowOrbitFromOffset();
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

  cameraState.followYaw += deltaYaw;
  cameraState.followPitch = clampFollowPitch(cameraState.followPitch + deltaPitch);
  syncFollowOffsetFromOrbit();

  logCameraDebug("adjust follow orbit", {
    deltaYaw,
    deltaPitch,
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

  const { Position } = world.components;
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
    const offset = cameraState.followOffset;
    desiredCameraX = tx + offset.x;
    desiredCameraY = ty + offset.y;
    desiredCameraZ = tz + offset.z;
  } else {
    const p = cameraState.stationaryPosition;
    desiredCameraX = p.x;
    desiredCameraY = p.y;
    desiredCameraZ = p.z;
  }

  const setPositionOk = setCameraPosition(
    desiredCameraX,
    desiredCameraY,
    desiredCameraZ,
  );
  const lookAtOk = lookCameraAt(tx, ty, tz);
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
            }
          : null,
      worldTimeDelta: world.time.delta,
      worldTimeElapsed: world.time.elapsed,
      setPositionOk,
      lookAtOk,
    });
  }
}
