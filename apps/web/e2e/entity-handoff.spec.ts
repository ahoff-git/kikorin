import { expect, test } from "@playwright/test";
import type { Page } from "@playwright/test";

// Two-peer proof of the entity-ownership state handoff (ADR 0022): peer A spawns
// a monster (claims routing authority + tracks it), hands it to peer B via the
// push-before-release flow, and B ends up owning + simulating it while A no
// longer does. Exercises the whole stack live — awari's entity ownership, the
// offer/ack/commit control messages over the real session, and the engine
// snapshot → adopt across two workers.
//
// Requires live P2P (a reachable PeerJS broker + WebRTC between the two
// contexts). Where that isn't available (a sandboxed CI with no network), the
// peers never discover each other; the test skips rather than falsely fails.

type HandoffHook = { transfer: (eid: number, toPeerId: string) => void; ownedEids: () => number[]; peers: () => string[] };
declare global {
  interface Window { __KIKORIN_HANDOFF__?: HandoffHook }
}

async function openReady(page: Page): Promise<void> {
  await page.goto("/3d?e2e=1");
  await page.waitForFunction(() => {
    const s = window.__KIKORIN_E2E__;
    return Boolean(s?.ready && s.playerEid != null && s.metrics.length >= 5);
  }, undefined, { timeout: 30_000 });
}

test("entity ownership + state hands off from one peer to another", async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  const errors: string[] = [];
  a.on("pageerror", (e) => errors.push(`A: ${e}`));
  b.on("pageerror", (e) => errors.push(`B: ${e}`));

  try {
    await openReady(a);
    await openReady(b);

    // Wait for the two peers to discover + connect. If P2P isn't available in
    // this environment, skip — the handoff logic itself is unit-tested.
    const peered = (p: Page) =>
      p.waitForFunction(() => (window.__KIKORIN_HANDOFF__?.peers().length ?? 0) >= 1, undefined, { timeout: 25_000 });
    try {
      await peered(a);
      await peered(b);
    } catch {
      test.skip(true, "live peer-to-peer connection unavailable in this environment");
      return;
    }

    // A spawns monsters and waits until it owns (tracks) at least one.
    await a.getByRole("button", { name: "Spawn 10 Monsters" }).click();
    await a.waitForFunction(() => (window.__KIKORIN_HANDOFF__?.ownedEids().length ?? 0) > 0, undefined, { timeout: 15_000 });

    const { eid, bPeer } = await a.evaluate(() => {
      const h = window.__KIKORIN_HANDOFF__!;
      return { eid: h.ownedEids()[0]!, bPeer: h.peers()[0]! };
    });
    const bOwnedBefore = await b.evaluate(() => window.__KIKORIN_HANDOFF__!.ownedEids().length);

    // A hands that entity to B.
    await a.evaluate(({ eid, bPeer }) => window.__KIKORIN_HANDOFF__!.transfer(eid, bPeer), { eid, bPeer });

    // A released it; B adopted one (its owned count rose by the handed-off entity).
    await a.waitForFunction((eid) => !window.__KIKORIN_HANDOFF__!.ownedEids().includes(eid), eid, { timeout: 15_000 });
    await b.waitForFunction((n) => window.__KIKORIN_HANDOFF__!.ownedEids().length > n, bOwnedBefore, { timeout: 15_000 });

    expect(errors, `page errors: ${errors.join("\n")}`).toEqual([]);
  } finally {
    await ctxA.close();
    await ctxB.close();
  }
});
