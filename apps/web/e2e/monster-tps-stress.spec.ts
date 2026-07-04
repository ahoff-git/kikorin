import { expect, test } from "@playwright/test";
import {
  attachJson,
  computeTps,
  latestTick,
  observedTps,
  openGame,
  readState,
  recentSamplesAfterTick,
  spawnMonstersByButton,
  summarizeSamples,
  waitForMonsterCount,
  waitForSamplesAfterTick,
} from "./gameplayHarness";
import type { E2EMetricSample as MetricSample, E2EState } from "../src/app/e2eMetrics";

type StressRow = {
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

type StressResult = {
  targetObservedTps: number;
  batchSize: number;
  maxMonsters: number;
  sampleTarget: number;
  stoppedBecause: "below-target" | "max-monsters";
  rows: StressRow[];
};

const TARGET_OBSERVED_TPS = 100;
const MONSTER_BATCH_SIZE = 50;
const MAX_MONSTERS = 1_500;
const SAMPLE_TARGET = 45;

test("records TPS by monster count until observed TPS falls under 100", async ({ page }, testInfo) => {
  test.setTimeout(300_000);

  await openGame(page);

  await page.keyboard.down("w");
  await page.keyboard.down("d");

  const rows: StressRow[] = [];

  try {
    while (true) {
      const stateBeforeSpawn = await readState(page);
      const targetMonsterCount = stateBeforeSpawn.monsterEids.length + MONSTER_BATCH_SIZE;
      const startTick = latestTick(stateBeforeSpawn);

      await spawnMonstersByButton(page, MONSTER_BATCH_SIZE);
      await waitForMonsterCount(page, targetMonsterCount);
      await waitForSamplesAfterTick(page, startTick, SAMPLE_TARGET);

      const state = await readState(page);
      const samples = recentSamplesAfterTick(state, startTick, SAMPLE_TARGET);
      const row = buildStressRow(state, samples);
      rows.push(row);

      console.log(
        `[kikorin:stress] monsters=${row.monsterCount} observedTps=${row.observedTps} computeTps=${row.computeTps} avgTickMs=${row.avgTickMs} maxTickMs=${row.maxTickMs}`,
      );

      if (row.observedTps < TARGET_OBSERVED_TPS) break;
      if (row.monsterCount >= MAX_MONSTERS) break;
    }
  } finally {
    await page.keyboard.up("d").catch(() => {});
    await page.keyboard.up("w").catch(() => {});
  }

  const lastRow = rows.at(-1);
  expect(lastRow).toBeDefined();

  const result: StressResult = {
    targetObservedTps: TARGET_OBSERVED_TPS,
    batchSize: MONSTER_BATCH_SIZE,
    maxMonsters: MAX_MONSTERS,
    sampleTarget: SAMPLE_TARGET,
    stoppedBecause: lastRow && lastRow.observedTps < TARGET_OBSERVED_TPS ? "below-target" : "max-monsters",
    rows,
  };

  await attachJson(testInfo, "monster-tps-stress.json", result);
  expect(result.stoppedBecause).toBe("below-target");
});

function buildStressRow(state: E2EState, samples: MetricSample[]): StressRow {
  const summary = summarizeSamples(state, samples);
  const observed = observedTps(samples);
  return {
    monsterCount: state.monsterEids.length,
    observedTps: observed,
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
