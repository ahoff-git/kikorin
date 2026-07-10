import { expect, test } from "@playwright/test";
import {
  attachJson,
  expectHealthyMetrics,
  openGame,
  readPlayerRender,
  summarizeMetrics,
} from "./gameplayHarness";

test("plays movement, jump, and fire while collecting engine metrics", async ({ page }, testInfo) => {
  await openGame(page);

  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible();

  const start = await readPlayerRender(page);
  await canvas.click({ position: { x: 420, y: 280 } });
  await page.keyboard.down("w");
  await page.waitForTimeout(900);
  await page.keyboard.up("w");

  // Jump must actually leave the ground — 300 ms after takeoff the player is
  // near mid-flight (~2.7 units up at JUMP_VEL=12, g=-20), far above jitter.
  const beforeJump = await readPlayerRender(page);
  await page.keyboard.press("Space");
  await page.waitForTimeout(300);
  const airborne = await readPlayerRender(page);
  expect(airborne.y).toBeGreaterThan(beforeJump.y + 0.5);

  await canvas.click({ position: { x: 500, y: 320 } });
  await page.waitForTimeout(800);

  const end = await readPlayerRender(page);
  const movementXZ = Math.hypot(end.x - start.x, end.z - start.z);
  expect(movementXZ).toBeGreaterThan(0.3);

  const summary = await summarizeMetrics(page);
  expectHealthyMetrics(summary);
  expect(summary.bulletCount).toBeGreaterThanOrEqual(1);

  await attachJson(testInfo, "movement-metrics.json", summary);
});

test("spawns monsters, plays under AI load, and records workload metrics", async ({ page }, testInfo) => {
  await openGame(page);

  await page.getByRole("button", { name: "Spawn 10 Monsters" }).click();
  await page.waitForFunction(() => (window.__KIKORIN_E2E__?.monsterEids.length ?? 0) >= 10);

  const canvas = page.locator("canvas");
  await canvas.click({ position: { x: 520, y: 320 } });

  await page.keyboard.down("w");
  await page.keyboard.down("a");
  for (let i = 0; i < 3; i += 1) {
    await page.waitForTimeout(250);
    await canvas.click({ position: { x: 520 + i * 12, y: 320 } });
  }
  await page.keyboard.up("a");
  await page.keyboard.up("w");

  await page.waitForFunction(() => {
    const metrics = window.__KIKORIN_E2E__?.metrics ?? [];
    return metrics.length >= 30 && metrics.some((sample) => sample.ai_ms > 0);
  });

  const summary = await summarizeMetrics(page);
  expectHealthyMetrics(summary);
  expect(summary.monsterCount).toBeGreaterThanOrEqual(10);
  expect(summary.bulletCount).toBeGreaterThanOrEqual(3);
  expect(summary.totalRenderPatches).toBeGreaterThan(10);
  expect(summary.max.ai_ms).toBeGreaterThan(0);

  await attachJson(testInfo, "monster-load-metrics.json", summary);
});
