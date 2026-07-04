import { expect, test } from "@playwright/test";
import {
  attachJson,
  computeTps,
  latestTick,
  observedTps,
  openGame,
  type PlayerLocation,
  readState,
  recentSamplesAfterTick,
  spawnMonstersByButton,
  summarizeSamples,
  teleportPlayer,
  waitForMonsterCount,
  waitForPlayerNear,
  waitForSamplesAfterTick,
} from "./gameplayHarness";
import type { E2EMetricSample as MetricSample, E2EState } from "../src/app/e2eMetrics";

type LocationMetricsRow = {
  label: string;
  monsterCount: number;
  observedTps: number;
  computeTps: number;
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

type LocationMetricsResult = {
  targetObservedTps: number;
  monsterCount: number;
  sampleTarget: number;
  rows: LocationMetricsRow[];
};

const TARGET_OBSERVED_TPS = 100;
const MONSTER_COUNT = 150;
const SAMPLE_TARGET = 60;

const PLAYER_LOCATIONS: readonly PlayerLocation[] = [
  { label: "main-floor", x: 0, y: 1.1, z: 0 },
  { label: "east-upper-platform", x: 31, y: 4.9, z: -6 },
  { label: "east-parapet-top-non-walkable", x: 40, y: 6.5, z: -6 },
];

test("keeps metrics healthy while monsters chase platform and non-pathable player locations", async ({ page }, testInfo) => {
  await openGame(page);

  await spawnMonstersByButton(page, MONSTER_COUNT);
  await waitForMonsterCount(page, MONSTER_COUNT);

  const rows: LocationMetricsRow[] = [];

  for (const location of PLAYER_LOCATIONS) {
    const stateBeforeMove = await readState(page);
    const startTick = latestTick(stateBeforeMove);

    await teleportPlayer(page, location);
    await waitForPlayerNear(page, location);
    await waitForSamplesAfterTick(page, startTick, SAMPLE_TARGET);

    const state = await readState(page);
    const samples = recentSamplesAfterTick(state, startTick, SAMPLE_TARGET);
    const row = buildLocationMetricsRow(location.label, state, samples);
    rows.push(row);

    expect(row.sampleCount).toBeGreaterThanOrEqual(SAMPLE_TARGET);
    expect(row.monsterCount).toBeGreaterThanOrEqual(MONSTER_COUNT);
    expect(row.observedTps).toBeGreaterThanOrEqual(TARGET_OBSERVED_TPS);
    expect(row.maxTickMs).toBeLessThan(100);
    expect(row.maxBoundaryMs).toBeLessThan(100);
    expect(row.avgPathfindingMs).toBeLessThan(4);
  }

  const result: LocationMetricsResult = {
    targetObservedTps: TARGET_OBSERVED_TPS,
    monsterCount: MONSTER_COUNT,
    sampleTarget: SAMPLE_TARGET,
    rows,
  };

  await attachJson(testInfo, "player-location-metrics.json", result);
});

function buildLocationMetricsRow(label: string, state: E2EState, samples: MetricSample[]): LocationMetricsRow {
  const summary = summarizeSamples(state, samples);
  return {
    label,
    monsterCount: state.monsterEids.length,
    observedTps: observedTps(samples),
    computeTps: computeTps(summary.avg.tick_ms),
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
