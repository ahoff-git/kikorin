import type { CameraSettings, CoreWorld, ProjectionMode } from "../types";
import {
  Scene,
  OrthographicCamera,
  PerspectiveCamera,
  WebGLRenderer,
  Object3D,
  Material,
  BufferGeometry,
} from "three";

type RenderCamera = PerspectiveCamera | OrthographicCamera;

let scene: Scene | null = null;
let camera: RenderCamera | null = null;
let renderer: WebGLRenderer | null = null;
let rendererViewportWidth = 0;
let rendererViewportHeight = 0;

const objectsByEid = new Map<number, Object3D>();
const poolsByKey = new Map<string, Object3D[]>();
const DEFAULT_POOL_MAX = 256;
const RENDER_DEBUG = false;
const RENDER_DEBUG_FRAME_INTERVAL = 30;

let renderFrameCount = 0;
let setCameraPositionCallCount = 0;
let lookCameraAtCallCount = 0;
let lastRenderSkipReason: string | null = null;

const DEFAULT_CAMERA_FOV = 75;
const MIN_CAMERA_FOV = 20;
const MAX_CAMERA_FOV = 140;
const DEFAULT_PROJECTION_MODE: ProjectionMode = "perspective";
const DEFAULT_ORTHOGRAPHIC_ZOOM = 1;
const MIN_ORTHOGRAPHIC_ZOOM = 0.25;
const MAX_ORTHOGRAPHIC_ZOOM = 12;
const ORTHOGRAPHIC_FRUSTUM_HEIGHT = 18;

let perspectiveFov = DEFAULT_CAMERA_FOV;
let projectionMode: ProjectionMode = DEFAULT_PROJECTION_MODE;
let orthographicZoom = DEFAULT_ORTHOGRAPHIC_ZOOM;

function logRenderDebug(message: string, data?: Record<string, unknown>) {
  if (!RENDER_DEBUG) return;
  if (data) {
    console.log(`[render] ${message}`, data);
    return;
  }
  console.log(`[render] ${message}`);
}

function logRenderSkipOnce(reason: string, data?: Record<string, unknown>) {
  if (!RENDER_DEBUG) return;
  if (lastRenderSkipReason === reason) return;
  lastRenderSkipReason = reason;
  logRenderDebug(`skipping frame: ${reason}`, data);
}

function clearRenderSkipReason() {
  lastRenderSkipReason = null;
}

function clampCameraFov(fov: number) {
  return Math.max(MIN_CAMERA_FOV, Math.min(MAX_CAMERA_FOV, fov));
}

function clampOrthographicZoom(zoom: number) {
  return Math.max(MIN_ORTHOGRAPHIC_ZOOM, Math.min(MAX_ORTHOGRAPHIC_ZOOM, zoom));
}

function getViewportSize() {
  if (renderer) {
    const canvas = renderer.domElement;
    return {
      width: canvas.clientWidth || rendererViewportWidth || canvas.width || 1,
      height: canvas.clientHeight || rendererViewportHeight || canvas.height || 1,
    };
  }

  return {
    width: rendererViewportWidth || 1,
    height: rendererViewportHeight || 1,
  };
}

function configureCameraProjection(
  activeCamera: RenderCamera,
  width: number,
  height: number,
) {
  const safeWidth = Math.max(1, width);
  const safeHeight = Math.max(1, height);
  const aspect = safeWidth / safeHeight;

  if (activeCamera instanceof PerspectiveCamera) {
    activeCamera.fov = perspectiveFov;
    activeCamera.aspect = aspect;
  } else {
    const halfHeight = ORTHOGRAPHIC_FRUSTUM_HEIGHT / 2;
    const halfWidth = halfHeight * aspect;
    activeCamera.left = -halfWidth;
    activeCamera.right = halfWidth;
    activeCamera.top = halfHeight;
    activeCamera.bottom = -halfHeight;
    activeCamera.zoom = orthographicZoom;
  }

  activeCamera.updateProjectionMatrix();
}

