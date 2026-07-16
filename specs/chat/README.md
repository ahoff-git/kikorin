## apps/web/src/app/chat.ts — Chat Framework

### Purpose
A lightweight, multi-channel chat layer riding the same `@awari/core` `RoomSession` the game already joins for netcode (see [netcode](../netcode/README.md) and `useNetworking.ts`) — no separate connection, no server, no new wire protocol. Every message is an ordinary room broadcast, tagged `kind: "kikorin-chat"` so it's trivially distinguished from the engine's binary net payloads on both sides.

### Boundaries
- Owns message shape, sanitization, rate-limiting, and channel-visibility rules. Does not own the transport (`RoomSession`, provided by `useNetworking.ts`) or the UI (`gameChrome.tsx`'s `ChatBox`/`RightPanel`).
- Does not implement real server-side or protocol-level channel scoping. `@awari/core`'s v0 `RoomSession` has no working interest/hub routing yet (`joinInterest`/`leaveInterest` both throw "not implemented") — see [ADR 0004](../decisions/0004-chat-channels-are-broadcast-and-client-filtered.md). Every channel, including "nearby," is an ordinary room-wide broadcast; scoping happens entirely client-side, on receipt.

### Channels
Three kinds (`ChatChannel`, a discriminated union):
- **`global`** — visible to everyone in the room, always.
- **`group`** — visible only to readers who have `joinChatGroup`'d that name. Group membership is local UI state (`joinedChatGroups` in `useNetworking.ts`), not announced to peers or validated against anything — joining is just "start displaying messages tagged with this name," leaving is the reverse.
- **`nearby`** — visible only to readers within `nearbyRadius` world units of the sender's position *at send time* (`ChatMessage.pos`, a `[x,y,z]` snapshot). Every reader recomputes this distance independently on every incoming message; there is no server-side range check.

`isVisibleTo(message, joinedGroups, readerPos, nearbyRadius?)` is the single filter applied to every incoming message before it ever reaches UI state — the displayed log is always pre-filtered, not filtered at render time. System notices (peer joined/left) bypass all three checks and are always visible.

### Inputs and Outputs
- **In:** `ChatTransport.onMessage` (the `RoomSession`'s room-broadcast stream); local `send(channel, text)` calls from the UI.
- **Out:** `onDeliver(message)` callback per visible message (local sends included, tagged `from: "me"` immediately — the sender never waits for its own broadcast to round-trip); `ChatTransport.publish({type: "room"}, payload)` for outgoing messages.
- **UI surface:** `gameChrome.tsx`'s `ChatBox` (channel picker + group join/leave + message log + send input) inside `RightPanel`. The channel picker controls only where the *next* send goes — the log always shows every message currently visible across all channels at once (global + in-range nearby + joined groups), not just the active one.

### Key Logic
- **`nearbyRadius` is a per-game construction-time parameter, not a fixed constant.** `createChatController`'s `nearbyRadius` argument (default `DEFAULT_NEARBY_RADIUS = 15`) is threaded from `useNetworking`'s own optional `nearbyRadius` parameter, which each `Game*.tsx` passes to match its own world scale — kikorin's three games span very different distances (3D's sprawling arena, 2D's side view, the top-down maze), so one fixed radius doesn't read as "the same closeness" in all of them. 3D omits the argument (its scale is what the default was tuned for); 2D passes `8`; top-down passes `10`. A mismatch between sender and reader (e.g. two peers somehow running different radii) just means one side's notion of "nearby" is stale — not a crash, not a protocol violation, since the check is purely local.
- **Rate limiting and sanitization happen before anything touches the wire.** `sanitizeChatText` trims/collapses whitespace and caps length (280 chars); `MIN_SEND_INTERVAL_MS` (300ms) silently drops a send that arrives too soon after the last one — no queueing, no error surfaced to the caller.
- **The local echo is immediate and independent of the broadcast.** `send()` calls `onDeliver` with `from: "me"` synchronously, then separately `publish`es to the room — the UI never waits on the transport to show your own message, and (since the sender is filtered out of its own incoming stream by peer id) never double-delivers it either.
- **Position snapshotting is send-time, not live.** A `nearby` message carries the sender's position *as of the moment it was sent* (`getSelfPosition()`), not a live-tracked position — a reader that was in range when the message was sent but has since moved away still sees it (and vice versa: readers judge against the sender's send-time position, not their own live one relative to a moving sender).

### Invariants
- `isVisibleTo` is the only gate between the wire and UI state — no other code path adds a message to the visible log.
- A channel change only affects where `send()` delivers next; it never re-filters already-received messages.
- Group membership and the "nearby" radius are both purely local — nothing about them is announced to or validated by peers.

### Dependencies
`@awari/core`'s `RoomSession` (via the narrow `ChatTransport` interface — `publish`/`onMessage` only, kept minimal so it's trivial to fake in isolation); `useNetworking.ts` (owns the actual `RoomSession` lifecycle and wires `createChatController` to it); `gameChrome.tsx` (UI).

### Verification
No automated test suite yet — `apps/web` has no unit-test runner wired up (only Playwright e2e, which needs a real browser/dev server and isn't suited to `chat.ts`'s pure functions). `isVisibleTo`, `sanitizeChatText`, and `channelLabel` are all pure and straightforward to unit-test if/when that's set up; in the meantime, correctness has been checked by reading and by manual real-browser multiplayer sessions during development.

### Related
- [ADR 0004](../decisions/0004-chat-channels-are-broadcast-and-client-filtered.md) — why "nearby"/group scoping is client-side filtering, not real protocol routing.
- A real spatial/attribute-scoped interest-group primitive now exists in `@awari/protocol` (surfaced by this exact "nearby" use case) but isn't adopted here yet — see the sibling `awari` project's `specs/TODO.md` for that gap and the requirement kikorin filed for it.
