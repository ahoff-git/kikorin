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
 * Discovery (finding who else is already in this room, or becoming its
 * genesis leader if nobody is) goes through the real, shared awari
 * bootstrap service (see `httpBootstrapClient.ts` and `useNetworking.ts`) —
 * this module only owns the room's *name*, not how peers find each other.
 *
 * Override the shared base via NEXT_PUBLIC_KIKORIN_ROOM_ID (e.g. in
 * .env.local) if you fork this app; every game's room moves together since
 * they derive from the same base, but stay distinct from each other.
 */
const BASE_ROOM_ID = process.env.NEXT_PUBLIC_KIKORIN_ROOM_ID ?? "kikorin";

export type GameKey = "2d" | "3d" | "topdown";

export interface GameRoom {
  roomId: string;
}

export function getGameRoom(gameKey: GameKey): GameRoom {
  return { roomId: `${BASE_ROOM_ID}-${gameKey}` };
}
