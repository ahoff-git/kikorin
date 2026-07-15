import { log, logLevels } from "@kikorin/util";
import type { Camera } from "three";

const CAMERA_LOG_INTERVAL = 30;

// Camera (three's base class) rather than PerspectiveCamera specifically —
// setupRenderer constructs either a PerspectiveCamera ("3d") or an
// OrthographicCamera ("2d"); every operation here (position, lookAt) is
// defined on the base class, so this module never needs to branch on which.
let camera: Camera | null = null;
let setCameraPositionCallCount = 0;
let lookCameraAtCallCount = 0;

export function setActiveCamera(c: Camera | null) {
  camera = c;
  setCameraPositionCallCount = 0;
  lookCameraAtCallCount = 0;
}

export function getActiveCamera(): Camera | null {
  return camera;
}

export function setCameraPosition(x: number, y: number, z: number): boolean {
  if (!camera) {
    log(logLevels.debug, "[render] setCameraPosition failed: camera missing", ["render"], { x, y, z });
    return false;
  }

  setCameraPositionCallCount += 1;
  const previous = { x: camera.position.x, y: camera.position.y, z: camera.position.z };
  camera.position.set(x, y, z);

  if (setCameraPositionCallCount <= 10 || setCameraPositionCallCount % CAMERA_LOG_INTERVAL === 0) {
    log(logLevels.debug, "[render] setCameraPosition", ["render"], {
      call: setCameraPositionCallCount,
      previous,
      next: { x, y, z },
    });
  }

  return true;
}

/**
 * Sets the camera's up vector — needed once, at setup, for a camera that
 * will look straight down (or up): `lookAt`'s orientation math is degenerate
 * when the view direction is parallel to `up` (the default `(0,1,0)`), so a
 * top-down camera must pick a different up vector before its first
 * `lookCameraAt` call, or the resulting orientation is undefined.
 */
export function setCameraUp(x: number, y: number, z: number): boolean {
  if (!camera) {
    log(logLevels.debug, "[render] setCameraUp failed: camera missing", ["render"], { x, y, z });
    return false;
  }
  camera.up.set(x, y, z);
  return true;
}

export function lookCameraAt(x: number, y: number, z: number): boolean {
  if (!camera) {
    log(logLevels.debug, "[render] lookCameraAt failed: camera missing", ["render"], { x, y, z });
    return false;
  }

  lookCameraAtCallCount += 1;
  camera.lookAt(x, y, z);

  if (lookCameraAtCallCount <= 10 || lookCameraAtCallCount % CAMERA_LOG_INTERVAL === 0) {
    log(logLevels.debug, "[render] lookCameraAt", ["render"], {
      call: lookCameraAtCallCount,
      target: { x, y, z },
      resultingRotation: {
        x: camera.rotation.x,
        y: camera.rotation.y,
        z: camera.rotation.z,
      },
    });
  }

  return true;
}

