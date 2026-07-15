// WASM engine worker — runs the physics simulation on a dedicated thread.
// The simulation loop is pumped by setTimeout(fn, 0), while physics advances in
// fixed 4 ms steps so browser stalls cannot feed Rapier a tunneling-prone dt spike.
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

import type { EngineHandle, PatchBundle, HitPatch, LifecyclePatch, RenderPatch, SemanticPatch, NetPatch, MetricsPatch, TerrainBlockInput, AiConfigInput, NavConfigInput, PlayerConfigInput, PlayerInputState, MonsterConfigInput } from '@kikorin/adapter';
import { EMPTY_METRICS } from '@kikorin/adapter';

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — no sub-path type declarations; Engine and __wbg_set_wasm are exported at runtime
import * as engineBg from '@kikorin/engine-wasm/engine_bg.js';

async function loadWasm(origin: string): Promise<new (dimension?: string) => EngineHandle> {
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

  // wasm-bindgen's generated Engine class types every method loosely (any/JsValue);
  // EngineHandle is the hand-maintained strict contract, so re-type at the boundary.
  return (engineBg as unknown as { Engine: new (dimension?: string) => EngineHandle }).Engine;
}

// How often to post accumulated patches to the main thread (~60 Hz).
// The simulation itself advances at SIM_STEP_MS; this only controls the renderer's update cadence.
const FLUSH_INTERVAL_MS = 16;
const SIM_STEP_MS = 4;
const MAX_CATCHUP_STEPS = 8;

type Req =
  | { type: 'init';                id: number; origin: string; dimension?: '2d' | '3d' }
  | { type: 'set_velocity';        eid: number; vx: number; vy: number; vz: number }
  | { type: 'teleport';            eid: number; x: number; y: number; z: number }
  | { type: 'destroy';             eid: number }
  | { type: 'spawn_box';           id: number; x: number; y: number; z: number; hw: number; hh: number; hd: number; health: number; net_flags: number }
  | { type: 'spawn_bullet';        id: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; net_flags: number }
  | { type: 'spawn_floor';         id: number; x: number; y: number; z: number; hw: number; hh: number; hd: number }
  | { type: 'load_map';            id: number; blocks: TerrainBlockInput[] }
  | { type: 'find_path';           id: number; sx: number; sy: number; sz: number; gx: number; gz: number; canJump: boolean }
  | { type: 'update_monster_goal'; gx: number; gz: number }
  | { type: 'set_monster_goal';    eid: number; gx: number; gz: number }
  | { type: 'clear_monster_goal';  eid: number }
  | { type: 'set_ai_config';       cfg: AiConfigInput }
  | { type: 'set_nav_config';      cfg: NavConfigInput }
  | { type: 'set_player_config';   cfg: PlayerConfigInput }
  | { type: 'set_monster_config';  cfg: MonsterConfigInput }
  | { type: 'register_player';     eid: number }
  | { type: 'set_player_input';    input: PlayerInputState }
  | { type: 'player_fire' }
  | { type: 'spawn_monsters';      count: number }
  | { type: 'net_peer_connected';    peerId: string }
  | { type: 'net_peer_disconnected'; peerId: string }
  | { type: 'net_ingest';            peerId: string; data: Uint8Array };

// Worker-scope postMessage takes one argument; the DOM lib types `self` as a
// Window, so narrow it structurally instead of pulling in the webworker lib.
const workerScope = self as unknown as { postMessage(data: unknown): void };
const post = (data: unknown): void => workerScope.postMessage(data);

let engine: EngineHandle | null = null;

// Patch accumulation — keyed by entity so multiple sim steps between flushes collapse to
// the latest state. Semantic fields are merged (not replaced) so a health update and a
// grounded update within the same flush window are both preserved.
// Net patches are events, not state: queued, never merged.
const pendingRender = new Map<number, RenderPatch>();
const pendingSemantic = new Map<number, SemanticPatch>();
const pendingNet: NetPatch[] = [];
const pendingHits: HitPatch[] = [];
const pendingLifecycle: LifecyclePatch[] = [];
let latestMetrics: MetricsPatch = { ...EMPTY_METRICS };
let latestTick = 0;
let dirty = false;

function accumulateBundle(bundle: PatchBundle | null, tickCallMs: number): void {
  if (!bundle) return;
  for (const rp of bundle.render) pendingRender.set(rp.entity, rp);
  for (const sp of bundle.semantic) {
    const prev = pendingSemantic.get(sp.entity);
    pendingSemantic.set(sp.entity, prev ? { ...prev, ...sp } : sp);
  }
  for (const np of bundle.net) pendingNet.push(np);
  // Hits/lifecycle are events: never merged, always queued in arrival order.
  // serde-wasm-bindgen serializes Rust Option::None as an absent property, so
  // normalize expiry events.
  for (const hp of bundle.hits) pendingHits.push({ ...hp, target_eid: hp.target_eid ?? null });
  for (const lp of bundle.lifecycle) pendingLifecycle.push(lp);
  // boundary_ms: what the tick() call cost as observed from JS beyond the Rust-internal
  // tick_ms — i.e. the JsValue serialization + bindgen overhead of the WASM boundary.
  // Clamped at 0 to absorb timer-resolution jitter between the two clocks.
  latestMetrics = {
    ...bundle.metrics,
    boundary_ms: Math.max(0, tickCallMs - bundle.metrics.tick_ms),
  };
  latestTick = bundle.tick;
  dirty = true;
}

