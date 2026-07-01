import { describe, expect, it, vi } from 'vitest';
import type { PatchBundle, EngineClass, EngineHandle } from './types';
import { Channel } from './channel';
import { processFrame } from './adapter';
import { renderChannel, hudChannel, netChannel, metricsChannel } from './channels';

// --- helpers ---

function makePatch(overrides?: Partial<PatchBundle>): PatchBundle {
  return {
    tick: 1,
    render: [{ entity: 42, x: 1, y: 2, z: 3, yaw: 0, pitch: 0, roll: 0 }],
    semantic: [{ entity: 42, health: 100, grounded: true }],
    net: [{ peer_id: 'peer-a', entity: 7 }],
    metrics: { tick_ms: 16, ecs_ms: 2, physics_ms: 8, net_ms: 1, patch_ms: 0.5 },
    ...overrides,
  };
}

function makeEngine(patch: PatchBundle | null): { engine: EngineHandle; EngineClass: EngineClass } {
  const engine: EngineHandle = {
    tick: vi.fn(() => patch),
    apply_input: vi.fn(),
    get_metrics: vi.fn(() => makePatch().metrics),
    set_log_level: vi.fn(),
    spawn_entity: vi.fn(() => 0),
    destroy_entity: vi.fn(),
    spawn_floor_entity: vi.fn(() => 0),
    spawn_box_entity: vi.fn(() => 0),
    set_entity_velocity: vi.fn(),
    build_navmesh: vi.fn(),
    find_path: vi.fn(() => null),
  };
  const EngineClass = {} as EngineClass;
  return { engine, EngineClass };
}

// --- Channel ---

describe('Channel', () => {
  it('delivers emitted values to all subscribers', () => {
    const ch = new Channel<number[]>([]);
    const log: number[][] = [];
    const unsub = ch.subscribe(() => log.push(ch.getSnapshot()));

    ch.emit([1, 2]);
    ch.emit([3, 4]);

    expect(log).toEqual([[1, 2], [3, 4]]);
    unsub();
    ch.emit([99]);
    expect(log).toHaveLength(2);
  });

  it('getSnapshot returns initial value before any emission', () => {
    const ch = new Channel<string>('hello');
    expect(ch.getSnapshot()).toBe('hello');
  });
});

// --- Adapter integration ---

describe('processFrame', () => {
  it('fans render patches to renderChannel', () => {
    const patch = makePatch();
    const { engine, EngineClass } = makeEngine(patch);

    const received: typeof patch.render[] = [];
    const unsub = renderChannel.subscribe(() => received.push(renderChannel.getSnapshot()));

    processFrame(engine, EngineClass, 16.67);

    expect(received).toHaveLength(1);
    expect(received[0][0].entity).toBe(42);
    expect(received[0][0].x).toBe(1);

    unsub();
  });

  it('fans semantic patches to hudChannel', () => {
    const patch = makePatch();
    const { engine, EngineClass } = makeEngine(patch);

    let snapshot = hudChannel.getSnapshot();
    const unsub = hudChannel.subscribe(() => { snapshot = hudChannel.getSnapshot(); });

    processFrame(engine, EngineClass, 16.67);

    expect(snapshot[0]?.health).toBe(100);
    expect(snapshot[0]?.grounded).toBe(true);

    unsub();
  });

  it('fans net patches to netChannel', () => {
    const patch = makePatch();
    const { engine, EngineClass } = makeEngine(patch);

    let snapshot = netChannel.getSnapshot();
    const unsub = netChannel.subscribe(() => { snapshot = netChannel.getSnapshot(); });

    processFrame(engine, EngineClass, 16.67);

    expect(snapshot[0]?.peer_id).toBe('peer-a');

    unsub();
  });

  it('always emits to metricsChannel', () => {
    const patch = makePatch();
    const { engine, EngineClass } = makeEngine(patch);

    let snapshot = metricsChannel.getSnapshot();
    const unsub = metricsChannel.subscribe(() => { snapshot = metricsChannel.getSnapshot(); });

    processFrame(engine, EngineClass, 16.67);

    expect(snapshot.tick_ms).toBe(16);
    expect(snapshot.ecs_ms).toBe(2);

    unsub();
  });

  it('does not emit to renderChannel when patch is null', () => {
    const { engine, EngineClass } = makeEngine(null);

    renderChannel.emit([]);
    const initial = renderChannel.getSnapshot();

    let emitted = false;
    const unsub = renderChannel.subscribe(() => { emitted = true; });

    processFrame(engine, EngineClass, 16.67);

    expect(emitted).toBe(false);
    expect(renderChannel.getSnapshot()).toBe(initial);

    unsub();
  });

  it('does not emit to renderChannel when render array is empty', () => {
    const patch = makePatch({ render: [] });
    const { engine, EngineClass } = makeEngine(patch);

    renderChannel.emit([]);
    let emitted = false;
    const unsub = renderChannel.subscribe(() => { emitted = true; });

    processFrame(engine, EngineClass, 16.67);

    expect(emitted).toBe(false);

    unsub();
  });
});
