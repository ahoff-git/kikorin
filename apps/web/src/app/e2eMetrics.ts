import type { MetricsPatch, PatchBundle, RenderPatch } from "@kikorin/adapter";

const MAX_METRIC_SAMPLES = 600;

type EntityKind = "player" | "monster" | "bullet";

type TeleportableEngine = {
  teleport_entity(id: number, x: number, y: number, z: number): void;
};

export type E2ETeleportMark = {
  label: string;
  atMs: number;
  x: number;
  y: number;
  z: number;
};

export type E2EControls = {
  teleportPlayer(x: number, y: number, z: number, label?: string): void;
};

export type E2EMetricSample = MetricsPatch & {
  atMs: number;
  tick: number;
  renderCount: number;
  semanticCount: number;
  netCount: number;
  hitCount: number;
};

export type E2EState = {
  enabled: true;
  ready: boolean;
  playerEid: number | null;
  ownedEids: number[];
  monsterEids: number[];
  bulletEids: number[];
  frameCount: number;
  patchCount: number;
  latestRenderByEntity: Record<string, RenderPatch>;
  /** Latest animation cell per entity — lets tests assert frames advance. */
  latestAnimByEntity: Record<string, { anim_id: number; anim_frame: number; anim_dir: number }>;
  /** Latest health per entity — lets tests assert combat damage/respawn (ADR 0021). */
  latestHealthByEntity: Record<string, number>;
  /** Frame-synced animation events received on the boundary (ADR 0017), capped. */
  animEvents: { entity: number; event: number }[];
  metrics: E2EMetricSample[];
  teleports: E2ETeleportMark[];
  marks: Record<string, number>;
};

declare global {
  interface Window {
    __KIKORIN_E2E__?: E2EState;
    __KIKORIN_E2E_CONTROL__?: E2EControls;
  }
}

function shouldCollectE2EMetrics(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).has("e2e");
}

function createState(): E2EState {
  return {
    enabled: true,
    ready: false,
    playerEid: null,
    ownedEids: [],
    monsterEids: [],
    bulletEids: [],
    frameCount: 0,
    patchCount: 0,
    latestRenderByEntity: {},
    latestAnimByEntity: {},
    latestHealthByEntity: {},
    animEvents: [],
    metrics: [],
    teleports: [],
    marks: {},
  };
}

export function getE2EState(): E2EState | null {
  if (!shouldCollectE2EMetrics()) return null;
  window.__KIKORIN_E2E__ ??= createState();
  return window.__KIKORIN_E2E__;
}

export function markE2EGameReady(playerEid: number, ownedEids: readonly number[]): void {
  const state = getE2EState();
  if (!state) return;
  state.ready = true;
  state.playerEid = playerEid;
  state.ownedEids = [...ownedEids];
  state.marks.readyAtMs = performance.now();
}

export function markE2EGameStopped(): void {
  const state = getE2EState();
  if (!state) return;
  state.ready = false;
  state.marks.stoppedAtMs = performance.now();
}

export function installE2EControls(engine: TeleportableEngine, playerEid: number): void {
  const state = getE2EState();
  if (!state) return;

  window.__KIKORIN_E2E_CONTROL__ = {
    teleportPlayer(x, y, z, label = "unnamed") {
      const atMs = performance.now();
      state.teleports.push({ label, atMs, x, y, z });
      state.marks.lastTeleportAtMs = atMs;
      engine.teleport_entity(playerEid, x, y, z);
    },
  };
}

export function uninstallE2EControls(): void {
  if (typeof window !== "undefined") {
    delete window.__KIKORIN_E2E_CONTROL__;
  }
}

export function recordE2EEntitySpawn(kind: EntityKind, eid: number): void {
  const state = getE2EState();
  if (!state) return;
  if (kind === "monster") state.monsterEids.push(eid);
  if (kind === "bullet") state.bulletEids.push(eid);
  if (kind === "player") state.playerEid = eid;
}

export function recordE2EFrame(): void {
  const state = getE2EState();
  if (!state) return;
  state.frameCount += 1;
}

export function recordE2EPatch(bundle: PatchBundle): void {
  const state = getE2EState();
  if (!state) return;

  state.patchCount += 1;
  for (const render of bundle.render) {
    state.latestRenderByEntity[String(render.entity)] = render;
  }
  for (const s of bundle.semantic) {
    if (s.health !== undefined) state.latestHealthByEntity[String(s.entity)] = s.health;
    if (s.anim_id === undefined) continue;
    state.latestAnimByEntity[String(s.entity)] = {
      anim_id: s.anim_id,
      anim_frame: s.anim_frame ?? 0,
      anim_dir: s.anim_dir ?? 0,
    };
  }
  for (const ae of bundle.anim_events) state.animEvents.push(ae);
  if (state.animEvents.length > 200) state.animEvents.splice(0, state.animEvents.length - 200);

  state.metrics.push({
    ...bundle.metrics,
    atMs: performance.now(),
    tick: bundle.tick,
    renderCount: bundle.render.length,
    semanticCount: bundle.semantic.length,
    netCount: bundle.net.length,
    hitCount: bundle.hits.length,
  });

  if (state.metrics.length > MAX_METRIC_SAMPLES) {
    state.metrics.splice(0, state.metrics.length - MAX_METRIC_SAMPLES);
  }
}
