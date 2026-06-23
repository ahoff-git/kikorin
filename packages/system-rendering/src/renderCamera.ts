import { log, logLevels } from "@kikorin/util";
import type { PerspectiveCamera } from "three";

const CAMERA_LOG_INTERVAL = 30;

let camera: PerspectiveCamera | null = null;
let setCameraPositionCallCount = 0;
let lookCameraAtCallCount = 0;

export function setActiveCamera(c: PerspectiveCamera | null) {
  camera = c;
  setCameraPositionCallCount = 0;
  lookCameraAtCallCount = 0;
}

export function getActiveCamera(): PerspectiveCamera | null {
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

export function readCameraPosition(out: { x: number; y: number; z: number }): boolean {
  if (!camera) {
    log(logLevels.debug, "[render] readCameraPosition failed: camera missing", ["render"]);
    return false;
  }
  out.x = camera.position.x;
  out.y = camera.position.y;
  out.z = camera.position.z;
  return true;
}
