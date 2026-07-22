import { expect, test } from "@playwright/test";
import { readState, spawnMonstersByButton, waitForMonsterCount } from "./gameplayHarness";

// End-to-end proof of the combat wiring (ADR 0021): set_ai_config combat fields
// reach Rust, monsters melee the stationary player, its health drops via the
// SemanticPatch, and a death respawns it at full health. The mechanics
// themselves are covered by cargo tests; this is the boundary/HUD wiring.
test("monsters aggro, melee the player, and a death respawns at full health", async ({ page }) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (e) => pageErrors.push(String(e)));

  // The 3D game (the only sample wired for combat) lives at /3d.
  await page.goto("/3d?e2e=1");
  await page.waitForFunction(() => {
    const state = window.__KIKORIN_E2E__;
    if (!state?.ready || state.playerEid == null || state.metrics.length < 5) return false;
    return Boolean(state.latestRenderByEntity[String(state.playerEid)]);
  }, undefined, { timeout: 30_000 });
  // A handful of monsters spawn on the ring (radius ~10) around the origin
  // player — well inside the 3D game's aggro_radius (14), so they converge and
  // melee. The e2e player takes no input, so it stands still and gets hit.
  await spawnMonstersByButton(page, 10);
  await waitForMonsterCount(page, 10);

  const initial = await readState(page);
  const playerEid = String(initial.playerEid);
  expect(initial.latestHealthByEntity[playerEid]).toBe(100);

  // Watch health + monster strike events for a few seconds.
  let minHealth = 100;
  let prevHp = 100;
  let sawMonsterStrike = false;
  let sawRespawn = false;
  let droppedBelow100 = false;
  for (let i = 0; i < 48; i++) {
    const s = await readState(page);
    const hp = s.latestHealthByEntity[playerEid] ?? 100;
    if (hp < 100) droppedBelow100 = true;
    if (hp < minHealth) minHealth = hp;
    // Health only ever goes up on respawn (nothing else heals) — a rise after a
    // drop is an unambiguous death→respawn, robust to the exact sampled value
    // (the player respawns back into the cluster and is re-hit within a poll).
    if (droppedBelow100 && hp > prevHp) sawRespawn = true;
    prevHp = hp;
    // A monster's strike frame emits an anim event from a monster entity.
    if (s.animEvents.some((ae) => s.monsterEids.includes(ae.entity) && ae.event === 1)) {
      sawMonsterStrike = true;
    }
    if (sawMonsterStrike && sawRespawn) break;
    await page.waitForTimeout(200);
  }

  expect(pageErrors, `page errors: ${pageErrors.join("\n")}`).toHaveLength(0);
  expect(droppedBelow100, "player took melee damage (health dropped below 100)").toBe(true);
  expect(sawMonsterStrike, "a monster's strike frame fired an anim event").toBe(true);
  expect(minHealth, "player health reached lethal (<= 0) before respawn").toBeLessThanOrEqual(0);
  expect(sawRespawn, "player respawned (health rose) after dying").toBe(true);
});
