/**
 * The shared multiplayer room every instance of a given game joins by
 * default — a game-level identity, not a per-peer one. This app actually
 * ships several distinct games (3D, 2D, top-down) that must never end up in
 * the same room — one game's entities are meaningless to another's client —
 * so the room id is always scoped by `gameKey`. Purely a room-naming
 * concern, decoupled from physics `Dimension`: the top-down game passes
 * `dimension: "3d"` to `useEngine` (it reuses the 3D pipeline) but still
 * gets its own `"topdown"` room, distinct from the real 3D game's.
 *
 * Override the shared base via NEXT_PUBLIC_KIKORIN_ROOM_ID (e.g. in
 * .env.local) if you fork this app; every game's room moves together since
 * they derive from the same base, but stay distinct from each other.
 */
const BASE_ROOM_ID = process.env.NEXT_PUBLIC_KIKORIN_ROOM_ID ?? "kikorin";

export type GameKey = "2d" | "3d" | "topdown";

export interface GameRoom {
  roomId: string;
  /**
   * A well-known PeerJS id derived from roomId, prefixed to avoid colliding
   * with unrelated apps sharing the same public PeerJS broker. The first
   * instance of this game to start claims it and becomes the room's anchor
   * (genesis leader); everyone after that fails to claim it and dials it
   * directly instead — auto-discovery with no separate directory service.
   */
  anchorPeerId: string;
}

export function getGameRoom(gameKey: GameKey): GameRoom {
  const roomId = `${BASE_ROOM_ID}-${gameKey}`;
  return { roomId, anchorPeerId: `kikorin-room-${roomId}` };
}
