# ADR 0004: Chat "nearby"/group channels are broadcast + client-side filtered, not real awari-scoped routing

## Status
Accepted

## Context
kikorin's chat framework (`apps/web/src/app/chat.ts`) wanted multiple channel types — global, named groups, and a "nearby" range-limited channel — riding the same `@awari/core` `RoomSession` the game already joins for netcode, rather than a separate connection.

The natural-looking approach — use `RoomSession`'s `{type: "interest", interestId}` route so only subscribed peers receive a group/nearby message, and `{type: "peer", peer}` for anything point-to-point — doesn't work against the actual `@awari/core` v0 implementation: `joinInterest`/`leaveInterest` both literally `throw new Error("not implemented yet — no hubs in this version of Awari")`, and `handleSteadyStateMessage` in `room-session.js` only relays/delivers `kind: "application"` messages whose `route.type === "room"` — any other route type is silently dropped, not queued, not relayed.

Separately, `RoomSession` has no concept of a peer's world-space position at all — "nearby" is entirely an application-level idea, not something the transport layer could scope even if hubs existed.

## Decision
Every chat message — regardless of channel — publishes as an ordinary `{type: "room"}` broadcast (the only route v0 actually relays), with a `kind: "kikorin-chat"` tag so `net_ingest`'s binary-payload check ignores it and vice versa. For "nearby," the sender's world position rides along as opaque payload data; each reader locally recomputes distance against their own current position (read via `applyToObjectByEid`) and decides whether to surface the message. For "group," each reader keeps a local `Set` of joined group names and filters on that.

This means every peer receives every message on every channel regardless of relevance — "nearby" costs exactly as much bandwidth as "global" today. Filed as a real requirement in the `awari` project's own `specs/TODO.md` (not this repo) under "Deferred design work — revisit only with evidence, not speculatively": attribute/spatial-scoped interests, motivated by this exact consumer need, proposing that whenever hubs/interests do get built, membership could key off more than a fixed string id (an app-supplied predicate or spatial cell) so range filtering happens once at the relay layer instead of on every reader after full delivery.

## Consequences
- Chat works correctly today, verified live with two real peers (global messages, group join/leave scoping messages correctly).
- `NetworkCoordinate` (awari's Vivaldi link-latency estimate) is explicitly *not* reused for "nearby" — it estimates network topology distance, not game-world position, and conflating the two would be wrong regardless of implementation convenience.
- If awari ever ships real interest-scoped relay, `chat.ts`'s `createChatController` is the single place that would change (swap the broadcast+filter for a real `joinInterest` call) — the `ChatChannel`/`ChatMessage` types and the UI in `gameChrome.tsx` wouldn't need to know the difference.
