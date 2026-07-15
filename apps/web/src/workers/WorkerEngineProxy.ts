// Proxy that routes EngineHandle-shaped calls to the WASM engine running in a Web Worker.
// Synchronous EngineHandle methods that return values (spawn_*, find_path, build_navmesh)
// become async here; fire-and-forget methods (set_entity_velocity, destroy_entity)
// remain synchronous from the caller's perspective.
// The worker drives its own simulation loop — there is no tick() method here.

import type { AiConfigInput, JsTerrainBlock, JsWaypoint, MonsterConfigInput, NavConfigInput, PatchBundle, PlayerConfigInput, PlayerInputState, TerrainBlockInput } from '@kikorin/adapter';

type NetOutItem = { peer: string | null; data: Uint8Array };

type WorkerOut =
  | { type: 'patches'; bundle: PatchBundle | null }
  | { type: 'net_out'; items: NetOutItem[] }
  | { type: 'ack'; id: number; result: unknown };

export class WorkerEngineProxy {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, (result: unknown) => void>();
  private patchCb: ((bundle: PatchBundle | null) => void) | null = null;
  private netOutCb: ((items: NetOutItem[]) => void) | null = null;

  constructor(worker: Worker) {
    this.worker = worker;
    worker.addEventListener('message', (e: MessageEvent<WorkerOut>) => {
      const msg = e.data;
      if (msg.type === 'patches') {
        this.patchCb?.(msg.bundle);
      } else if (msg.type === 'net_out') {
        this.netOutCb?.(msg.items);
      } else if (msg.type === 'ack') {
        const resolve = this.pending.get(msg.id);
        if (resolve) { resolve(msg.result); this.pending.delete(msg.id); }
      }
    });
  }

  onPatches(cb: (bundle: PatchBundle | null) => void): void {
    this.patchCb = cb;
  }

  /** Outbound peer payloads from the engine — the transport layer sends them. */
  onNetOut(cb: ((items: NetOutItem[]) => void) | null): void {
    this.netOutCb = cb;
  }

  private request<T>(): [number, Promise<T>] {
    const id = this.seq++;
    const p = new Promise<T>(res => this.pending.set(id, res as (v: unknown) => void));
    return [id, p];
  }

  /**
   * Load the WASM engine inside the worker. Must be awaited before any other
   * call. `dimension`: `"2d"` selects Rapier2D physics; omitted (or `"3d"`)
   * keeps the original Rapier3D behavior — see crates/physics's Dimension
   * for what "2D" means physically. `gravity`: overrides the engine-wide
   * gravity constant (e.g. `0` for a top-down, no-fall game); omitted keeps
   * the original value. Both are independent setup-time choices.
   */
  init(dimension?: "2d" | "3d", gravity?: number): Promise<void> {
    const [id, p] = this.request<void>();
    // Pass origin so the worker can build an absolute WASM URL even when
    // Turbopack serves the worker from a blob URL (self.location.origin = "null").
    this.worker.postMessage({ type: 'init', id, origin: location.origin, dimension, gravity });
    return p;
  }

  /** Transport bridge: a peer's data channel opened. Fire-and-forget. */
  net_peer_connected(peerId: string): void {
    this.worker.postMessage({ type: 'net_peer_connected', peerId });
  }

  /** Transport bridge: a peer's data channel closed. Fire-and-forget. */
  net_peer_disconnected(peerId: string): void {
    this.worker.postMessage({ type: 'net_peer_disconnected', peerId });
  }

  /** Transport bridge: inbound payload from a peer. Fire-and-forget. */
  net_ingest(peerId: string, data: Uint8Array): void {
    this.worker.postMessage({ type: 'net_ingest', peerId, data });
  }

  set_entity_velocity(eid: number, vx: number, vy: number, vz: number): void {
    this.worker.postMessage({ type: 'set_velocity', eid, vx, vy, vz });
  }

  teleport_entity(eid: number, x: number, y: number, z: number): void {
    this.worker.postMessage({ type: 'teleport', eid, x, y, z });
  }

  destroy_entity(eid: number): void {
    this.worker.postMessage({ type: 'destroy', eid });
  }

  spawn_box_entity(x: number, y: number, z: number, hw: number, hh: number, hd: number, health: number, net_flags: number): Promise<number> {
    const [id, p] = this.request<number>();
    this.worker.postMessage({ type: 'spawn_box', id, x, y, z, hw, hh, hd, health, net_flags });
    return p;
  }

