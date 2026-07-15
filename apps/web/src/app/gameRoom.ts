/**
 * The shared multiplayer room every instance of a given game joins by
 * default — a game-level identity, not a per-peer one. This app actually
 * ships two distinct games (the 3D and 2D versions) that must never end up
 * in the same room — a 2D client's entities are meaningless to a 3D client
 * and vice versa — so the room id is always scoped by `gameKey` ("3d" | "2d").
 *
 * Override the shared base via NEXT_PUBLIC_KIKORIN_ROOM_ID (e.g. in
 * .env.local) if you fork this app; both games' rooms move together since
 * they derive from the same base, but stay distinct from each other.
 */
const BASE_ROOM_ID = process.env.NEXT_PUBLIC_KIKORIN_ROOM_ID ?? "kikorin";

export type GameKey = "2d" | "3d";

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
