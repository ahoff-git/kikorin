// Lightweight chat framework riding the same awari RoomSession the game
// already joins for netcode (see useNetworking.ts / gameRoom.ts) — no
// separate connection, no server. Every message is an ordinary room
// broadcast, tagged `kind: "kikorin-chat"` so it's easily ignored by
// net_ingest's binary-payload check and vice versa. @awari/core's v0
// RoomSession has no working interest/hub routing yet (joinInterest/
// leaveInterest both throw "not implemented" — see @awari/core's
// room-session.js), so "group" and "nearby" channels are ordinary room
// broadcasts that each reader chooses whether to surface, not actually
// scoped in transit.

export type ChatChannel =
  | { kind: "global" }
  | { kind: "group"; name: string }
  | { kind: "nearby" };

export type ChatMessage = {
  id: string;
  channel: ChatChannel;
  /** "me" for locally sent, "system" for a local join/leave notice, else the sender's peerId. */
  from: string;
  displayName: string;
  text: string;
  sentAt: number;
  /** Sender position at send time — only set for "nearby", used for range filtering. */
  pos?: [number, number, number];
};

const MAX_TEXT_LENGTH = 280;
export const MAX_CHAT_HISTORY = 200;
/**
 * Fallback "nearby" radius, used only where a game doesn't pass its own —
 * see `createChatController`'s `nearbyRadius` param. Tuned for the 3D game's
 * world scale; a smaller game world (2D's side view, the top-down maze)
 * should pass a smaller radius of its own rather than rely on this.
 */
export const DEFAULT_NEARBY_RADIUS = 15;
const MIN_SEND_INTERVAL_MS = 300;

/** A short, stable, human-scannable stand-in for a full PeerJS id. */
export function shortPeerName(peerId: string): string {
  return peerId.slice(0, 8);
}

export function channelLabel(channel: ChatChannel): string {
  switch (channel.kind) {
    case "global":
      return "Global";
    case "nearby":
      return "Nearby";
    case "group":
      return `#${channel.name}`;
  }
}

/** Trims, collapses whitespace, and caps length; null if nothing sendable remains. */
export function sanitizeChatText(raw: string): string | null {
  const cleaned = raw.trim().replace(/\s+/g, " ").slice(0, MAX_TEXT_LENGTH);
  return cleaned.length > 0 ? cleaned : null;
}

function distanceSq(a: [number, number, number], b: [number, number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  return dx * dx + dy * dy + dz * dz;
}

/**
 * Whether a reader with `joinedGroups`/`readerPos` should see `message`.
 * System notices (join/leave) are always visible, regardless of channel.
 * `nearbyRadius` should match whatever the sender's game passed to
 * `createChatController` — a mismatch just means one side's notion of
 * "nearby" is stale, not a crash.
 */
export function isVisibleTo(
  message: ChatMessage,
  joinedGroups: ReadonlySet<string>,
  readerPos: [number, number, number] | null,
  nearbyRadius: number = DEFAULT_NEARBY_RADIUS,
): boolean {
  if (message.from === "system") return true;
  switch (message.channel.kind) {
    case "global":
      return true;
    case "group":
      return joinedGroups.has(message.channel.name);
    case "nearby":
      return readerPos !== null && message.pos !== undefined
        && distanceSq(readerPos, message.pos) <= nearbyRadius * nearbyRadius;
  }
}

export function systemNotice(text: string): ChatMessage {
  return {
    id: crypto.randomUUID(),
    channel: { kind: "global" },
    from: "system",
    displayName: "System",
    text,
    sentAt: Date.now(),
  };
}

// --- Wire transport ---------------------------------------------------

type ChatPayload = { kind: "kikorin-chat"; message: ChatMessage };

function isChatPayload(payload: unknown): payload is ChatPayload {
  return typeof payload === "object" && payload !== null && (payload as { kind?: unknown }).kind === "kikorin-chat";
}

/** The slice of RoomSession chat actually needs — kept narrow so it's trivial to fake in isolation. */
export type ChatTransport = {
  publish(route: { type: "room" }, payload: unknown): Promise<void>;
  onMessage(handler: (message: { payload: unknown }) => void): () => void;
};

export type ChatController = {
  send(channel: ChatChannel, text: string): void;
  dispose(): void;
};

/**
 * Wires one `transport` (a RoomSession) to a chat feed. Incoming messages are
 * filtered by `isVisibleTo` before reaching `onDeliver`; outgoing messages are
 * sanitized, rate-limited, delivered locally (as `from: "me"`) immediately —
 * the sender never receives its own broadcast back — then published.
 *
 * `nearbyRadius` (default `DEFAULT_NEARBY_RADIUS`) should match the calling
 * game's own world scale — kikorin's three games span very different
 * distances (3D's sprawling arena vs. 2D's side view vs. the top-down maze),
 * so one fixed radius can't read as "the same closeness" in all of them.
 */
export function createChatController(
  transport: ChatTransport,
  selfPeerId: string,
  onDeliver: (message: ChatMessage) => void,
  getJoinedGroups: () => ReadonlySet<string>,
  getSelfPosition: () => [number, number, number] | null,
  nearbyRadius: number = DEFAULT_NEARBY_RADIUS,
): ChatController {
  let lastSentAt = 0;

  const unsubscribe = transport.onMessage((raw) => {
    if (!isChatPayload(raw.payload)) return;
    const { message } = raw.payload;
    if (message.from === selfPeerId) return;
    if (isVisibleTo(message, getJoinedGroups(), getSelfPosition(), nearbyRadius)) {
      onDeliver(message);
    }
  });

  return {
    send(channel, text) {
      const clean = sanitizeChatText(text);
      if (!clean) return;
      const now = Date.now();
      if (now - lastSentAt < MIN_SEND_INTERVAL_MS) return;
      lastSentAt = now;

      const position = channel.kind === "nearby" ? getSelfPosition() ?? undefined : undefined;
      const message: ChatMessage = {
        id: crypto.randomUUID(),
        channel,
        from: selfPeerId,
        displayName: shortPeerName(selfPeerId),
        text: clean,
        sentAt: now,
        pos: position,
      };

      onDeliver({ ...message, from: "me" });
      void transport.publish({ type: "room" }, { kind: "kikorin-chat", message } satisfies ChatPayload);
    },
    dispose() {
      unsubscribe();
    },
  };
}
