import type {
  ControlEvent,
  ControlEventFilter,
  ControlEventHandler,
  ControlEventInput,
  ControlFilter,
  ControlMatch,
  ControlPhase,
  ControlState,
  ControlTick,
  ControlTickHandler,
  CoreControls,
  CoreWorld,
} from "../types";
import { ControlSources, PointerControls } from "../types";

type EventListenerRecord<TWorld> = {
  id: number;
  filter: ControlEventFilter;
  handler: ControlEventHandler<TWorld>;
};

type TickListenerRecord<TWorld> = {
  id: number;
  handler: ControlTickHandler<TWorld>;
};

type ControlInputConnection = {
  disconnect: () => void;
};

function getNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function normalizeTimestamp(timestamp?: number): number {
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    return timestamp;
  }
  return getNow();
}

function normalizeValue(phase: ControlPhase, value?: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  switch (phase) {
    case "end":
    case "cancel":
      return 0;
    default:
      return 1;
  }
}

function makeStateKey(source: string, controlId: string): string {
  return `${source}:${controlId}`;
}

function cloneState(state: ControlState): ControlState {
  return { ...state };
}

function findState(
  states: Map<string, ControlState>,
  controlId: string,
  source?: string,
): ControlState | undefined {
  if (source) {
    return states.get(makeStateKey(source, controlId));
  }

  for (const state of states.values()) {
    if (state.controlId === controlId) return state;
  }

  return undefined;
}

function matchesValue<TValue extends string>(
  matcher: ControlMatch<TValue> | undefined,
  value: TValue,
): boolean {
  if (matcher === undefined || matcher === "*") return true;
  if (Array.isArray(matcher)) return matcher.includes(value);
  return matcher === value;
}

function matchesState(
  filter: ControlFilter | undefined,
  state: ControlState,
): boolean {
  if (!filter) return true;
  return (
    matchesValue(filter.source, state.source) &&
    matchesValue(filter.controlId, state.controlId)
  );
}

function matchesEvent(
  filter: ControlEventFilter,
  event: ControlEvent,
): boolean {
  return (
    matchesValue(filter.source, event.source) &&
    matchesValue(filter.controlId, event.controlId) &&
    matchesValue(filter.phase, event.phase)
  );
}

function upsertState(
  states: Map<string, ControlState>,
  event: ControlEvent,
): ControlState {
  const key = makeStateKey(event.source, event.controlId);
  const existing = states.get(key);
  if (existing) return existing;

  const nextState: ControlState = {
    key,
    source: event.source,
    controlId: event.controlId,
    active: false,
    value: 0,
    startedAt: 0,
    updatedAt: event.timestamp,
    durationMs: 0,
    totalDurationMs: 0,
    activationCount: 0,
    triggerCount: 0,
    lastTriggeredAt: 0,
    phase: event.phase,
    payload: event.payload,
  };
  states.set(key, nextState);
  return nextState;
}

function applyEventToState(state: ControlState, event: ControlEvent) {
  state.value = event.value;
  state.updatedAt = event.timestamp;
  state.phase = event.phase;
  state.payload = event.payload;

  switch (event.phase) {
    case "start":
    case "change": {
      if (!state.active) {
        state.active = true;
        state.startedAt = event.timestamp;
        state.activationCount += 1;
      }
      state.durationMs = Math.max(0, event.timestamp - state.startedAt);
      return;
    }
    case "end":
    case "cancel": {
      if (state.active) {
        const heldFor = Math.max(0, event.timestamp - state.startedAt);
        state.durationMs = heldFor;
        state.totalDurationMs += heldFor;
      } else {
        state.durationMs = 0;
      }
      state.active = false;
      return;
    }
    case "trigger": {
      state.active = false;
      state.durationMs = 0;
      state.triggerCount += 1;
      state.lastTriggeredAt = event.timestamp;
      return;
    }
  }
}

