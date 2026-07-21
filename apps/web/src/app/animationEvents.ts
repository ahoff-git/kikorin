// TS-facing animation-event adapter (ADR 0017). The engine dispatches gameplay
// frame events itself (e.g. the player's bullet on the strike frame); this lets
// *TypeScript game logic* also react to those frame events — footstep sounds, a
// muzzle flash, camera shake, custom hooks — without the engine knowing about
// them. It's a thin registry over the adapter's `animEventsChannel`.
//
// Usage:
//   const off = onAnimationEvent(FIRE_EVENT, (entity) => playSound("shot"));
//   // ...later: off();

import { animEventsChannel } from "@kikorin/adapter";

/** Called with the entity id each time a frame with this event id is entered. */
export type AnimationEventHandler = (entity: number) => void;

const handlers = new Map<number, Set<AnimationEventHandler>>();
let unsubscribeChannel: (() => void) | null = null;

function ensureSubscribed(): void {
  if (unsubscribeChannel) return;
  unsubscribeChannel = animEventsChannel.subscribe(() => {
    for (const ev of animEventsChannel.getSnapshot()) {
      const set = handlers.get(ev.event);
      if (!set) continue;
      for (const h of set) h(ev.entity);
    }
  });
}

/**
 * Register a handler for a frame-event id (the `event` marker on a FrameSpec).
 * Returns an unsubscribe function. Multiple handlers per id are allowed.
 */
export function onAnimationEvent(eventId: number, handler: AnimationEventHandler): () => void {
  ensureSubscribed();
  let set = handlers.get(eventId);
  if (!set) {
    set = new Set();
    handlers.set(eventId, set);
  }
  set.add(handler);
  return () => {
    set?.delete(handler);
  };
}
