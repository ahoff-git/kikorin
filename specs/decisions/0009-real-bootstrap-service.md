# ADR 0009: Room discovery uses the real, shared awari bootstrap service, proxied same-origin

## Status
Accepted

## Context
Kikorin never actually used `awari-bootstrap-service.vercel.app`, despite the app existing and being live. `useNetworking.ts` instead had every client try to claim a well-known PeerJS id (`GAME_ROOM_ANCHOR_PEER_ID`, derived from the room id) on startup: whoever got there first became the room's genesis leader; everyone else's claim failed — that failure itself was the discovery signal — and they dialed the anchor id directly. `manualBootstrap.ts` backed this: a purely local, in-memory `BootstrapClient` that never made a network call.

This worked for kikorin's own use case, but had real, documented gaps (`specs/netcode/README.md`'s old Known Gaps): a brand-new client couldn't discover a room whose anchor had already left (the promoted backup leader's real id was never re-registered anywhere a newcomer could find it), and the anchor id was a fixed, guessable string on a genuinely public broker, so an unrelated app or fork picking the same room id could collide in that broker's namespace. Both are exactly the class of problem a real bootstrap service — persistent leader-hint registration, independent of any specific well-known id — exists to solve.

Switching required two real discoveries, not just wiring up a URL:
1. **`RoomSession.join()` already orchestrates genesis-vs-join entirely internally** via `resolve`/`registerHint` — `useNetworking.ts` needed no manual anchor-claim-or-fallback logic once given a real `BootstrapClient`; it only needed to stop doing that logic itself.
2. **The live service sends no `Access-Control-Allow-Origin` header.** A direct browser `fetch()` to `awari-bootstrap-service.vercel.app` from kikorin's own origin is blocked by the browser outright (confirmed: `curl` succeeded since CORS is a browser-only mechanism, but an actual page's `fetch` failed with `TypeError: Failed to fetch`). Fixing this would mean redeploying the bootstrap-service itself — out of scope for a change made entirely from kikorin's own repo, and not something to do unilaterally to shared, live infrastructure.

## Decision
`httpBootstrapClient.ts` implements a real `BootstrapClient` — but it calls this app's *own* `/api/bootstrap` and `/api/bootstrap/hints` routes (`apps/web/src/app/api/bootstrap/`), which are a thin server-side proxy forwarding to the real service. CORS doesn't apply to a server-to-server `fetch`, so this sidesteps the missing-CORS-header problem entirely without touching the awari repo or its deployment.

`useNetworking.ts`'s `start()` no longer claims any well-known id — every client just gets an ordinary, broker-assigned PeerJS id, and `awari.join({roomId, sessionId})` (backed by the real client) handles genesis-vs-join. The anchor-claim-or-fallback dance, `GameRoom.anchorPeerId`, and the associated `isAnchor` bookkeeping were all deleted as dead code once nothing needed them.

`connect()`'s manual "paste a peer id" override — a direct dial, not discovery — keeps `manualBootstrap.ts` and now runs through its own dedicated `awari` instance, separate from the primary one, since `createAwari` bakes in one bootstrap client for its lifetime and the two need different ones (the real service has no "just connect to this exact peer" primitive; `seedContact`'s local-only leader-hint injection is still exactly the right tool for that job).

Verified against the live service (not a mock): two independent browser tabs, running against an isolated test room id, discovered each other with zero manual pasting — confirmed via `curl` against `/api/bootstrap` and `/api/bootstrap/hints` directly (resolve → created, resolve → ready, registerHint → registered, resolve → ready with the hint) and then end-to-end through two real Playwright pages.

## Consequences
- **Both gaps the anchor-id scheme had are closed for free**: a new client can now find an existing room even after its original leader left (the real service holds the current leader-hint, independent of any fixed id), and there's no more fixed, guessable anchor id to collide with an unrelated app on the shared PeerJS broker.
- **New dependency: the shared game room now requires the real bootstrap service (and this app's own proxy route) to be reachable.** If either is down, discovery fails outright — there is no fallback to the old anchor-claim behavior. Acceptable given the service is external, shared infrastructure the same author already operates; revisit if that stops being true.
- The proxy routes (`apps/web/src/app/api/bootstrap/`) are the *only* reason this works from a browser at all — deleting them without also fixing CORS on the bootstrap-service side, or switching back to direct cross-origin calls, would silently break every shared-room join.
- `connect()`'s manual override is now structurally independent from the primary discovery path (separate bootstrap client, separate `awari` instance) — a deliberate, permanent split, not a temporary migration artifact.
