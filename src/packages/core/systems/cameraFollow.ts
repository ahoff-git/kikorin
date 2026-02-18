import type { CoreWorld } from "../core";
import { lookCameraAt, readCameraPosition, setCameraPosition } from "./render";

type Vec3 = { x: number; y: number; z: number };
type PartialVec3 = Partial<Vec3>;
type CameraMode = "off" | "follow" | "lookAt";

const DEFAULT_FOLLOW_OFFSET: Vec3 = { x: 0, y: 4, z: 10 };
const DEFAULT_STATIONARY_POSITION: Vec3 = { x: 0, y: 4, z: 10 };

const cameraState: {
  mode: CameraMode;
  targetEid: number;
  followOffset: Vec3;
  stationaryPosition: Vec3;
} = {
  mode: "off",
  targetEid: -1,
  followOffset: { ...DEFAULT_FOLLOW_OFFSET },
  stationaryPosition: { ...DEFAULT_STATIONARY_POSITION },
};

function assignVec3(target: Vec3, source?: PartialVec3) {
  if (!source) return;
  if (source.x !== undefined) target.x = source.x;
  if (source.y !== undefined) target.y = source.y;
  if (source.z !== undefined) target.z = source.z;
}

export function resetCameraTarget() {
  cameraState.mode = "off";
  cameraState.targetEid = -1;
}

export function setCameraFollowTarget(
  eid: number,
  opts: { offset?: PartialVec3 } = {}
) {
  cameraState.mode = "follow";
  cameraState.targetEid = eid;
  assignVec3(cameraState.followOffset, opts.offset);
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
    readCameraPosition(cameraState.stationaryPosition);
  }
}

export function cameraFollowSystem(world: CoreWorld) {
  if (cameraState.mode === "off") return;
  const eid = cameraState.targetEid;
  if (eid < 0) return;

  const { Position } = world.components;
  const tx = Position.x[eid];
  const ty = Position.y[eid];
  const tz = Position.z[eid];

  if (cameraState.mode === "follow") {
    const offset = cameraState.followOffset;
    setCameraPosition(tx + offset.x, ty + offset.y, tz + offset.z);
  } else {
    const p = cameraState.stationaryPosition;
    setCameraPosition(p.x, p.y, p.z);
  }

  lookCameraAt(tx, ty, tz);
}
