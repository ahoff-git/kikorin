import type {
  ControlEvent,
  ControlEventFilter,
  ControlEventHandler,
  ControlEventInput,
  ControlFilter,
  ControlInputStateChange,
  ControlMatch,
  ControlPhase,
  ControlState,
  ControlTick,
  ControlTickHandler,
  CoreControls,
  CoreWorld,
} from "../types";
import { ControlSources, KeyboardControls, PointerControls } from "../types";

type EventListenerRecord<TWorld> = {
  id: number;
  filter: ControlEventFilter;
  handler: ControlEventHandler<TWorld>;
};

type TickListenerRecord<TWorld> = {
  id: number;
  handler: ControlTickHandler<TWorld>;
};

type ListenerRecord = {
  id: number;
};

type ControlInputConnection = {
  disconnect: () => void;
};

type InputStateEntry = {
  key: string;
  source: string;
  controlId: string;
  active: boolean;
  updatedAt: number;
  payload?: unknown;
};

const MANAGED_KEYBOARD_CONTROL_IDS = new Set<string>(
  Object.values(KeyboardControls),
);
const INPUT_TIMESTAMP_MAX_DRIFT_MS = 60_000;

function getNow(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

function normalizeTimestamp(timestamp?: number): number {
  const now = getNow();
  if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
    if (Math.abs(timestamp - now) <= INPUT_TIMESTAMP_MAX_DRIFT_MS) {
      return timestamp;
    }
  }
  return now;
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

function cloneEvent(event: ControlEvent): ControlEvent {
  return { ...event };
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

function createControlEvent(
  event: ControlEventInput,
  sequence: number,
): ControlEvent {
  return {
    sequence,
    timestamp: normalizeTimestamp(event.timestamp),
    source: event.source,
    controlId: event.controlId,
    phase: event.phase,
    value: normalizeValue(event.phase, event.value),
    payload: event.payload,
  };
}

function compareQueuedEvents(left: ControlEvent, right: ControlEvent): number {
  if (left.timestamp !== right.timestamp) {
    return left.timestamp - right.timestamp;
  }

  return left.sequence - right.sequence;
}

function insertQueuedEvent(queue: ControlEvent[], nextEvent: ControlEvent) {
  const queueLength = queue.length;
  if (
    queueLength === 0 ||
    compareQueuedEvents(queue[queueLength - 1]!, nextEvent) <= 0
  ) {
    queue.push(nextEvent);
    return;
  }

  let low = 0;
  let high = queueLength;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (compareQueuedEvents(queue[mid]!, nextEvent) <= 0) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  queue.splice(low, 0, nextEvent);
}

function removeListenerRecord<TRecord extends ListenerRecord>(
  records: TRecord[],
  id: number,
) {
  const index = records.findIndex((candidate) => candidate.id === id);
  if (index >= 0) {
    records.splice(index, 1);
  }
}

function getDefaultTick(): ControlTick {
  return {
    timestamp: getNow(),
    deltaMs: 0,
    deltaSeconds: 0,
    elapsedMs: 0,
  };
}

function notifyControlEventListeners<TWorld>(
  world: TWorld,
  event: ControlEvent,
  state: ControlState,
  eventListeners: EventListenerRecord<TWorld>[],
  controls: CoreControls<TWorld>,
) {
  for (let i = 0; i < eventListeners.length; i += 1) {
    const listener = eventListeners[i]!;
    if (!matchesEvent(listener.filter, event)) continue;
    try {
      listener.handler(world, event, cloneState(state), controls);
    } catch (error) {
      console.error("control event listener failed", event, error);
    }
  }
}

function processQueuedControlEvents<TWorld>(
  world: TWorld,
  tickTime: number,
  queue: ControlEvent[],
  frameEvents: ControlEvent[],
  states: Map<string, ControlState>,
  eventListeners: EventListenerRecord<TWorld>[],
  controls: CoreControls<TWorld>,
) {
  let processedCount = 0;
  while (processedCount < queue.length) {
    const event = queue[processedCount]!;
    if (event.timestamp > tickTime) break;

    const state = upsertState(states, event);
    applyEventToState(state, event);
    frameEvents.push(event);
    controls.stats.lastProcessedEvent = cloneEvent(event);
    notifyControlEventListeners(world, event, state, eventListeners, controls);
    processedCount += 1;
  }

  return processedCount;
}

function discardProcessedControlEvents(
  queue: ControlEvent[],
  processedCount: number,
) {
  if (processedCount > 0) {
    queue.splice(0, processedCount);
  }
}

function syncActiveControlDurations(
  states: Map<string, ControlState>,
  tickTime: number,
) {
  for (const state of states.values()) {
    if (!state.active) continue;
    state.durationMs = Math.max(0, tickTime - state.startedAt);
  }
}

function notifyControlTickListeners<TWorld>(
  world: TWorld,
  tick: ControlTick,
  tickListeners: TickListenerRecord<TWorld>[],
  controls: CoreControls<TWorld>,
) {
  for (let i = 0; i < tickListeners.length; i += 1) {
    try {
      tickListeners[i]!.handler(world, tick, controls);
    } catch (error) {
      console.error("control tick listener failed", error);
    }
  }
}

function getMatchingActiveStates(
  states: Map<string, ControlState>,
  filter: ControlFilter,
) {
  return Array.from(states.values()).filter((state) => {
    return state.active && matchesState(filter, state);
  });
}

function matchesInputState(
  filter: ControlFilter | undefined,
  state: InputStateEntry,
): boolean {
  if (!filter) return true;
  return (
    matchesValue(filter.source, state.source) &&
    matchesValue(filter.controlId, state.controlId)
  );
}

export function createControls<TWorld>(): CoreControls<TWorld> {
  const queue: ControlEvent[] = [];
  const frameEvents: ControlEvent[] = [];
  const states = new Map<string, ControlState>();
  const inputState = new Map<string, InputStateEntry>();
  const eventListeners: EventListenerRecord<TWorld>[] = [];
  const tickListeners: TickListenerRecord<TWorld>[] = [];
  const stats = {
    lastQueueLength: 0,
    lastProcessedCount: 0,
    lastProcessedEvent: null as ControlEvent | null,
    totalEnqueuedCount: 0,
    totalProcessedCount: 0,
  };
  let sequence = 0;
  let listenerSequence = 0;

  const controls = {
    queue,
    states,
    stats,
    enqueue,
    setInputState,
    isInputActive,
    on,
    onTick,
    process,
    getFrameEvents,
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
    const nextEvent = createControlEvent(event, sequence);
    sequence += 1;
    stats.totalEnqueuedCount += 1;
    insertQueuedEvent(queue, nextEvent);
    return nextEvent.sequence;
  }

  function setInputState(event: ControlInputStateChange): number | null {
    const timestamp = normalizeTimestamp(event.timestamp);
    const key = makeStateKey(event.source, event.controlId);
    const existing = inputState.get(key);
    if (existing?.active === event.active) {
      return null;
    }

    const nextState: InputStateEntry = existing ?? {
      key,
      source: event.source,
      controlId: event.controlId,
      active: false,
      updatedAt: timestamp,
      payload: event.payload,
    };
    nextState.active = event.active;
    nextState.updatedAt = timestamp;
    nextState.payload = event.payload;
    inputState.set(key, nextState);

    return enqueue({
      timestamp,
      source: event.source,
      controlId: event.controlId,
      phase: event.active ? "start" : (event.inactivePhase ?? "end"),
      value: event.active ? 1 : 0,
      payload: event.payload,
    });
  }

  function isInputActive(controlId: string, source?: string): boolean {
    if (source) {
      return inputState.get(makeStateKey(source, controlId))?.active ?? false;
    }

    for (const state of inputState.values()) {
      if (state.controlId === controlId && state.active) {
        return true;
      }
    }

    return false;
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
      removeListenerRecord(eventListeners, record.id);
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
      removeListenerRecord(tickListeners, record.id);
    };
  }

  function process(world: TWorld, tick: ControlTick = getDefaultTick()) {
    const tickTime = tick.timestamp;
    stats.lastQueueLength = queue.length;
    frameEvents.length = 0;
    const processedCount = processQueuedControlEvents(
      world,
      tickTime,
      queue,
      frameEvents,
      states,
      eventListeners,
      controls,
    );
    stats.lastProcessedCount = processedCount;
    stats.totalProcessedCount += processedCount;
    discardProcessedControlEvents(queue, processedCount);
    syncActiveControlDurations(states, tickTime);
    notifyControlTickListeners(world, tick, tickListeners, controls);
  }

  function getFrameEvents(): ControlEvent[] {
    return frameEvents.map(cloneEvent);
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
    const cancelledKeys = new Set<string>();

    for (const state of inputState.values()) {
      if (!state.active || !matchesInputState(filter, state)) {
        continue;
      }

      state.active = false;
      state.updatedAt = cancelTimestamp;
      state.payload = { reason: "cancelActive" };
      cancelledKeys.add(state.key);
      enqueue({
        timestamp: cancelTimestamp,
        source: state.source,
        controlId: state.controlId,
        phase: "cancel",
        value: 0,
        payload: state.payload,
      });
    }

    const activeStates = getMatchingActiveStates(states, filter);
    for (let i = 0; i < activeStates.length; i += 1) {
      const state = activeStates[i]!;
      if (cancelledKeys.has(state.key) || inputState.has(state.key)) {
        continue;
      }
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
    frameEvents.length = 0;
    stats.lastQueueLength = 0;
    stats.lastProcessedCount = 0;
    stats.lastProcessedEvent = null;
    stats.totalEnqueuedCount = 0;
    stats.totalProcessedCount = 0;
    inputState.clear();
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

function isManagedKeyboardControl(controlId: string): boolean {
  return MANAGED_KEYBOARD_CONTROL_IDS.has(controlId);
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

function createKeyboardPayload(event: KeyboardEvent) {
  return {
    key: event.key,
    altKey: event.altKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    repeat: event.repeat,
    shiftKey: event.shiftKey,
  };
}

function createPointerPayload(event: PointerEvent) {
  return {
    button: event.button,
    buttons: event.buttons,
    clientX: event.clientX,
    clientY: event.clientY,
    pointerId: event.pointerId,
    pointerType: event.pointerType,
  };
}

function createMousePayload(event: MouseEvent) {
  return {
    button: event.button,
    buttons: event.buttons,
    clientX: event.clientX,
    clientY: event.clientY,
    pointerId: -1,
    pointerType: "mouse",
    fallback: true,
  };
}

function trySetPointerCapture(element: HTMLElement, pointerId: number) {
  if (!("setPointerCapture" in element)) {
    return;
  }

  try {
    element.setPointerCapture(pointerId);
  } catch {
    // Some browsers can reject capture if the pointer is already gone.
  }
}

function tryReleasePointerCapture(element: HTMLElement, pointerId: number) {
  if (!("releasePointerCapture" in element)) {
    return;
  }

  try {
    element.releasePointerCapture(pointerId);
  } catch {
    // Safe to ignore if capture was already released.
  }
}

function isEventTargetWithinElement(
  element: HTMLElement,
  event: Event,
): boolean {
  const eventTarget = event.target;
  if (eventTarget instanceof Node && element.contains(eventTarget)) {
    return true;
  }

  if (typeof event.composedPath === "function") {
    return event.composedPath().includes(element);
  }

  return false;
}

function isPointerInsideElement(
  element: HTMLElement,
  event: MouseEvent | PointerEvent,
): boolean {
  if (isEventTargetWithinElement(element, event)) {
    return true;
  }

  const bounds = element.getBoundingClientRect();
  return (
    event.clientX >= bounds.left &&
    event.clientX <= bounds.right &&
    event.clientY >= bounds.top &&
    event.clientY <= bounds.bottom
  );
}

function connectKeyboardControlInputs(
  world: CoreWorld,
  disconnectors: Array<() => void>,
) {
  const onKeyDown = (event: KeyboardEvent) => {
    if (shouldIgnoreKeyboardEventTarget(event)) return;
    if (!isManagedKeyboardControl(event.code)) return;
    event.preventDefault();
    if (world.controls.isInputActive(event.code, ControlSources.Keyboard)) {
      return;
    }
    world.controls.setInputState({
      timestamp: event.timeStamp,
      source: ControlSources.Keyboard,
      controlId: event.code,
      active: true,
      payload: createKeyboardPayload(event),
    });
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (shouldIgnoreKeyboardEventTarget(event)) return;
    if (!isManagedKeyboardControl(event.code)) return;
    event.preventDefault();
    world.controls.setInputState({
      timestamp: event.timeStamp,
      source: ControlSources.Keyboard,
      controlId: event.code,
      active: false,
      payload: createKeyboardPayload(event),
    });
  };

  const onBlur = () => {
    world.controls.cancelActive(
      { source: [ControlSources.Keyboard, ControlSources.Pointer] },
      getNow(),
    );
  };

  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("keyup", onKeyUp);
  window.addEventListener("blur", onBlur);
  disconnectors.push(() => window.removeEventListener("keydown", onKeyDown));
  disconnectors.push(() => window.removeEventListener("keyup", onKeyUp));
  disconnectors.push(() => window.removeEventListener("blur", onBlur));
}

function connectPointerControlInputs(
  world: CoreWorld,
  element: HTMLElement,
  disconnectors: Array<() => void>,
) {
  const applyPointerDown = (event: PointerEvent) => {
    if (!isPointerInsideElement(element, event)) {
      return;
    }

    trySetPointerCapture(element, event.pointerId);
    world.controls.setInputState({
      timestamp: event.timeStamp,
      source: ControlSources.Pointer,
      controlId: mouseButtonToControlId(event.button),
      active: true,
      payload: createPointerPayload(event),
    });
  };

  const applyPointerUp = (event: PointerEvent) => {
    tryReleasePointerCapture(element, event.pointerId);
    world.controls.setInputState({
      timestamp: event.timeStamp,
      source: ControlSources.Pointer,
      controlId: mouseButtonToControlId(event.button),
      active: false,
      payload: createPointerPayload(event),
    });
  };

  const applyPointerCancel = (event: PointerEvent) => {
    world.controls.cancelActive({ source: ControlSources.Pointer }, event.timeStamp);
  };

  const applyMouseDown = (event: MouseEvent) => {
    if (!isPointerInsideElement(element, event)) {
      return;
    }

    world.controls.setInputState({
      timestamp: event.timeStamp,
      source: ControlSources.Pointer,
      controlId: mouseButtonToControlId(event.button),
      active: true,
      payload: createMousePayload(event),
    });
  };

  const applyMouseUp = (event: MouseEvent) => {
    world.controls.setInputState({
      timestamp: event.timeStamp,
      source: ControlSources.Pointer,
      controlId: mouseButtonToControlId(event.button),
      active: false,
      payload: createMousePayload(event),
    });
  };

  const onWindowBlur = () => {
    world.controls.cancelActive({ source: ControlSources.Pointer }, getNow());
  };

  element.addEventListener("pointerdown", applyPointerDown);
  element.addEventListener("pointerup", applyPointerUp);
  element.addEventListener("pointercancel", applyPointerCancel);
  element.addEventListener("mousedown", applyMouseDown);
  element.addEventListener("mouseup", applyMouseUp);
  window.addEventListener("pointerdown", applyPointerDown, true);
  window.addEventListener("pointerup", applyPointerUp, true);
  window.addEventListener("pointercancel", applyPointerCancel, true);
  window.addEventListener("mousedown", applyMouseDown, true);
  window.addEventListener("mouseup", applyMouseUp, true);
  window.addEventListener("blur", onWindowBlur);
  disconnectors.push(() => element.removeEventListener("pointerdown", applyPointerDown));
  disconnectors.push(() => element.removeEventListener("pointerup", applyPointerUp));
  disconnectors.push(() => element.removeEventListener("pointercancel", applyPointerCancel));
  disconnectors.push(() => element.removeEventListener("mousedown", applyMouseDown));
  disconnectors.push(() => element.removeEventListener("mouseup", applyMouseUp));
  disconnectors.push(() =>
    window.removeEventListener("pointerdown", applyPointerDown, true),
  );
  disconnectors.push(() =>
    window.removeEventListener("pointerup", applyPointerUp, true),
  );
  disconnectors.push(() =>
    window.removeEventListener("pointercancel", applyPointerCancel, true),
  );
  disconnectors.push(() =>
    window.removeEventListener("mousedown", applyMouseDown, true),
  );
  disconnectors.push(() =>
    window.removeEventListener("mouseup", applyMouseUp, true),
  );
  disconnectors.push(() => window.removeEventListener("blur", onWindowBlur));
}

function disconnectControlInputs(disconnectors: Array<() => void>) {
  for (let i = disconnectors.length - 1; i >= 0; i -= 1) {
    disconnectors[i]!();
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
  connectKeyboardControlInputs(world, disconnectors);

  if (element) {
    connectPointerControlInputs(world, element, disconnectors);
  }

  return {
    disconnect() {
      disconnectControlInputs(disconnectors);
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