function createCameraForProjection(
  width: number,
  height: number,
  previousCamera: RenderCamera | null,
) {
  const nextCamera: RenderCamera =
    projectionMode === "orthographic"
      ? new OrthographicCamera(-1, 1, 1, -1, 0.1, 1000)
      : new PerspectiveCamera(perspectiveFov, Math.max(1, width) / Math.max(1, height), 0.1, 1000);

  if (previousCamera) {
    nextCamera.position.copy(previousCamera.position);
    nextCamera.quaternion.copy(previousCamera.quaternion);
    nextCamera.up.copy(previousCamera.up);
    nextCamera.rotation.order = previousCamera.rotation.order;
  } else {
    nextCamera.position.z = 5;
  }

  configureCameraProjection(nextCamera, width, height);
  return nextCamera;
}

export function renderSystem(world: CoreWorld) {
  if (!renderer || !scene || !camera) {
    logRenderSkipOnce("renderer/scene/camera missing", {
      hasRenderer: Boolean(renderer),
      hasScene: Boolean(scene),
      hasCamera: Boolean(camera),
    });
    return;
  }

  syncRendererViewportSize();
  clearRenderSkipReason();
  renderFrameCount += 1;
  if (renderFrameCount % RENDER_DEBUG_FRAME_INTERVAL === 0) {
    logRenderDebug("tick", {
      frame: renderFrameCount,
      sceneChildren: scene.children.length,
      cameraPosition: {
        x: camera.position.x,
        y: camera.position.y,
        z: camera.position.z,
      },
      cameraRotation: {
        x: camera.rotation.x,
        y: camera.rotation.y,
        z: camera.rotation.z,
      },
      worldTimeDelta: world.time.delta,
      worldTimeElapsed: world.time.elapsed,
    });
  }

  renderer.render(scene, camera);
}

export function setCameraPosition(x: number, y: number, z: number): boolean {
  if (!camera) {
    logRenderDebug("setCameraPosition failed: camera missing", { x, y, z });
    return false;
  }

  setCameraPositionCallCount += 1;
  const previous = {
    x: camera.position.x,
    y: camera.position.y,
    z: camera.position.z,
  };
  camera.position.set(x, y, z);

  if (
    setCameraPositionCallCount <= 10 ||
    setCameraPositionCallCount % RENDER_DEBUG_FRAME_INTERVAL === 0
  ) {
    logRenderDebug("setCameraPosition", {
      call: setCameraPositionCallCount,
      previous,
      next: { x, y, z },
    });
  }

  return true;
}

