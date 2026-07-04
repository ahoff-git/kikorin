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
} from "@kikorin/adapter";
import type { PatchBundle } from "@kikorin/adapter";
import { WorkerEngineProxy } from "../workers/WorkerEngineProxy";
import { eventBus } from "@kikorin/events";
import { recordE2EFrame, recordE2EPatch } from "./e2eMetrics";

export type SendInput = (payload: Uint8Array) => void;

export interface UseEngineReturn {
  /** The engine proxy; null until the worker is initialised and WASM is loaded. */
  engine: WorkerEngineProxy | null;
  sendInput: SendInput;
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
  signalingUrl?: string,
  sessionId?: string,
): UseEngineReturn {
  const sendInputRef = useRef<SendInput>(() => {});
  const onFrameRef = useRef<(() => void) | null>(null);
  const [engine, setEngine] = useState<WorkerEngineProxy | null>(null);

  useEffect(() => {
    let rafId = 0;
    let running = false;
    let unsubRender: (() => void) | null = null;
    let proxy: WorkerEngineProxy | null = null;
    // EMA of worker tick_ms — α=0.1, converges in ~10 ticks.
    let emaTickMs = 16;

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
        if (bundle.render.length > 0) renderChannel.emit(bundle.render);
        if (bundle.semantic.length > 0) hudChannel.emit(bundle.semantic);
        if (bundle.net.length > 0) netChannel.emit(bundle.net);
        if (bundle.hits.length > 0) hitsChannel.emit(bundle.hits);
        metricsChannel.emit(bundle.metrics);
        recordE2EPatch(bundle);
        emaTickMs = emaTickMs * 0.9 + bundle.metrics.tick_ms * 0.1;
        eventBus.emit('ui:timeMetricsUpdate', {
          timeMetrics: { avgDelta: Math.round(emaTickMs * 10) / 10, ticksPerSecond: Math.round(1000 / emaTickMs) },
        });
      });

      // Load WASM inside the worker thread (async; main thread stays free).
      await proxy.init(signalingUrl, sessionId);

      setupRenderer(canvas);
      unsubRender = subscribeToRenderChannel();
      sendInputRef.current = () => {};

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

    start().catch(console.error);

    return () => {
      running = false;
      cancelAnimationFrame(rafId);
      unsubRender?.();
      disposeRenderer();
      proxy?.terminate();
      setEngine(null);
    };
  // canvasRef is a stable ref — safe to omit. signalingUrl/sessionId rarely change.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signalingUrl, sessionId]);

  return {
    engine,
    sendInput: (payload) => sendInputRef.current(payload),
    onFrameRef,
  };
}
