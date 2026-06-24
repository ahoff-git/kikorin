import type { CoreWorld } from "@kikorin/ecs";
import { log, logLevels } from "@kikorin/util";
import {
  Color,
  Scene,
  PerspectiveCamera,
  WebGLRenderer,
  Object3D,
  Material,
  BufferGeometry,
  DirectionalLight,
  AmbientLight,
  PCFSoftShadowMap,
  Vector3,
} from "three";
import { setActiveCamera, getActiveCamera } from "./renderCamera";

let scene: Scene | null = null;
let renderer: WebGLRenderer | null = null;
let sunLight: DirectionalLight | null = null;
let rendererViewportWidth = 0;
let rendererViewportHeight = 0;

const _camDir = new Vector3();
// Shadow frustum half-extent and derived texel size for snapping
const SUN_FRUSTUM_HALF = 60;
const SUN_TEXEL_SIZE = (SUN_FRUSTUM_HALF * 2) / 4096;

const objectsByEid = new Map<number, Object3D>();
const poolsByKey = new Map<string, Object3D[]>();
const DEFAULT_POOL_MAX = 256;
const RENDER_DEBUG_FRAME_INTERVAL = 30;

let renderFrameCount = 0;
let lastRenderSkipReason: string | null = null;

function logRenderDebug(message: string, data?: Record<string, unknown>) {
  if (data) {
    log(logLevels.debug, `[render] ${message}`, ["render"], data);
  } else {
    log(logLevels.debug, `[render] ${message}`, ["render"]);
  }
}

function logRenderSkipOnce(reason: string, data?: Record<string, unknown>) {
  if (lastRenderSkipReason === reason) return;
  lastRenderSkipReason = reason;
  logRenderDebug(`skipping frame: ${reason}`, data);
}

function clearRenderSkipReason() {
  lastRenderSkipReason = null;
}

export function renderSystem(world: CoreWorld) {
  const cam = getActiveCamera();
  if (!renderer || !scene || !cam) {
    logRenderSkipOnce("renderer/scene/camera missing", {
      hasRenderer: Boolean(renderer),
      hasScene: Boolean(scene),
      hasCamera: Boolean(cam),
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
        x: cam.position.x,
        y: cam.position.y,
        z: cam.position.z,
      },
      cameraRotation: {
        x: cam.rotation.x,
        y: cam.rotation.y,
        z: cam.rotation.z,
      },
      worldTimeDelta: world.time.delta,
      worldTimeElapsed: world.time.elapsed,
    });
  }

  if (sunLight) {
    // Center the shadow frustum on where the camera looks (player's feet),
    // not the camera body, which sits ~10 units behind the player.
    cam.getWorldDirection(_camDir);
    const groundT = _camDir.y < -0.001 ? -cam.position.y / _camDir.y : 12;
    const lookX = cam.position.x + _camDir.x * groundT;
    const lookZ = cam.position.z + _camDir.z * groundT;

    // Texel-snap to prevent shadow edges from crawling as the camera moves.
    const cx = Math.round(lookX / SUN_TEXEL_SIZE) * SUN_TEXEL_SIZE;
    const cz = Math.round(lookZ / SUN_TEXEL_SIZE) * SUN_TEXEL_SIZE;

    sunLight.target.position.set(cx, 0, cz);
    sunLight.position.set(cx + 50, 100, cz + 30);
  }

  renderer.render(scene, cam);
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
  sunLight = null;
  setActiveCamera(null);
  rendererViewportWidth = 0;
  rendererViewportHeight = 0;

  renderer?.dispose();
  renderer = null;
}

function updateCameraAspect(width: number, height: number) {
  const cam = getActiveCamera();
  if (!cam) return;
  cam.aspect = width / Math.max(height, 1);
  cam.updateProjectionMatrix();
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
  updateCameraAspect(nextWidth, nextHeight);
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
  const cam = new PerspectiveCamera(75, width / height, 0.1, 1000);
  cam.position.z = 5;
  setActiveCamera(cam);

  renderer = new WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: "high-performance",
  });

  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFSoftShadowMap;
  setRendererViewportSize(width, height);

  scene.background = new Color(0x87ceeb);

  const ambientLight = new AmbientLight(0xffd9a0, 1.2);
  scene.add(ambientLight);

  sunLight = new DirectionalLight(0xfff5e0, 2.5);
  sunLight.position.set(50, 100, 30);
  sunLight.castShadow = true;
  // 4096 map over a tight 50-unit frustum → ~82 texels/unit vs the previous ~11
  sunLight.shadow.mapSize.width = 4096;
  sunLight.shadow.mapSize.height = 4096;
  sunLight.shadow.camera.near = 0.5;
  sunLight.shadow.camera.far = 200;
  sunLight.shadow.camera.left = -SUN_FRUSTUM_HALF;
  sunLight.shadow.camera.right = SUN_FRUSTUM_HALF;
  sunLight.shadow.camera.top = SUN_FRUSTUM_HALF;
  sunLight.shadow.camera.bottom = -SUN_FRUSTUM_HALF;
  sunLight.shadow.bias = -0.001;
  scene.add(sunLight);
  scene.add(sunLight.target);

  logRenderDebug("renderer setup complete", {
    width,
    height,
    cameraInitialPosition: {
      x: cam.position.x,
      y: cam.position.y,
      z: cam.position.z,
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