export function lookCameraAt(x: number, y: number, z: number): boolean {
  if (!camera) {
    logRenderDebug("lookCameraAt failed: camera missing", { x, y, z });
    return false;
  }

  lookCameraAtCallCount += 1;
  camera.lookAt(x, y, z);

  if (
    lookCameraAtCallCount <= 10 ||
    lookCameraAtCallCount % RENDER_DEBUG_FRAME_INTERVAL === 0
  ) {
    logRenderDebug("lookCameraAt", {
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

export function readCameraPosition(out: {
  x: number;
  y: number;
  z: number;
}): boolean {
  if (!camera) {
    logRenderDebug("readCameraPosition failed: camera missing");
    return false;
  }
  out.x = camera.position.x;
  out.y = camera.position.y;
  out.z = camera.position.z;
  return true;
}

export function setCameraFov(fov: number): boolean {
  if (!Number.isFinite(fov)) {
    logRenderDebug("setCameraFov failed", {
      fov,
    });
    return false;
  }

  perspectiveFov = clampCameraFov(fov);

  if (camera instanceof PerspectiveCamera) {
    camera.fov = perspectiveFov;
    camera.updateProjectionMatrix();
  }

  logRenderDebug("setCameraFov", {
    fov: perspectiveFov,
    projectionMode,
  });
  return true;
}

export function readCameraFov() {
  return perspectiveFov;
}

export function setOrthographicZoom(zoom: number): boolean {
  if (!Number.isFinite(zoom)) {
    logRenderDebug("setOrthographicZoom failed", { zoom });
    return false;
  }

  orthographicZoom = clampOrthographicZoom(zoom);

  if (camera instanceof OrthographicCamera) {
    camera.zoom = orthographicZoom;
    camera.updateProjectionMatrix();
  }

  logRenderDebug("setOrthographicZoom", {
    orthographicZoom,
    projectionMode,
  });
  return true;
}

export function setProjectionMode(nextProjectionMode: ProjectionMode): boolean {
  if (
    nextProjectionMode !== "perspective" &&
    nextProjectionMode !== "orthographic"
  ) {
    logRenderDebug("setProjectionMode failed", {
      projectionMode: nextProjectionMode,
    });
    return false;
  }

  if (projectionMode === nextProjectionMode) return false;
  projectionMode = nextProjectionMode;

  const { width, height } = getViewportSize();
  camera = createCameraForProjection(width, height, camera);
  logRenderDebug("setProjectionMode", {
    projectionMode,
    width,
    height,
  });
  return true;
}

export function readProjectionSettings(): Pick<
  CameraSettings,
  "fov" | "projectionMode" | "orthographicZoom"
> {
  return {
    fov: perspectiveFov,
    projectionMode,
    orthographicZoom,
  };
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
  logRenderDebug("clearing render state", {
    activeObjects: objectsByEid.size,
    poolKeys: poolsByKey.size,
  });

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
  rendererViewportWidth = 0;
  rendererViewportHeight = 0;
  perspectiveFov = DEFAULT_CAMERA_FOV;
  projectionMode = DEFAULT_PROJECTION_MODE;
  orthographicZoom = DEFAULT_ORTHOGRAPHIC_ZOOM;

  renderer?.dispose();
  renderer = null;
}

function updateCameraProjection(width: number, height: number) {
  if (!camera) return;
  configureCameraProjection(camera, width, height);
}

function setRendererViewportSize(width: number, height: number) {
  if (!renderer) return false;

  const nextWidth = Math.max(1, Math.round(width));
  const nextHeight = Math.max(1, Math.round(height));
  if (
    rendererViewportWidth === nextWidth &&
    rendererViewportHeight === nextHeight
  ) {
    return false;
  }

  rendererViewportWidth = nextWidth;
  rendererViewportHeight = nextHeight;
  renderer.setSize(nextWidth, nextHeight, false);
  updateCameraProjection(nextWidth, nextHeight);
  return true;
}

function syncRendererViewportSize() {
  if (!renderer) return false;

  const canvas = renderer.domElement;
  const width = canvas.clientWidth || rendererViewportWidth || canvas.width || 1;
  const height =
    canvas.clientHeight || rendererViewportHeight || canvas.height || 1;
  return setRendererViewportSize(width, height);
}

export function setupRenderer(canvas: HTMLCanvasElement | null) {
  if (!canvas) {
    logRenderDebug("setupRenderer skipped: canvas is null");
    return;
  }

  clearRenderState();

  const width = canvas.clientWidth || canvas.width || 1;
  const height = canvas.clientHeight || canvas.height || 1;

  scene = new Scene();
  camera = createCameraForProjection(width, height, null);

  renderer = new WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: "high-performance",
  });

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  setRendererViewportSize(width, height);

  logRenderDebug("renderer setup complete", {
    width,
    height,
    cameraInitialPosition: {
      x: camera.position.x,
      y: camera.position.y,
      z: camera.position.z,
    },
    pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
  });
}

export function disposeRenderer() {
  clearRenderState();
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

export function setObjectTouchingByEid(
  eid: number,
  touching: boolean,
): boolean {
  const obj = objectsByEid.get(eid);
  if (!obj) return false;

  let applied = false;
  obj.traverse((node) => {
    const candidate = node as Object3D & {
      material?: Material | Material[];
      userData: {
        baseMaterial?: Material | Material[];
        touchMaterial?: Material | Material[];
      };
    };

    if (candidate.material === undefined) return;

    const nextMaterial = touching
      ? candidate.userData.touchMaterial
      : candidate.userData.baseMaterial;

    if (!nextMaterial || candidate.material === nextMaterial) return;

    candidate.material = nextMaterial;
    applied = true;
  });

  return applied;
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
  obj.rotation.order = "YXZ";
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
  obj.rotation.order = "YXZ";
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
