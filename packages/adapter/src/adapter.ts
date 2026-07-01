import type { EngineClass, EngineHandle, PatchBundle } from './types';
import { renderChannel, hudChannel, netChannel, metricsChannel } from './channels';

function dispatch(bundle: PatchBundle): void {
  if (bundle.render.length > 0) renderChannel.emit(bundle.render);
  if (bundle.semantic.length > 0) hudChannel.emit(bundle.semantic);
  if (bundle.net.length > 0) netChannel.emit(bundle.net);
  metricsChannel.emit(bundle.metrics);
}

/**
 * Process one engine tick: advance simulation, fan out patches to channels.
 * tick() now returns a PatchBundle JS object directly — no deserialize step.
 * Exported for testing; production callers use startEngineLoop.
 */
export function processFrame(
  engine: EngineHandle,
  _EngineClass: EngineClass,
  dt_ms: number,
): void {
  const bundle = engine.tick(dt_ms);
  if (bundle !== null) {
    dispatch(bundle);
  }
}

/**
 * Start the RAF tick loop.
 * Returns a stop function that cancels the loop.
 */
export function startEngineLoop(
  engine: EngineHandle,
  EngineClass: EngineClass,
): () => void {
  let rafId = 0;
  let lastTime = performance.now();
  let running = true;

  function frame(now: number): void {
    if (!running) return;
    const dt = Math.min(now - lastTime, 100);
    lastTime = now;
    processFrame(engine, EngineClass, dt);
    rafId = requestAnimationFrame(frame);
  }

  rafId = requestAnimationFrame(frame);
  return () => {
    running = false;
    cancelAnimationFrame(rafId);
  };
}

/**
 * Returns a function that sends an input payload to the engine.
 * Use this instead of holding a direct engine reference in application code.
 */
export function createInputSender(engine: EngineHandle) {
  return (payload: Uint8Array): void => {
    engine.apply_input(payload);
  };
}