export function createControls<TWorld>(): CoreControls<TWorld> {
  const queue: ControlEvent[] = [];
  const states = new Map<string, ControlState>();
  const eventListeners: EventListenerRecord<TWorld>[] = [];
  const tickListeners: TickListenerRecord<TWorld>[] = [];
  let sequence = 0;
  let listenerSequence = 0;

  const controls = {
    queue,
    states,
    enqueue,
    on,
    onTick,
    process,
    getState,
    getStates,
    getActiveStates,
    isActive,
    isAnyActive,
    getAxis,
    cancelActive,
    clear,
  } satisfies CoreControls<TWorld>;

  function enqueue(event: ControlEventInput): number {
    const timestamp = normalizeTimestamp(event.timestamp);
    const nextEvent: ControlEvent = {
      sequence,
      timestamp,
      source: event.source,
      controlId: event.controlId,
      phase: event.phase,
      value: normalizeValue(event.phase, event.value),
      payload: event.payload,
    };
    sequence += 1;

    const queueLength = queue.length;
    if (queueLength === 0 || queue[queueLength - 1]!.timestamp <= timestamp) {
      queue.push(nextEvent);
      return nextEvent.sequence;
    }

    let low = 0;
    let high = queueLength;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (queue[mid]!.timestamp <= timestamp) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    queue.splice(low, 0, nextEvent);
    return nextEvent.sequence;
  }

  function on(
    filter: ControlEventFilter,
    handler: ControlEventHandler<TWorld>,
  ): () => void {
    const record: EventListenerRecord<TWorld> = {
      id: listenerSequence,
      filter,
      handler,
    };
    listenerSequence += 1;
    eventListeners.push(record);

    return () => {
      const index = eventListeners.findIndex((candidate) => candidate.id === record.id);
      if (index >= 0) eventListeners.splice(index, 1);
    };
  }

  function onTick(handler: ControlTickHandler<TWorld>): () => void {
    const record: TickListenerRecord<TWorld> = {
      id: listenerSequence,
      handler,
    };
    listenerSequence += 1;
    tickListeners.push(record);

    return () => {
      const index = tickListeners.findIndex((candidate) => candidate.id === record.id);
      if (index >= 0) tickListeners.splice(index, 1);
    };
  }

  function process(
    world: TWorld,
    tick: ControlTick = {
      timestamp: getNow(),
      deltaMs: 0,
      deltaSeconds: 0,
      elapsedMs: 0,
    },
  ) {
    const tickTime = tick.timestamp;
    let processedCount = 0;
    while (processedCount < queue.length) {
      const event = queue[processedCount]!;
      if (event.timestamp > tickTime) break;

      const state = upsertState(states, event);
      applyEventToState(state, event);

      for (let i = 0; i < eventListeners.length; i += 1) {
        const listener = eventListeners[i]!;
        if (!matchesEvent(listener.filter, event)) continue;
        try {
          listener.handler(world, event, cloneState(state), controls);
        } catch (error) {
          console.error("control event listener failed", event, error);
        }
      }

      processedCount += 1;
    }

    if (processedCount > 0) {
      queue.splice(0, processedCount);
    }

    for (const state of states.values()) {
      if (!state.active) continue;
      state.durationMs = Math.max(0, tickTime - state.startedAt);
    }

    for (let i = 0; i < tickListeners.length; i += 1) {
      try {
        tickListeners[i]!.handler(world, tick, controls);
      } catch (error) {
        console.error("control tick listener failed", error);
      }
    }
  }

  function getState(controlId: string, source?: string): ControlState | undefined {
    const state = findState(states, controlId, source);
    return state ? cloneState(state) : undefined;
  }

  function getStates(): ControlState[] {
    return Array.from(states.values(), cloneState).sort((a, b) => {
      if (a.active !== b.active) return a.active ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  }

  function getActiveStates(): ControlState[] {
    return Array.from(states.values())
      .filter((state) => state.active)
      .map(cloneState)
      .sort((a, b) => b.durationMs - a.durationMs);
  }

  function isActive(controlId: string, source?: string): boolean {
    const state = findState(states, controlId, source);
    return state?.active ?? false;
  }

  function isAnyActive(controlIds: string[], source?: string): boolean {
    for (let i = 0; i < controlIds.length; i += 1) {
      if (isActive(controlIds[i]!, source)) return true;
    }
    return false;
  }

  function getAxis(
    negativeControlIds: string[],
    positiveControlIds: string[],
    source?: string,
  ): number {
    const negative = isAnyActive(negativeControlIds, source) ? -1 : 0;
    const positive = isAnyActive(positiveControlIds, source) ? 1 : 0;
    return negative + positive;
  }

  function cancelActive(filter: ControlFilter = {}, timestamp?: number) {
    const cancelTimestamp = normalizeTimestamp(timestamp);
    const activeStates = Array.from(states.values()).filter((state) => {
      return state.active && matchesState(filter, state);
    });

    for (let i = 0; i < activeStates.length; i += 1) {
      const state = activeStates[i]!;
      enqueue({
        timestamp: cancelTimestamp,
        source: state.source,
        controlId: state.controlId,
        phase: "cancel",
        value: 0,
        payload: { reason: "cancelActive" },
      });
    }
  }

  function clear() {
    queue.length = 0;
    states.clear();
    eventListeners.length = 0;
    tickListeners.length = 0;
  }

  return controls;
}

function shouldIgnoreKeyboardEventTarget(event: KeyboardEvent): boolean {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return false;
  const tagName = target.tagName;
  return (
    target.isContentEditable ||
    tagName === "INPUT" ||
    tagName === "TEXTAREA" ||
    tagName === "SELECT"
  );
}

function mouseButtonToControlId(button: number): string {
  switch (button) {
    case 0:
      return PointerControls.Primary;
    case 1:
      return PointerControls.Middle;
    case 2:
      return PointerControls.Secondary;
    default:
      return `button-${button}`;
  }
}

export function setupControlInputs(
  world: CoreWorld,
  element: HTMLElement | null,
): ControlInputConnection {
  if (typeof window === "undefined") {
    return {
      disconnect() {
        return;
      },
    };
  }

  const disconnectors: Array<() => void> = [];

  const onKeyDown = (event: KeyboardEvent) => {
    if (shouldIgnoreKeyboardEventTarget(event)) return;
    world.controls.enqueue({
      timestamp: event.timeStamp,
      source: ControlSources.Keyboard,
      controlId: event.code,
      phase: event.repeat ? "change" : "start",
      value: 1,
      payload: {
        key: event.key,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        repeat: event.repeat,
      },
    });
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (shouldIgnoreKeyboardEventTarget(event)) return;
    world.controls.enqueue({
      timestamp: event.timeStamp,
      source: ControlSources.Keyboard,
      controlId: event.code,
      phase: "end",
      value: 0,
      payload: {
        key: event.key,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      },
    });
  };

  const onBlur = () => {
    world.controls.cancelActive({ source: [ControlSources.Keyboard, ControlSources.Pointer] }, getNow());
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  disconnectors.push(() => window.removeEventListener("keydown", onKeyDown));
  disconnectors.push(() => window.removeEventListener("keyup", onKeyUp));
  disconnectors.push(() => window.removeEventListener("blur", onBlur));

  if (element) {
    const onPointerDown = (event: PointerEvent) => {
      if ("setPointerCapture" in element) {
        try {
          element.setPointerCapture(event.pointerId);
        } catch {
          // Some browsers can reject capture if the pointer is already gone.
        }
      }

      world.controls.enqueue({
        timestamp: event.timeStamp,
        source: ControlSources.Pointer,
        controlId: mouseButtonToControlId(event.button),
        phase: "start",
        value: 1,
        payload: {
          button: event.button,
          buttons: event.buttons,
          clientX: event.clientX,
          clientY: event.clientY,
          pointerId: event.pointerId,
          pointerType: event.pointerType,
        },
      });
    };

    const onPointerUp = (event: PointerEvent) => {
      if ("releasePointerCapture" in element) {
        try {
          element.releasePointerCapture(event.pointerId);
        } catch {
          // Safe to ignore if capture was already released.
        }
      }

      world.controls.enqueue({
        timestamp: event.timeStamp,
        source: ControlSources.Pointer,
        controlId: mouseButtonToControlId(event.button),
        phase: "end",
        value: 0,
        payload: {
          button: event.button,
          buttons: event.buttons,
          clientX: event.clientX,
          clientY: event.clientY,
          pointerId: event.pointerId,
          pointerType: event.pointerType,
        },
      });
    };

    const onPointerCancel = (event: PointerEvent) => {
      world.controls.cancelActive({ source: ControlSources.Pointer }, event.timeStamp);
    };

    const onClick = (event: MouseEvent) => {
      world.controls.enqueue({
        timestamp: event.timeStamp,
        source: ControlSources.Pointer,
        controlId: mouseButtonToControlId(event.button),
        phase: "trigger",
        value: 1,
        payload: {
          button: event.button,
          clientX: event.clientX,
          clientY: event.clientY,
          detail: event.detail,
          kind: "click",
        },
      });
    };

    element.addEventListener("pointerdown", onPointerDown);
    element.addEventListener("pointerup", onPointerUp);
    element.addEventListener("pointercancel", onPointerCancel);
    element.addEventListener("click", onClick);
    disconnectors.push(() => element.removeEventListener("pointerdown", onPointerDown));
    disconnectors.push(() => element.removeEventListener("pointerup", onPointerUp));
    disconnectors.push(() => element.removeEventListener("pointercancel", onPointerCancel));
    disconnectors.push(() => element.removeEventListener("click", onClick));
  }

  return {
    disconnect() {
      for (let i = disconnectors.length - 1; i >= 0; i -= 1) {
        disconnectors[i]!();
      }
    },
  };
}

export function controlsSystem(world: CoreWorld) {
  world.controls.process(world, {
    timestamp: world.time.then,
    deltaMs: world.time.delta,
    deltaSeconds: world.time.delta * 0.001,
    elapsedMs: world.time.elapsed,
  });
}
