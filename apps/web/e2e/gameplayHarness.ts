import { expect, type Page, type TestInfo } from "@playwright/test";
import type { MetricsPatch, RenderPatch } from "@kikorin/adapter";
import { METRIC_FIELDS } from "@kikorin/adapter";
import type { E2EMetricSample as MetricSample, E2EState } from "../src/app/e2eMetrics";
import { writeFile } from "node:fs/promises";

export type MetricField = keyof MetricsPatch;

export type MetricsSummary = {
  sampleCount: number;
  frameCount: number;
  patchCount: number;
  playerEid: number | null;
  monsterCount: number;
  bulletCount: number;
  totalRenderPatches: number;
  totalSemanticPatches: number;
  totalHits: number;
  lastTick: number;
  avg: Record<MetricField, number>;
  max: Record<MetricField, number>;
};

export type PlayerLocation = {
  label: string;
  x: number;
  y: number;
  z: number;
};

const SAMPLE_TIMEOUT_MS = 6_000;

export async function openGame(page: Page): Promise<void> {
  await page.goto("/?e2e=1");
  await page.waitForFunction(() => {
    const state = window.__KIKORIN_E2E__;
    if (!state?.ready || state.playerEid == null || state.metrics.length < 5) return false;
    return Boolean(state.latestRenderByEntity[String(state.playerEid)]);
  });
}

export async function readState(page: Page): Promise<E2EState> {
  const state = await page.evaluate(() => window.__KIKORIN_E2E__ ?? null);
  expect(state).not.toBeNull();
  return state as E2EState;
}

export async function readPlayerRender(page: Page): Promise<RenderPatch> {
  const state = await readState(page);
  expect(state.playerEid).not.toBeNull();

  const render = state.latestRenderByEntity[String(state.playerEid)];
  expect(render).toBeDefined();
  return render;
}

export async function teleportPlayer(page: Page, location: PlayerLocation): Promise<void> {
  await page.evaluate((target) => {
    const controls = window.__KIKORIN_E2E_CONTROL__;
    if (!controls) throw new Error("E2E controls were not installed");
    controls.teleportPlayer(target.x, target.y, target.z, target.label);
  }, location);
}

export async function waitForPlayerNear(page: Page, location: PlayerLocation): Promise<void> {
  await page.waitForFunction(
    (target) => {
      const state = window.__KIKORIN_E2E__;
      if (!state || state.playerEid == null) return false;

      const render = state.latestRenderByEntity[String(state.playerEid)];
      if (!render) return false;

      return Math.hypot(render.x - target.x, render.y - target.y, render.z - target.z) < 1.25;
    },
    location,
    { timeout: 15_000 },
  );
}

export async function summarizeMetrics(page: Page): Promise<MetricsSummary> {
  const state = await readState(page);
  const samples = state.metrics.filter(hasFiniteMetricValues);
  expect(samples.length).toBeGreaterThan(0);
  return summarizeSamples(state, samples);
}

export function summarizeSamples(state: E2EState, samples: MetricSample[]): MetricsSummary {
  const avg = emptyMetricRecord(0);
  const max = emptyMetricRecord(Number.NEGATIVE_INFINITY);

  for (const sample of samples) {
    for (const field of METRIC_FIELDS) {
      const value = metricValue(sample, field);
      avg[field] += value;
      max[field] = Math.max(max[field], value);
    }
  }

  for (const field of METRIC_FIELDS) {
    avg[field] = roundMetric(avg[field] / samples.length);
    max[field] = roundMetric(max[field]);
  }

  return {
    sampleCount: samples.length,
    frameCount: state.frameCount,
    patchCount: state.patchCount,
    playerEid: state.playerEid,
    monsterCount: state.monsterEids.length,
    bulletCount: state.bulletEids.length,
    totalRenderPatches: samples.reduce((sum, sample) => sum + sample.renderCount, 0),
    totalSemanticPatches: samples.reduce((sum, sample) => sum + sample.semanticCount, 0),
    totalHits: samples.reduce((sum, sample) => sum + sample.hitCount, 0),
    lastTick: samples.at(-1)?.tick ?? 0,
    avg,
    max,
  };
}

export async function spawnMonstersByButton(page: Page, count: number): Promise<void> {
  expect(count % 10).toBe(0);
  const spawnButton = page.getByRole("button", { name: "Spawn 10 Monsters" });
  const clicks = count / 10;
  for (let i = 0; i < clicks; i += 1) {
    await spawnButton.click();
    await page.waitForTimeout(20);
  }
}

export async function waitForMonsterCount(page: Page, targetMonsterCount: number): Promise<void> {
  await page.waitForFunction(
    (target) => (window.__KIKORIN_E2E__?.monsterEids.length ?? 0) >= target,
    targetMonsterCount,
    { timeout: 30_000 },
  );
}