function flush(): void {
  if (!engine) return;
  // Outbound peer payloads ride the flush cadence to the main thread, where
  // the PeerJS transport lives (workers have no RTCPeerConnection).
  const netOut = engine.net_take_outbound();
  if (netOut.length > 0) post({ type: 'net_out', items: netOut });
  if (!dirty) return;
  dirty = false;
  const bundle: PatchBundle = {
    tick: latestTick,
    render: [...pendingRender.values()],
    semantic: [...pendingSemantic.values()],
    net: pendingNet.splice(0),
    hits: pendingHits.splice(0),
    lifecycle: pendingLifecycle.splice(0),
    metrics: latestMetrics,
  };
  pendingRender.clear();
  pendingSemantic.clear();
  post({ type: 'patches', bundle });
}

// Self-driven simulation loop — decoupled from the main thread RAF rate.
// setTimeout(fn, 0) yields between pumps so message handlers (set_velocity, spawn, etc.)
// can interleave without starving. The catch-up cap prefers dropping time over
// feeding physics a large variable step.
let simRunning = false;
let lastSimTime = 0;
let simAccumulatorMs = 0;

function simStep(): void {
  if (!simRunning || !engine) return;
  const now = performance.now();
  const elapsed = Math.min(now - lastSimTime, SIM_STEP_MS * MAX_CATCHUP_STEPS);
  lastSimTime = now;

  simAccumulatorMs += elapsed;

  let steps = 0;
  while (simAccumulatorMs >= SIM_STEP_MS && steps < MAX_CATCHUP_STEPS) {
    const callStart = performance.now();
    const bundle = engine.tick(SIM_STEP_MS);
    accumulateBundle(bundle, performance.now() - callStart);
    simAccumulatorMs -= SIM_STEP_MS;
    steps += 1;
  }

  if (steps === MAX_CATCHUP_STEPS) {
    simAccumulatorMs = 0;
  }

  setTimeout(simStep, 0);
}

function startSimulation(): void {
  simRunning = true;
  lastSimTime = performance.now();
  simAccumulatorMs = 0;
  setTimeout(simStep, 0);
  setInterval(flush, FLUSH_INTERVAL_MS);
}

addEventListener('message', async (event: MessageEvent<Req>) => {
  const msg = event.data;

  if (msg.type === 'init') {
    const Engine = await loadWasm(msg.origin);
    engine = new Engine(msg.dimension);
    post({ type: 'ack', id: msg.id, result: null });
    startSimulation();
    return;
  }

  if (!engine) return;

  switch (msg.type) {
    case 'set_velocity':
      engine.set_entity_velocity(msg.eid, msg.vx, msg.vy, msg.vz);
      break;
    case 'teleport':
      engine.teleport_entity(msg.eid, msg.x, msg.y, msg.z);
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
      const eid = engine.spawn_bullet(msg.x, msg.y, msg.z, msg.vx, msg.vy, msg.vz, msg.net_flags);
      post({ type: 'ack', id: msg.id, result: eid });
      break;
    }
    case 'spawn_floor': {
      const eid = engine.spawn_floor_entity(msg.x, msg.y, msg.z, msg.hw, msg.hh, msg.hd);
      post({ type: 'ack', id: msg.id, result: eid });
      break;
    }
    case 'load_map': {
      const layout = engine.load_map(msg.blocks);
      post({ type: 'ack', id: msg.id, result: layout });
      break;
    }
    case 'find_path': {
      const path = engine.find_path(msg.sx, msg.sy, msg.sz, msg.gx, msg.gz, msg.canJump);
      post({ type: 'ack', id: msg.id, result: path });
      break;
    }
    case 'update_monster_goal':
      engine.update_monster_goal(msg.gx, msg.gz);
      break;
    case 'set_monster_goal':
      engine.set_monster_goal(msg.eid, msg.gx, msg.gz);
      break;
    case 'clear_monster_goal':
      engine.clear_monster_goal(msg.eid);
      break;
    case 'set_ai_config':
      engine.set_ai_config(msg.cfg);
      break;
    case 'set_nav_config':
      engine.set_nav_config(msg.cfg);
      break;
    case 'set_player_config':
      engine.set_player_config(msg.cfg);
      break;
    case 'set_monster_config':
      engine.set_monster_config(msg.cfg);
      break;
    case 'register_player':
      engine.register_player(msg.eid);
      break;
    case 'set_player_input':
      engine.set_player_input(msg.input);
      break;
    case 'player_fire':
      engine.player_fire();
      break;
    case 'spawn_monsters':
      engine.spawn_monsters(msg.count);
      break;
    case 'net_peer_connected':
      engine.net_peer_connected(msg.peerId);
      break;
    case 'net_peer_disconnected':
      engine.net_peer_disconnected(msg.peerId);
      break;
    case 'net_ingest':
      engine.net_ingest(msg.peerId, msg.data);
      break;
  }
});
