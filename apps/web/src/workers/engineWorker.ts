// WASM engine worker — runs the physics simulation on a dedicated thread.
// The simulation loop runs as fast as setTimeout(fn, 0) allows (~250 Hz in workers).
// Patches are accumulated between flushes and sent to the main thread at FLUSH_INTERVAL_MS.
// Messages in:  see Req union below.
// Messages out: { type: 'patches', bundle } at flush cadence, { type: 'ack', id, result } for requests.
//
// WASM loading: we bypass Turbopack's WASM module system (which uses root-relative URLs
// that fail to resolve in worker contexts where self.location.origin is "null").
// Instead we import engine_bg.js directly (no static WASM import) and instantiate the
// binary from /public/engine_bg.wasm using an explicit absolute URL.
// The wasm-bindgen bundler-target binary imports its JS bindings under the namespace
// "./engine_bg.js", which matches the star-import we provide as the instantiation imports.

import type { EngineHandle, PatchBundle, RenderPatch, SemanticPatch, NetPatch, MetricsPatch } from '@kikorin/adapter';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no sub-path type declarations; Engine and __wbg_set_wasm are exported at runtime
import * as engineBg from '@kikorin/engine-wasm/engine_bg.js';

async function loadWasm(origin: string): Promise<new () => EngineHandle> {
  // Use the origin passed from the main thread to build an absolute WASM URL.
  // Turbopack may serve workers from a blob URL (self.location.origin = "null"),
  // so we cannot rely on self.location.origin for root-relative URL resolution.
  const wasmUrl = new URL('/engine_bg.wasm', origin).href;

  const { instance } = await WebAssembly.instantiateStreaming(
    fetch(wasmUrl),
    { './engine_bg.js': engineBg },
  );

  // Wire the compiled WASM exports back into the JS bindings module.
  (engineBg as { __wbg_set_wasm: (v: unknown) => void }).__wbg_set_wasm(instance.exports);
  (instance.exports as { __wbindgen_start?: () => void }).__wbindgen_start?.();

  return (engineBg as { Engine: new () => EngineHandle }).Engine;
}

// How often to post accumulated patches to the main thread (~60 Hz).
// The simulation itself runs faster; this only controls the renderer's update cadence.
const FLUSH_INTERVAL_MS = 16;

type Req =
  | { type: 'init';          id: number; signalingUrl?: string; sessionId?: string; origin: string }
  | { type: 'set_velocity';  eid: number; vx: number; vy: number; vz: number }
  | { type: 'destroy';       eid: number }
  | { type: 'spawn_box';     id: number; x: number; y: number; z: number; hw: number; hh: number; hd: number; health: number; net_flags: number }
  | { type: 'spawn_bullet';  id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number }
  | { type: 'spawn_floor';   id: number; x: number; y: number; z: number; hw: number; hh: number; hd: number }
  | { type: 'build_navmesh'; id: number }
  | { type: 'find_path';     id: number; sx: number; sy: number; sz: number; gx: number; gz: number; canJump: boolean };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const post = (data: unknown): void => (self as any).postMessage(data);

let engine: EngineHandle | null = null;

// Patch accumulation — keyed by entity so multiple sim steps between flushes collapse to
// the latest state. Semantic fields are merged (not replaced) so a health update and a
// grounded update within the same flush window are both preserved.
// Net patches are events, not state: queued, never merged.
const pendingRender = new Map<number, RenderPatch>();
const pendingSemantic = new Map<number, SemanticPatch>();
const pendingNet: NetPatch[] = [];
let latestMetrics: MetricsPatch = { tick_ms: 0, ecs_ms: 0, physics_ms: 0, net_ms: 0, patch_ms: 0 };
let latestTick = 0;
let dirty = false;

function accumulateBundle(bundle: PatchBundle | null): void {
  if (!bundle) return;
  for (const rp of bundle.render) pendingRender.set(rp.entity, rp);
  for (const sp of bundle.semantic) {
    const prev = pendingSemantic.get(sp.entity);
    pendingSemantic.set(sp.entity, prev ? { ...prev, ...sp } : sp);
  }
  for (const np of bundle.net) pendingNet.push(np);
  latestMetrics = bundle.metrics;
  latestTick = bundle.tick;
  dirty = true;
}

function flush(): void {
  if (!engine || !dirty) return;
  dirty = false;
  const bundle: PatchBundle = {
    tick: latestTick,
    render: [...pendingRender.values()],
    semantic: [...pendingSemantic.values()],
    net: pendingNet.splice(0),
    metrics: latestMetrics,
  };
  pendingRender.clear();
  pendingSemantic.clear();
  post({ type: 'patches', bundle });
}

// Self-driven simulation loop — decoupled from the main thread RAF rate.
// setTimeout(fn, 0) yields between steps so message handlers (set_velocity, spawn, etc.)
// can interleave without starving.
let simRunning = false;
let lastSimTime = 0;

function simStep(): void {
  if (!simRunning || !engine) return;
  const now = performance.now();
  const dt = Math.min(now - lastSimTime, 100);
  lastSimTime = now;
  accumulateBundle(engine.tick(dt));
  setTimeout(simStep, 0);
}

function startSimulation(): void {
  simRunning = true;
  lastSimTime = performance.now();
  setTimeout(simStep, 0);
  setInterval(flush, FLUSH_INTERVAL_MS);
}

addEventListener('message', async (event: MessageEvent<Req>) => {
  const msg = event.data;

  if (msg.type === 'init') {
    const Engine = await loadWasm(msg.origin);
    engine = new Engine();
    if (msg.signalingUrl && msg.sessionId) {
      engine.init_networking?.(msg.sessionId, msg.signalingUrl);
    }
    post({ type: 'ack', id: msg.id, result: null });
    startSimulation();
    return;
  }

  if (!engine) return;

  switch (msg.type) {
    case 'set_velocity':
      engine.set_entity_velocity(msg.eid, msg.vx, msg.vy, msg.vz);
      break;
    case 'destroy':
      engine.destroy_entity(msg.eid);
      break;
    case 'spawn_box': {
      const eid = engine.spawn_box_entity(msg.x, msg.y, msg.z, msg.hw, msg.hh, msg.hd, msg.health, msg.net_flags);
      post({ type: 'ack', id: msg.id, result: eid });
      break;
    }
    case 'spawn_bullet': {
      const eid = engine.spawn_bullet(msg.x, msg.y, msg.z, msg.vx, msg.vy, msg.vz);
      post({ type: 'ack', id: msg.id, result: eid });
      break;
    }
    case 'spawn_floor': {
      const eid = engine.spawn_floor_entity(msg.x, msg.y, msg.z, msg.hw, msg.hh, msg.hd);
      post({ type: 'ack', id: msg.id, result: eid });
      break;
    }
    case 'build_navmesh':
      engine.build_navmesh();
      post({ type: 'ack', id: msg.id, result: null });
      break;
    case 'find_path': {
      const path = engine.find_path(msg.sx, msg.sy, msg.sz, msg.gx, msg.gz, msg.canJump);
      post({ type: 'ack', id: msg.id, result: path });
      break;
    }
  }
});
