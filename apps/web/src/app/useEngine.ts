"use client";

import { type RefObject, useEffect, useRef, useState } from "react";
import {
  setupRenderer,
  disposeRenderer,
  subscribeToRenderChannel,
  renderFrame,
} from "@kikorin/system-rendering";
import {
  renderChannel,
  hudChannel,
  netChannel,
  metricsChannel,
  hitsChannel,
  lifecycleChannel,
} from "@kikorin/adapter";
import type { PatchBundle } from "@kikorin/adapter";
import { WorkerEngineProxy } from "../workers/WorkerEngineProxy";
import { eventBus } from "@kikorin/events";
import { log, logLevels } from "@kikorin/util";
import { recordE2EFrame, recordE2EPatch } from "./e2eMetrics";

export interface UseEngineReturn {
  /** The engine proxy; null until the worker is initialised and WASM is loaded. */
  engine: WorkerEngineProxy | null;
  /**
   * Inject per-frame game logic (camera follow, control processing, etc.).
   * The callback runs after the tick command is sent and before rendering each frame.
   * Set this ref in a useEffect that depends on `engine`.
   */
  onFrameRef: RefObject<(() => void) | null>;
}

/**
 * Spawns a Web Worker hosting the Rust WASM engine, initialises the Three.js renderer,
 * and drives the RAF render loop: onFrame callback → render.
 *
 * The worker runs its own simulation loop as fast as the host allows and flushes patches
 * to the main thread at ~60 Hz. The render loop consumes those patches asynchronously,
 * so rendering always uses the most recent flushed positions.
 */
export function useEngine(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  dimension: "2d" | "3d" = "3d",
  gravity?: number,
  // Independent of `dimension` (see packages/system-rendering/src/render.ts's
  // doc comment) — defaults to matching it, which is what both existing
  // games want. The top-down game is the first to need them to differ: 3D
  // physics (X/Z ground plane, so monster AI/pathfinding need no changes)
  // rendered through the 2D mode's orthographic camera for a true overhead
  // look instead of perspective distortion.
  renderMode?: "2d" | "3d",
): UseEngineReturn {
  const onFrameRef = useRef<(() => void) | null>(null);
  const [engine, setEngine] = useState<WorkerEngineProxy | null>(null);

  useEffect(() => {
    let rafId = 0;
    let running = false;
    let unsubRender: (() => void) | null = null;
    let proxy: WorkerEngineProxy | null = null;
    // EMA of the Rust tick's execution cost (tick_ms) — α=0.1. This measures how
    // expensive a tick is, NOT how often ticks run.
    let emaTickMs = 4;
    // Actual TPS is measured from the bundle's tick counter against wall-clock
    // time between flushes (~250 when the sim keeps up with its 4 ms step).
    let prevTick = 0;
    let prevTickTimeMs = 0;

    async function start() {
      const canvas = canvasRef.current;
      if (!canvas) return;

      const worker = new Worker(
        new URL('../workers/engineWorker', import.meta.url),
        { type: 'module' },
      );
      proxy = new WorkerEngineProxy(worker);

      // Route physics patches from the worker to the channel system.
      proxy.onPatches((bundle: PatchBundle | null) => {
        if (!bundle) return;
        // lifecycle/net must be applied before render: they're what creates
        // an entity's Object3D (upsertObjectByEid); a render patch only
        // moves an existing one (setObjectTransformByEid no-ops silently if
        // it doesn't exist yet). Render-before-creation meant a brand-new
        // entity's first position update was dropped — it rendered at
        // Three.js's default (0,0,0) until the next update, or forever if
        // there never was one (e.g. a stationary remote player's mirror,
        // which only moves on a Delta and gets none while its owner stands
        // still) — see specs/patch/README.md.
        if (bundle.lifecycle.length > 0) lifecycleChannel.emit(bundle.lifecycle);
        if (bundle.net.length > 0) netChannel.emit(bundle.net);
        if (bundle.render.length > 0) renderChannel.emit(bundle.render);
        if (bundle.semantic.length > 0) hudChannel.emit(bundle.semantic);
        if (bundle.hits.length > 0) hitsChannel.emit(bundle.hits);
        metricsChannel.emit(bundle.metrics);
        recordE2EPatch(bundle);

        emaTickMs = emaTickMs * 0.9 + bundle.metrics.tick_ms * 0.1;
        const now = performance.now();
        const ticksPerSecond =
          prevTickTimeMs > 0 && now > prevTickTimeMs
            ? ((bundle.tick - prevTick) * 1000) / (now - prevTickTimeMs)
            : 0;
        prevTick = bundle.tick;
        prevTickTimeMs = now;

        eventBus.emit('ui:timeMetricsUpdate', {
          timeMetrics: {
            avgDelta: Math.round(emaTickMs * 10) / 10,
            ticksPerSecond: Math.round(ticksPerSecond),
          },
        });
      });

      // Load WASM inside the worker thread (async; main thread stays free).
      await proxy.init(dimension, gravity);

      setupRenderer(canvas, renderMode ?? dimension);
      unsubRender = subscribeToRenderChannel();

      running = true;

      function frame() {
        if (!running) return;
        // Per-frame game logic (controls, camera follow) injected by scene setup.
        onFrameRef.current?.();
        renderFrame();
        recordE2EFrame();
        rafId = requestAnimationFrame(frame);
      }

      rafId = requestAnimationFrame(frame);
      setEngine(proxy);
    }

    start().catch((err) => log(logLevels.error, "engine start failed", ["engine"], err));

    return () => {
      running = false;
      cancelAnimationFrame(rafId);
      unsubRender?.();
      disposeRenderer();
      proxy?.terminate();
      setEngine(null);
    };
  // canvasRef is a stable ref, and dimension/gravity/renderMode are all
  // fixed setup choices for a given page (never change after mount) — safe
  // to omit all four.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    engine,
    onFrameRef,
  };
}
