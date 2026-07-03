import type { HitPatch, MetricsPatch, NetPatch, RenderPatch, SemanticPatch } from './types';
import { Channel } from './channel';

const EMPTY_METRICS: MetricsPatch = {
  tick_ms: 0,
  ai_ms: 0,
  physics_ms: 0,
  pathfinding_ms: 0,
  net_ms: 0,
  patch_ms: 0,
  boundary_ms: 0,
};

/** Three.js / rendering layer subscribes here for per-entity transform updates. */
export const renderChannel = new Channel<RenderPatch[]>([]);

/** React HUD subscribes here for health, flags, and grounded state. */
export const hudChannel = new Channel<SemanticPatch[]>([]);

/** useNetworking subscribes here to send outbound peer deltas. */
export const netChannel = new Channel<NetPatch[]>([]);

/** Debug overlay and logging subscribe here for per-tick timing. */
export const metricsChannel = new Channel<MetricsPatch>(EMPTY_METRICS);

/** Game logic subscribes here for bullet–monster collision events from the engine. */
export const hitsChannel = new Channel<HitPatch[]>([]);