  spawn_bullet(x: number, y: number, z: number, vx: number, vy: number, vz: number, net_flags: number): Promise<number> {
    const [id, p] = this.request<number>();
    this.worker.postMessage({ type: 'spawn_bullet', id, x, y, z, vx, vy, vz, net_flags });
    return p;
  }

  /** Static terrain body, without load_map's navmesh build. */
  spawn_floor_entity(x: number, y: number, z: number, hw: number, hh: number, hd: number): Promise<number> {
    const [id, p] = this.request<number>();
    this.worker.postMessage({ type: 'spawn_floor', id, x, y, z, hw, hh, hd });
    return p;
  }

  load_map(blocks: TerrainBlockInput[]): Promise<JsTerrainBlock[]> {
    const [id, p] = this.request<JsTerrainBlock[]>();
    this.worker.postMessage({ type: 'load_map', id, blocks });
    return p;
  }

  /** Build (or rebuild) the 2D navmesh from currently-spawned floor entities. Call once terrain is in place. */
  build_navmesh_2d(walkSpeed: number, jumpSpeed: number, maxJumps: number): Promise<void> {
    const [id, p] = this.request<void>();
    this.worker.postMessage({ type: 'build_navmesh_2d', id, walkSpeed, jumpSpeed, maxJumps });
    return p;
  }

  /** Mark a floor entity non-walkable (or clear that) after spawning it. Fire-and-forget. */
  set_terrain_walkable(eid: number, walkable: boolean): void {
    this.worker.postMessage({ type: 'set_terrain_walkable', eid, walkable });
  }

  /** Override monster AI tuning. Fire-and-forget; missing fields = engine defaults. */
  set_ai_config(cfg: AiConfigInput): void {
    this.worker.postMessage({ type: 'set_ai_config', cfg });
  }

  /** Override navmesh build tuning. Fire-and-forget; applies to the next load_map. */
  set_nav_config(cfg: NavConfigInput): void {
    this.worker.postMessage({ type: 'set_nav_config', cfg });
  }

  /** Override player controller/combat tuning. Fire-and-forget. */
  set_player_config(cfg: PlayerConfigInput): void {
    this.worker.postMessage({ type: 'set_player_config', cfg });
  }

  /** Override monster spawn/respawn tuning. Fire-and-forget. */
  set_monster_config(cfg: MonsterConfigInput): void {
    this.worker.postMessage({ type: 'set_monster_config', cfg });
  }

  /** Hand the entity to the engine's player controller. Fire-and-forget. */
  register_player(eid: number): void {
    this.worker.postMessage({ type: 'register_player', eid });
  }

  /** Latest raw input state; call once per frame. Fire-and-forget. */
  set_player_input(input: PlayerInputState): void {
    this.worker.postMessage({ type: 'set_player_input', input });
  }

  /** Fire one bullet along the player's facing. Fire-and-forget. */
  player_fire(): void {
    this.worker.postMessage({ type: 'player_fire' });
  }

  /** Spawn monsters on the configured ring. Fire-and-forget; spawns arrive as lifecycle patches. */
  spawn_monsters(count: number): void {
    this.worker.postMessage({ type: 'spawn_monsters', count });
  }

  find_path(sx: number, sy: number, sz: number, gx: number, gz: number, canJump: boolean): Promise<JsWaypoint[] | null> {
    const [id, p] = this.request<JsWaypoint[] | null>();
    this.worker.postMessage({ type: 'find_path', id, sx, sy, sz, gx, gz, canJump });
    return p;
  }

  /** Update the default monster goal. Fire-and-forget; call once per frame. */
  update_monster_goal(gx: number, gz: number): void {
    this.worker.postMessage({ type: 'update_monster_goal', gx, gz });
  }

  /** Give one monster its own goal, overriding the default until cleared. */
  set_monster_goal(eid: number, gx: number, gz: number): void {
    this.worker.postMessage({ type: 'set_monster_goal', eid, gx, gz });
  }

  /** Revert a monster to the default goal. */
  clear_monster_goal(eid: number): void {
    this.worker.postMessage({ type: 'clear_monster_goal', eid });
  }

  /** Initialise (or reinitialise) WebRTC networking inside the worker. Fire-and-forget. */
  init_networking(sessionId: string, signalingUrl: string, stunUrl?: string): void {
    this.worker.postMessage({ type: 'init_networking', sessionId, signalingUrl, stunUrl });
  }

  terminate(): void {
    this.worker.terminate();
  }
}
