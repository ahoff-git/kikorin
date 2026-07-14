/**
 * The shared multiplayer room every instance of this game joins by default —
 * a game-level identity, not a per-peer one. Override via
 * NEXT_PUBLIC_KIKORIN_ROOM_ID (e.g. in .env.local) if you fork this app for a
 * different game; anyone using the same value ends up in the same room.
 */
export const GAME_ROOM_ID = process.env.NEXT_PUBLIC_KIKORIN_ROOM_ID ?? "kikorin";

/**
 * A well-known PeerJS id derived from GAME_ROOM_ID, prefixed to avoid
 * colliding with unrelated apps sharing the same public PeerJS broker. The
 * first instance of this game to start claims it and becomes the room's
 * anchor (genesis leader); everyone after that fails to claim it and dials
 * it directly instead — auto-discovery with no separate directory service.
 */
export const GAME_ROOM_ANCHOR_PEER_ID = `kikorin-room-${GAME_ROOM_ID}`;
