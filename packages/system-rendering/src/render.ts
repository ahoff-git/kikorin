import { log, logLevels } from "@kikorin/util";
import {
  Color,
  Scene,
  PerspectiveCamera,
  OrthographicCamera,
  type Camera,
  WebGLRenderer,
  Object3D,
  Material,
  BufferGeometry,
  DirectionalLight,
  AmbientLight,
  PCFShadowMap,
  Vector3,
} from "three";
import { setActiveCamera, getActiveCamera } from "./renderCamera";

/**
 * Setup-time choice, fixed for a renderer's lifetime (mirrors
 * `physics::Dimension` in the Rust engine — the two are independent knobs a
 * game picks together, not coupled at the type level). `"3d"` is the
 * original behavior: `PerspectiveCamera` plus a directional "sun" light with
 * shadow mapping. `"2d"` uses `OrthographicCamera` and flat ambient-only
 * lighting — no shadow rig, since dynamic shadows rarely make sense for a 2D
 * scene. Geometry/mesh choice is still entirely up to the caller (this
 * package never constructs meshes); a 2D game supplies its own flat/sprite
 * geometry to `upsertObjectByEid` same as a 3D game supplies boxes.
 */
export type RenderMode = "2d" | "3d";

let scene: Scene | null = null;
let renderer: WebGLRenderer | null = null;
let sunLight: DirectionalLight | null = null;
let rendererViewportWidth = 0;
let rendererViewportHeight = 0;
let renderMode: RenderMode = "3d";

const _camDir = new Vector3();
// Shadow frustum half-extent and derived texel size for snapping
const SUN_FRUSTUM_HALF = 60;
const SHADOW_MAP_SIZE = 2048;
const SHADOW_UPDATE_EVERY = 3;
const SUN_TEXEL_SIZE = (SUN_FRUSTUM_HALF * 2) / SHADOW_MAP_SIZE;
// Default world-space vertical extent visible through the 2D orthographic
// camera — arbitrary but reasonable for a human-scale 2D scene; callers
// needing a different scale should zoom the camera itself (Object3D-level,
// via three's own APIs) after setup.
const ORTHO_VIEW_HEIGHT = 20;
// World-space height the orthographic camera's frustum spans at zoom=1;
// width follows from the current aspect ratio. Unused in "3d" mode.
let orthoViewHeight = ORTHO_VIEW_HEIGHT;

const objectsByEid = new Map<number, Object3D>();
const RENDER_DEBUG_FRAME_INTERVAL = 30;

let renderFrameCount = 0;
// Rendering-pipeline metric: EMA of renderFrame() duration (α = 0.1). Covers the
// main-thread Three.js draw; the engine's MetricsPatch covers the Rust/worker side.
let emaFrameMs = 0;
let lastRenderSkipReason: string | null = null;
let lastSunCX = Infinity;
let lastSunCZ = Infinity;

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

/** Which mode the active renderer was set up with — introspection only, "3d" before setup. */
export function getRenderMode(): RenderMode {
  return renderMode;
}

export interface RenderMetrics {
  /** Exponential moving average of renderFrame() duration in milliseconds. */
  frame_ms: number;
}

export function getRenderMetrics(): RenderMetrics {
  return { frame_ms: emaFrameMs };
}

export function renderFrame() {
  const cam = getActiveCamera();
  if (!renderer || !scene || !cam) {
    logRenderSkipOnce("renderer/scene/camera missing", {
      hasRenderer: Boolean(renderer),
      hasScene: Boolean(scene),
      hasCamera: Boolean(cam),
    });
    return;
  }

  const frameStart = performance.now();
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
    });
  }

  // Update shadow map: throttle to every Nth frame; force an update if the sun moved.
  let needsShadowUpdate = renderFrameCount % SHADOW_UPDATE_EVERY === 0;

  if (sunLight) {
    cam.getWorldDirection(_camDir);
    const groundT = _camDir.y < -0.001 ? -cam.position.y / _camDir.y : 12;
    const lookX = cam.position.x + _camDir.x * groundT;
    const lookZ = cam.position.z + _camDir.z * groundT;

    const cx = Math.round(lookX / SUN_TEXEL_SIZE) * SUN_TEXEL_SIZE;
    const cz = Math.round(lookZ / SUN_TEXEL_SIZE) * SUN_TEXEL_SIZE;

    if (cx !== lastSunCX || cz !== lastSunCZ) {
      lastSunCX = cx;
      lastSunCZ = cz;
      sunLight.target.position.set(cx, 0, cz);
      sunLight.target.updateMatrixWorld();
      sunLight.position.set(cx + 50, 100, cz + 30);
      needsShadowUpdate = true;
    }
  }

  renderer.shadowMap.needsUpdate = needsShadowUpdate;
  renderer.render(scene, cam);

  const frameMs = performance.now() - frameStart;
  emaFrameMs = emaFrameMs === 0 ? frameMs : emaFrameMs * 0.9 + frameMs * 0.1;
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
  });

  for (const obj of objectsByEid.values()) {
    obj.parent?.remove(obj);
    disposeObject3D(obj);
  }
  objectsByEid.clear();

  scene?.clear();
  scene = null;
  sunLight = null;
  setActiveCamera(null);
  rendererViewportWidth = 0;
  rendererViewportHeight = 0;
  renderMode = "3d";
  lastSunCX = Infinity;
  lastSunCZ = Infinity;

  renderer?.dispose();
  renderer = null;
}

