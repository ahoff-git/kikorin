import { expect, test } from "@playwright/test";
import {
  attachJson,
  buildMetricsRow,
  latestTick,
  type MetricsRow,
  openGame,
  readState,
  recentSamplesAfterTick,
  spawnMonstersByButton,
  waitForMonsterCount,
  waitForSamplesAfterTick,
} from "./gameplayHarness";

type StressResult = {
  targetObservedTps: number;
  batchSize: number;
  maxMonsters: number;
  sampleTarget: number;
  stoppedBecause: "below-target" | "max-monsters";
  rows: MetricsRow[];
};

const TARGET_OBSERVED_TPS = 100;
const MONSTER_BATCH_SIZE = 50;
const MAX_MONSTERS = 1_500;
const SAMPLE_TARGET = 45;

test("records TPS by monster count up to the TPS cliff or the monster cap", async ({ page }, testInfo) => {
  test.setTimeout(300_000);

  await openGame(page);

  await page.keyboard.down("w");
  await page.keyboard.down("d");

  const rows: MetricsRow[] = [];

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
      const row = buildMetricsRow(state, samples);
      rows.push(row);

      console.log(
        `[kikorin:stress] monsters=${row.monsterCount} observedTps=${row.observedTps} capacityTps=${row.capacityTps} avgTickMs=${row.avgTickMs} maxTickMs=${row.maxTickMs}`,
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

  // Either stop reason is a pass: the sweep found the TPS cliff, or the engine
  // held target TPS all the way to the monster cap. Faster hardware or engine
  // perf improvements must never turn this suite red.
  expect(rows.length).toBeGreaterThan(0);
  for (const row of rows.slice(0, -1)) {
    expect(row.observedTps).toBeGreaterThanOrEqual(TARGET_OBSERVED_TPS);
  }
});
