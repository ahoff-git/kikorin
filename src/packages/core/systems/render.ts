import type { CoreWorld } from "../core";
import {
  Scene,
  PerspectiveCamera,
  WebGLRenderer,
  Object3D,
  Material,
  BufferGeometry,
} from "three";

let scene: Scene | null = null;
let camera: PerspectiveCamera | null = null;
let renderer: WebGLRenderer | null = null;

const objectsByEid = new Map<number, Object3D>();
const poolsByKey = new Map<string, Object3D[]>();
const DEFAULT_POOL_MAX = 256;

export function renderSystem(_world: CoreWorld) {
  if (!renderer || !scene || !camera) return;
  renderer.render(scene, camera);
}

export function setCameraPosition(x: number, y: number, z: number): boolean {
  if (!camera) return false;
  camera.position.set(x, y, z);
  return true;
}

export function lookCameraAt(x: number, y: number, z: number): boolean {
  if (!camera) return false;
  camera.lookAt(x, y, z);
  return true;
}

export function readCameraPosition(out: {
  x: number;
  y: number;
  z: number;
}): boolean {
  if (!camera) return false;
  out.x = camera.position.x;
  out.y = camera.position.y;
  out.z = camera.position.z;
  return true;
}

function disposeObject3D(root: Object3D) {
  root.traverse((o) => {
    const candidate = o as Object3D & {
      geometry?: BufferGeometry;
      material?: Material | Material[];
    };

    candidate.geometry?.dispose?.();

    const mat = candidate.material;
    if (Array.isArray(mat)) {
      for (let i = 0; i < mat.length; i += 1) mat[i]?.dispose?.();
    } else {
      mat?.dispose?.();
    }
  });
}

function clearRenderState() {
  for (const obj of objectsByEid.values()) {
    obj.parent?.remove(obj);
    disposeObject3D(obj);
  }
  objectsByEid.clear();

  for (const pool of poolsByKey.values()) {
    for (const obj of pool) disposeObject3D(obj);
  }
  poolsByKey.clear();

  scene?.clear();
  scene = null;
  camera = null;

  renderer?.dispose();
  renderer = null;
}

export function setupRenderer(canvas: HTMLCanvasElement | null) {
  if (!canvas) return;

  clearRenderState();

  const width = canvas.clientWidth || canvas.width || 1;
  const height = canvas.clientHeight || canvas.height || 1;

  scene = new Scene();
  camera = new PerspectiveCamera(75, width / height, 0.1, 1000);
  camera.position.z = 5;

  renderer = new WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: "high-performance",
  });

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.setSize(width, height, false);
}

function assertScene(): Scene {
  if (!scene) {
    throw new Error("Renderer not set up yet. Call setupRenderer(canvas) first.");
  }
  return scene;
}

export function upsertObjectByEid(
  eid: number,
  objOrFactory: Object3D | (() => Object3D),
): Object3D {
  const s = assertScene();

  let obj = objectsByEid.get(eid);
  if (!obj) {
    obj = typeof objOrFactory === "function" ? objOrFactory() : objOrFactory;
    objectsByEid.set(eid, obj);
    obj.userData.eid = eid;
    delete obj.userData.poolKey;
    s.add(obj);
  }

  return obj;
}

export function applyToObjectByEid(
  eid: number,
  fn: (obj: Object3D) => void,
): boolean {
  const obj = objectsByEid.get(eid);
  if (!obj) return false;
  fn(obj);
  return true;
}

export function setObjectTransformByEid(
  eid: number,
  x: number,
  y: number,
  z: number,
  pitch: number,
  yaw: number,
  roll: number,
): boolean {
  const obj = objectsByEid.get(eid);
  if (!obj) return false;

  obj.position.set(x, y, z);
  obj.rotation.set(pitch, yaw, roll);
  return true;
}

export function removeObjectByEid(
  eid: number,
  opts: { dispose?: boolean } = {},
): boolean {
  const obj = objectsByEid.get(eid);
  if (!obj) return false;

  objectsByEid.delete(eid);
  obj.parent?.remove(obj);
  delete obj.userData.eid;

  if (opts.dispose) disposeObject3D(obj);
  return true;
}

export function addToScene(obj: Object3D) {
  assertScene().add(obj);
  return obj;
}

export function removeFromScene(obj: Object3D) {
  obj.parent?.remove(obj);
}

type PoolOpts = {
  onAcquire?: (obj: Object3D) => void;
  onRelease?: (obj: Object3D) => void;
  maxPerKey?: number;
};

function getPool(key: string): Object3D[] {
  let pool = poolsByKey.get(key);
  if (!pool) {
    pool = [];
    poolsByKey.set(key, pool);
  }
  return pool;
}

function resetPooledObject(obj: Object3D) {
  obj.visible = false;
  obj.position.set(0, 0, 0);
  obj.rotation.set(0, 0, 0);
  obj.scale.set(1, 1, 1);
  delete obj.userData.eid;
}

export function upsertPooledByEid(
  eid: number,
  key: string,
  factory: () => Object3D,
  opts: PoolOpts = {},
): Object3D {
  const existing = objectsByEid.get(eid);
  if (existing) return existing;

  const pool = getPool(key);
  const obj = pool.pop() ?? factory();

  objectsByEid.set(eid, obj);
  obj.userData.eid = eid;
  obj.userData.poolKey = key;
  obj.visible = true;

  opts.onAcquire?.(obj);
  addToScene(obj);

  return obj;
}

export function removePooledByEid(eid: number, opts: PoolOpts = {}): boolean {
  const obj = objectsByEid.get(eid);
  if (!obj) return false;

  objectsByEid.delete(eid);
  removeFromScene(obj);

  opts.onRelease?.(obj);
  resetPooledObject(obj);

  const key = obj.userData.poolKey as string | undefined;
  if (!key) {
    disposeObject3D(obj);
    return true;
  }

  const pool = getPool(key);
  const max = opts.maxPerKey ?? DEFAULT_POOL_MAX;

  if (pool.length < max) {
    pool.push(obj);
  } else {
    delete obj.userData.poolKey;
    disposeObject3D(obj);
  }

  return true;
}