function updateCameraAspect(width: number, height: number) {
  const cam = getActiveCamera();
  if (!cam) return;
  const aspect = width / Math.max(height, 1);
  // updateProjectionMatrix isn't on the base Camera type (three's other
  // camera kinds compute it differently, some not at all) — called inside
  // each branch, where cam is narrowed to a type that actually has it.
  if (cam instanceof OrthographicCamera) {
    // Orthographic has no `.aspect` field — the frustum's world-space extent
    // is fixed (orthoViewHeight) and width follows the aspect ratio instead.
    const halfHeight = orthoViewHeight / 2;
    const halfWidth = halfHeight * aspect;
    cam.left = -halfWidth;
    cam.right = halfWidth;
    cam.top = halfHeight;
    cam.bottom = -halfHeight;
    cam.updateProjectionMatrix();
  } else if (cam instanceof PerspectiveCamera) {
    cam.aspect = aspect;
    cam.updateProjectionMatrix();
  }
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

export function setupRenderer(canvas: HTMLCanvasElement | null, mode: RenderMode = "3d") {
  if (!canvas) {
    logRenderDebug("setupRenderer skipped: canvas is null");
    return;
  }

  clearRenderState();
  renderMode = mode;

  const width = canvas.clientWidth || canvas.width || 1;
  const height = canvas.clientHeight || canvas.height || 1;

  scene = new Scene();

  let cam: Camera;
  if (mode === "2d") {
    const aspect = width / Math.max(height, 1);
    const halfHeight = orthoViewHeight / 2;
    const halfWidth = halfHeight * aspect;
    const ortho = new OrthographicCamera(-halfWidth, halfWidth, halfHeight, -halfHeight, 0.1, 1000);
    ortho.position.z = 5;
    cam = ortho;
  } else {
    const perspective = new PerspectiveCamera(75, width / height, 0.1, 1000);
    perspective.position.z = 5;
    cam = perspective;
  }
  setActiveCamera(cam);

  renderer = new WebGLRenderer({
    canvas,
    antialias: false,
    powerPreference: "high-performance",
  });

  const pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
  renderer.setPixelRatio(pixelRatio);
  setRendererViewportSize(width, height);

  scene.background = new Color(0x87ceeb);

  if (mode === "2d") {
    // Flat lighting only — no directional "sun"/shadow rig. Dynamic shadows
    // rarely make sense for a 2D scene, and skipping them avoids the shadow
    // map + frustum-tracking overhead entirely.
    renderer.shadowMap.enabled = false;
    const ambientLight = new AmbientLight(0xffffff, 1.5);
    scene.add(ambientLight);
  } else {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFShadowMap;
    renderer.shadowMap.autoUpdate = false;

    const ambientLight = new AmbientLight(0xffd9a0, 1.2);
    scene.add(ambientLight);

    sunLight = new DirectionalLight(0xfff5e0, 2.5);
    sunLight.position.set(50, 100, 30);
    sunLight.castShadow = true;
    sunLight.shadow.mapSize.width = SHADOW_MAP_SIZE;
    sunLight.shadow.mapSize.height = SHADOW_MAP_SIZE;
    sunLight.shadow.camera.near = 0.5;
    sunLight.shadow.camera.far = 200;
    sunLight.shadow.camera.left = -SUN_FRUSTUM_HALF;
    sunLight.shadow.camera.right = SUN_FRUSTUM_HALF;
    sunLight.shadow.camera.top = SUN_FRUSTUM_HALF;
    sunLight.shadow.camera.bottom = -SUN_FRUSTUM_HALF;
    sunLight.shadow.bias = -0.001;
    scene.add(sunLight);
    scene.add(sunLight.target);
  }

  logRenderDebug("renderer setup complete", {
    width,
    height,
    cameraInitialPosition: {
      x: cam.position.x,
      y: cam.position.y,
      z: cam.position.z,
    },
    pixelRatio,
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