export async function waitForSamplesAfterTick(page: Page, startTick: number, sampleTarget: number): Promise<void> {
  await page.waitForFunction(
    ({ tick, samples }) => {
      const metrics = window.__KIKORIN_E2E__?.metrics ?? [];
      return metrics.filter((sample) => sample.tick > tick).length >= samples;
    },
    { tick: startTick, samples: sampleTarget },
    { timeout: SAMPLE_TIMEOUT_MS },
  );
}

export function latestTick(state: E2EState): number {
  return state.metrics.at(-1)?.tick ?? 0;
}

export function recentSamplesAfterTick(state: E2EState, startTick: number, sampleTarget: number): MetricSample[] {
  const samples = finiteMetricSamples(state.metrics).filter((sample) => sample.tick > startTick);
  return samples.slice(-sampleTarget);
}

export function finiteMetricSamples(samples: readonly MetricSample[]): MetricSample[] {
  return samples.filter(hasFiniteMetricValues);
}

export function observedTps(samples: readonly MetricSample[]): number {
  const first = samples.at(0);
  const last = samples.at(-1);
  if (!first || !last || last.atMs <= first.atMs) return 0;
  return roundMetric(((last.tick - first.tick) * 1000) / (last.atMs - first.atMs));
}

/**
 * Theoretical max throughput if ticks ran back-to-back with no idle time — a
 * CPU-headroom metric derived from tick cost. This is NOT the actual tick rate;
 * use observedTps (tick-counter delta over wall clock) for that.
 */
export function capacityTps(avgTickMs: number): number {
  if (avgTickMs <= 0) return 0;
  return roundMetric(1000 / avgTickMs);
}

/** One row of a perf sweep — shared by the stress and location metric specs. */
export type MetricsRow = {
  monsterCount: number;
  observedTps: number;
  capacityTps: number;
  sampleCount: number;
  avgTickMs: number;
  maxTickMs: number;
  avgAiMs: number;
  maxAiMs: number;
  avgPhysicsMs: number;
  maxPhysicsMs: number;
  avgPathfindingMs: number;
  maxPathfindingMs: number;
  avgBoundaryMs: number;
  maxBoundaryMs: number;
  renderPatches: number;
  semanticPatches: number;
  lastTick: number;
};

export function buildMetricsRow(state: E2EState, samples: MetricSample[]): MetricsRow {
  const summary = summarizeSamples(state, samples);
  return {
    monsterCount: state.monsterEids.length,
    observedTps: observedTps(samples),
    capacityTps: capacityTps(summary.avg.tick_ms),
    sampleCount: samples.length,
    avgTickMs: summary.avg.tick_ms,
    maxTickMs: summary.max.tick_ms,
    avgAiMs: summary.avg.ai_ms,
    maxAiMs: summary.max.ai_ms,
    avgPhysicsMs: summary.avg.physics_ms,
    maxPhysicsMs: summary.max.physics_ms,
    avgPathfindingMs: summary.avg.pathfinding_ms,
    maxPathfindingMs: summary.max.pathfinding_ms,
    avgBoundaryMs: summary.avg.boundary_ms,
    maxBoundaryMs: summary.max.boundary_ms,
    renderPatches: summary.totalRenderPatches,
    semanticPatches: summary.totalSemanticPatches,
    lastTick: summary.lastTick,
  };
}

export function expectHealthyMetrics(summary: MetricsSummary): void {
  expect(summary.sampleCount).toBeGreaterThanOrEqual(10);
  expect(summary.frameCount).toBeGreaterThan(10);
  expect(summary.patchCount).toBeGreaterThan(10);
  expect(summary.lastTick).toBeGreaterThan(0);
  expect(summary.max.tick_ms).toBeGreaterThan(0);
  expect(summary.max.tick_ms).toBeLessThan(100);
  expect(summary.max.boundary_ms).toBeGreaterThanOrEqual(0);
  expect(summary.max.boundary_ms).toBeLessThan(100);
}

export async function attachJson(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
  const body = JSON.stringify(value, null, 2);
  const path = testInfo.outputPath(name);
  await writeFile(path, body);
  console.log(`[kikorin:e2e:${testInfo.title}] ${body}`);
  await testInfo.attach(name, {
    path,
    contentType: "application/json",
  });
}

function hasFiniteMetricValues(sample: MetricSample): boolean {
  return METRIC_FIELDS.every((field) => Number.isFinite(metricValue(sample, field)));
}

function metricValue(sample: MetricSample, field: MetricField): number {
  return sample[field] ?? 0;
}

function emptyMetricRecord(value: number): Record<MetricField, number> {
  return Object.fromEntries(
    METRIC_FIELDS.map((field) => [field, value]),
  ) as Record<MetricField, number>;
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}
