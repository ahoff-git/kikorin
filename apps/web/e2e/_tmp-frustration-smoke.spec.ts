import { expect, test } from "@playwright/test";
import { readState, teleportPlayer } from "./gameplayHarness";

test("chase still works live with frustration escalation active", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });

  await page.goto("/3d?e2e=1");
  await page.waitForFunction(() => {
    const state = window.__KIKORIN_E2E__;
    if (!state?.ready || state.playerEid == null) return false;
    return Boolean(state.latestRenderByEntity[String(state.playerEid)]);
  });
  await page.getByRole("button", { name: "Spawn 10 Monsters" }).click();
  await page.waitForFunction(
    () => (window.__KIKORIN_E2E__?.monsterEids.length ?? 0) >= 10,
    undefined,
    { timeout: 15_000 },
  );

  await teleportPlayer(page, { label: "east-upper-platform", x: 31, y: 4.9, z: -6 });
  await page.waitForTimeout(15000);

  const s = await readState(page);
  let onPlatform = 0;
  for (const eid of s.monsterEids) {
    const r = s.latestRenderByEntity[String(eid)];
    if (r && r.y > 3.5 && r.x > 20) onPlatform += 1;
  }
  const avgTick = s.metrics.slice(-50).reduce((a, m) => a + m.tick_ms, 0) / 50;
  console.log("onPlatform", onPlatform, "avgTick", avgTick);
  expect(onPlatform).toBeGreaterThanOrEqual(3);
  expect(avgTick).toBeLessThan(4);
  expect(errors, `errors: ${JSON.stringify(errors)}`).toHaveLength(0);
});
