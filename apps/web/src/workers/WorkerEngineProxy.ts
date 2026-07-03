// Proxy that routes EngineHandle-shaped calls to the WASM engine running in a Web Worker.
// Synchronous EngineHandle methods that return values (spawn_*, find_path, build_navmesh)
// become async here; fire-and-forget methods (set_entity_velocity, destroy_entity)
// remain synchronous from the caller's perspective.
// The worker drives its own simulation loop — there is no tick() method here.

import type { JsTerrainBlock, JsWaypoint, PatchBundle } from '@kikorin/adapter';

type WorkerOut =
  | { type: 'patches'; bundle: PatchBundle | null }
  | { type: 'ack'; id: number; result: unknown };

export class WorkerEngineProxy {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, (result: unknown) => void>();
  private patchCb: ((bundle: PatchBundle | null) => void) | null = null;

  constructor(worker: Worker) {
    this.worker = worker;
    worker.addEventListener('message', (e: MessageEvent<WorkerOut>) => {
      const msg = e.data;
      if (msg.type === 'patches') {
        this.patchCb?.(msg.bundle);
      } else if (msg.type === 'ack') {
        const resolve = this.pending.get(msg.id);
        if (resolve) { resolve(msg.result); this.pending.delete(msg.id); }
      }
    });
  }

  onPatches(cb: (bundle: PatchBundle | null) => void): void {
    this.patchCb = cb;
  }

  private request<T>(): [number, Promise<T>] {
    const id = this.seq++;
    const p = new Promise<T>(res => this.pending.set(id, res as (v: unknown) => void));
    return [id, p];
  }

  /** Load the WASM engine inside the worker. Must be awaited before any other call. */
  init(signalingUrl?: string, sessionId?: string): Promise<void> {
    const [id, p] = this.request<void>();
    // Pass origin so the worker can build an absolute WASM URL even when
    // Turbopack serves the worker from a blob URL (self.location.origin = "null").
    this.worker.postMessage({ type: 'init', id, signalingUrl, sessionId, origin: location.origin });
    return p;
  }

  set_entity_velocity(eid: number, vx: number, vy: number, vz: number): void {
    this.worker.postMessage({ type: 'set_velocity', eid, vx, vy, vz });
  }

  destroy_entity(eid: number): void {
    this.worker.postMessage({ type: 'destroy', eid });
  }

  spawn_box_entity(x: number, y: number, z: number, hw: number, hh: number, hd: number, health: number, net_flags: number): Promise<number> {
    const [id, p] = this.request<number>();
    this.worker.postMessage({ type: 'spawn_box', id, x, y, z, hw, hh, hd, health, net_flags });
    return p;
  }

  spawn_bullet(x: number, y: number, z: number, vx: number, vy: number, vz: number): Promise<number> {
    const [id, p] = this.request<number>();
    this.worker.postMessage({ type: 'spawn_bullet', id, x, y, z, vx, vy, vz });
    return p;
  }

  load_map(): Promise<JsTerrainBlock[]> {
    const [id, p] = this.request<JsTerrainBlock[]>();
    this.worker.postMessage({ type: 'load_map', id });
    return p;
  }

  find_path(sx: number, sy: number, sz: number, gx: number, gz: number, canJump: boolean): Promise<JsWaypoint[] | null> {
    const [id, p] = this.request<JsWaypoint[] | null>();
    this.worker.postMessage({ type: 'find_path', id, sx, sy, sz, gx, gz, canJump });
    return p;
  }

  /** Update the monster pathfinding goal. Fire-and-forget; call once per frame. */
  update_monster_goal(gx: number, gz: number): void {
    this.worker.postMessage({ type: 'update_monster_goal', gx, gz });
  }

  /** Initialise (or reinitialise) WebRTC networking inside the worker. Fire-and-forget. */
  init_networking(sessionId: string, signalingUrl: string): void {
    this.worker.postMessage({ type: 'init_networking', sessionId, signalingUrl });
  }

  terminate(): void {
    this.worker.terminate();
  }
}
