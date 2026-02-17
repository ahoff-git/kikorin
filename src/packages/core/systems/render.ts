import { CoreWorld } from "../core";
import { Scene, PerspectiveCamera, WebGLRenderer, Camera, Object3D } from "three";

let scene: Scene | null = null;
let camera: PerspectiveCamera | null = null;
let renderer: WebGLRenderer | null = null;
let objectsByEid = new Map<number, Object3D>();

type RenderWorld = {
  scene: Scene
  camera: Camera
  renderer: WebGLRenderer
  objectsByEid: Map<number, Object3D>
}

export function renderSystem(_world: CoreWorld){
    if (!renderer || !scene || !camera) return;
    renderer.render(scene, camera);
}

export function setupRenderer(canvas: HTMLCanvasElement | null){
    if (!canvas) return;

    const width = canvas.clientWidth || canvas.width || 1;
    const height = canvas.clientHeight || canvas.height || 1;

    scene = new Scene();
    camera = new PerspectiveCamera(75, width / height, 0.1, 1000);
    camera.position.z = 5;

    if (renderer) {
        renderer.dispose();
    }

    renderer = new WebGLRenderer({
        canvas,
        antialias: false,
        powerPreference: "high-performance",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height, false);
}

export function addToScene(obj: Object3D) {
  if (!scene) throw new Error("Renderer not set up yet. Call setupRenderer(canvas) first.");
  scene.add(obj);
  return obj;
}

export function removeFromScene(obj: Object3D) {
  if (!scene) return;
  scene.remove(obj);
}
