import { entityExists, getAllEntities } from "bitecs";

export const FlaginatorSourceKinds = {
  Component: "component",
  Marker: "marker",
  Custom: "custom",
} as const;

export type FlaginatorSourceKind =
  typeof FlaginatorSourceKinds[keyof typeof FlaginatorSourceKinds];

export type FlaginatorSourceDependency = {
  kind: FlaginatorSourceKind;
  name: string;
};

export type FlaginatorFlagDependency<TFlag extends string = string> = {
  kind: "flag";
  name: TFlag;
};

export type FlaginatorDependency<TFlag extends string = string> =
  | FlaginatorSourceDependency
  | FlaginatorFlagDependency<TFlag>;

export type FlaginatorFlagMeta = {
  value: boolean;
  computedAgainstVersion: number;
  lastComputedVersion: number;
  lastComputedTick: number;
  lastChangedVersion: number;
  lastChangedTick: number;
};

export type FlaginatorEvaluationContext<
  TWorld,
  TFlag extends string = string,
> = {
  world: TWorld;
  eid: number;
  flag: TFlag;
  tick: number;
  evaluateFlag: (flag: TFlag, eid?: number) => boolean;
  getFlagMeta: (flag: TFlag, eid?: number) => FlaginatorFlagMeta;
  getSourceVersion: (source: FlaginatorSourceDependency, eid?: number) => number;
};

export type FlaginatorFlagDefinition<
  TWorld,
  TFlag extends string = string,
> = {
  dependencies?: readonly FlaginatorDependency<TFlag>[];
  evaluate: (context: FlaginatorEvaluationContext<TWorld, TFlag>) => boolean;
};

export type FlaginatorSourceState = {
  descriptor: FlaginatorSourceDependency;
  versions: Uint32Array;
  lastChangedTick: Uint32Array;
};

export type FlaginatorFlagStore<
  TWorld,
  TFlag extends string = string,
> = {
  name: TFlag;
  definition: FlaginatorFlagDefinition<TWorld, TFlag>;
  values: Int8Array;
  computedAgainstVersion: Uint32Array;
  lastComputedVersion: Uint32Array;
  lastComputedTick: Uint32Array;
  lastChangedVersion: Uint32Array;
  lastChangedTick: Uint32Array;
  entityEpoch: Uint32Array;
};

export type FlaginatorState<
  TWorld,
  TFlag extends string = string,
> = {
  maxEntities: number;
  tick: number;
  changeVersion: number;
  computeVersion: number;
  entityEpoch: Uint32Array;
  flags: Map<TFlag, FlaginatorFlagStore<TWorld, TFlag>>;
  sources: Map<string, FlaginatorSourceState>;
  evaluationStack: string[];
};

export type FlaginatorWorld<TWorld, TFlag extends string> = TWorld & {
  flaginator: FlaginatorState<TWorld, TFlag>;
};

export type FlaginatorBatchResult<TFlag extends string> = {
  eids: ArrayLike<number>;
  flags: readonly TFlag[];
  totalEvaluations: number;
};

function nextChangeVersion<TWorld, TFlag extends string>(
  state: FlaginatorState<TWorld, TFlag>,
) {
  state.changeVersion += 1;
  return state.changeVersion;
}

function nextComputeVersion<TWorld, TFlag extends string>(
  state: FlaginatorState<TWorld, TFlag>,
) {
  state.computeVersion += 1;
  return state.computeVersion;
}

function getSourceKey(source: FlaginatorSourceDependency) {
  return `${source.kind}:${source.name}`;
}

function ensureSourceState<TWorld, TFlag extends string>(
  state: FlaginatorState<TWorld, TFlag>,
  source: FlaginatorSourceDependency,
) {
  const key = getSourceKey(source);
  const existing = state.sources.get(key);
  if (existing) {
    return existing;
  }

  const next: FlaginatorSourceState = {
    descriptor: source,
    versions: new Uint32Array(state.maxEntities),
    lastChangedTick: new Uint32Array(state.maxEntities),
  };
  state.sources.set(key, next);
  return next;
}

function getSourceState<TWorld, TFlag extends string>(
  state: FlaginatorState<TWorld, TFlag>,
  source: FlaginatorSourceDependency,
) {
  return state.sources.get(getSourceKey(source));
}

function assertFlagStore<TWorld, TFlag extends string>(
  state: FlaginatorState<TWorld, TFlag>,
  flag: TFlag,
) {
  const store = state.flags.get(flag);
  if (!store) {
    throw new Error(`Flaginator flag "${flag}" has not been registered.`);
  }
  return store;
}

function clearFlagStoreForEntity<TWorld, TFlag extends string>(
  store: FlaginatorFlagStore<TWorld, TFlag>,
  eid: number,
  entityEpoch: number,
) {
  store.values[eid] = 0;
  store.computedAgainstVersion[eid] = 0;
  store.lastComputedVersion[eid] = 0;
  store.lastComputedTick[eid] = 0;
  store.lastChangedVersion[eid] = 0;
  store.lastChangedTick[eid] = 0;
  store.entityEpoch[eid] = entityEpoch;
}

function syncEntityEpoch<TWorld, TFlag extends string>(
  state: FlaginatorState<TWorld, TFlag>,
  store: FlaginatorFlagStore<TWorld, TFlag>,
  eid: number,
) {
  const entityEpoch = state.entityEpoch[eid] || 1;
  if (store.entityEpoch[eid] === entityEpoch) {
    return;
  }

  clearFlagStoreForEntity(store, eid, entityEpoch);
}

function readSourceVersion<TWorld, TFlag extends string>(
  state: FlaginatorState<TWorld, TFlag>,
  source: FlaginatorSourceDependency,
  eid: number,
) {
  const sourceState = getSourceState(state, source);
  return sourceState?.versions[eid] ?? 0;
}

function resolveDependencyVersion<TWorld, TFlag extends string>(
  world: FlaginatorWorld<TWorld, TFlag>,
  dependencies: readonly FlaginatorDependency<TFlag>[] | undefined,
  eid: number,
) {
  if (!dependencies || dependencies.length === 0) {
    return 0;
  }

  let maxVersion = 0;
  for (let i = 0; i < dependencies.length; i += 1) {
    const dependency = dependencies[i]!;
    if (dependency.kind === "flag") {
      evaluateFlaginatorFlag(world, dependency.name, eid);
      const store = assertFlagStore(world.flaginator, dependency.name);
      maxVersion = Math.max(maxVersion, store.lastChangedVersion[eid] ?? 0);
      continue;
    }

    maxVersion = Math.max(
      maxVersion,
      readSourceVersion(world.flaginator, dependency, eid),
    );
  }

  return maxVersion;
}

function readFlagMeta<TWorld, TFlag extends string>(
  state: FlaginatorState<TWorld, TFlag>,
  store: FlaginatorFlagStore<TWorld, TFlag>,
  eid: number,
): FlaginatorFlagMeta {
  syncEntityEpoch(state, store, eid);

  return {
    value: store.values[eid] === 1,
    computedAgainstVersion: store.computedAgainstVersion[eid] ?? 0,
    lastComputedVersion: store.lastComputedVersion[eid] ?? 0,
    lastComputedTick: store.lastComputedTick[eid] ?? 0,
    lastChangedVersion: store.lastChangedVersion[eid] ?? 0,
    lastChangedTick: store.lastChangedTick[eid] ?? 0,
  };
}

export function flagComponentDependency(
  name: string,
): FlaginatorSourceDependency {
  return {
    kind: FlaginatorSourceKinds.Component,
    name,
  };
}

export function flagMarkerDependency(name: string): FlaginatorSourceDependency {
  return {
    kind: FlaginatorSourceKinds.Marker,
    name,
  };
}

export function flagCustomDependency(name: string): FlaginatorSourceDependency {
  return {
    kind: FlaginatorSourceKinds.Custom,
    name,
  };
}

export function flagDependency<TFlag extends string>(
  name: TFlag,
): FlaginatorFlagDependency<TFlag> {
  return {
    kind: "flag",
    name,
  };
}

export function createFlaginator<TWorld, TFlag extends string = string>(
  maxEntities: number,
): FlaginatorState<TWorld, TFlag> {
  return {
    maxEntities,
    tick: 0,
    changeVersion: 0,
    computeVersion: 0,
    entityEpoch: new Uint32Array(maxEntities),
    flags: new Map(),
    sources: new Map(),
    evaluationStack: [],
  };
}

export function registerFlaginatorFlag<TWorld, TFlag extends string>(
  world: FlaginatorWorld<TWorld, TFlag>,
  name: TFlag,
  definition: FlaginatorFlagDefinition<TWorld, TFlag>,
) {
  if (world.flaginator.flags.has(name)) {
    throw new Error(`Flaginator flag "${name}" has already been registered.`);
  }

  const state = world.flaginator;
  const entityEpoch = new Uint32Array(state.maxEntities);
  const store: FlaginatorFlagStore<TWorld, TFlag> = {
    name,
    definition,
    values: new Int8Array(state.maxEntities),
    computedAgainstVersion: new Uint32Array(state.maxEntities),
    lastComputedVersion: new Uint32Array(state.maxEntities),
    lastComputedTick: new Uint32Array(state.maxEntities),
    lastChangedVersion: new Uint32Array(state.maxEntities),
    lastChangedTick: new Uint32Array(state.maxEntities),
    entityEpoch,
  };

  state.flags.set(name, store);
  return store;
}

export function getFlaginatorFlagStore<TWorld, TFlag extends string>(
  world: FlaginatorWorld<TWorld, TFlag>,
  flag: TFlag,
) {
  return assertFlagStore(world.flaginator, flag);
}

export function markFlaginatorSourceChanged<TWorld, TFlag extends string>(
  world: FlaginatorWorld<TWorld, TFlag>,
  source: FlaginatorSourceDependency,
  eid: number,
) {
  const state = world.flaginator;
  const sourceState = ensureSourceState(state, source);
  const version = nextChangeVersion(state);
  sourceState.versions[eid] = version;
  sourceState.lastChangedTick[eid] = state.tick;
  return version;
}

export function markFlaginatorComponentChanged<TWorld, TFlag extends string>(
  world: FlaginatorWorld<TWorld, TFlag>,
  componentName: string,
  eid: number,
) {
  return markFlaginatorSourceChanged(
    world,
    flagComponentDependency(componentName),
    eid,
  );
}

export function markFlaginatorMarkerChanged<TWorld, TFlag extends string>(
  world: FlaginatorWorld<TWorld, TFlag>,
  markerName: string,
  eid: number,
) {
  return markFlaginatorSourceChanged(world, flagMarkerDependency(markerName), eid);
}

export function markFlaginatorCustomSourceChanged<
  TWorld,
  TFlag extends string,
>(
  world: FlaginatorWorld<TWorld, TFlag>,
  sourceName: string,
  eid: number,
) {
  return markFlaginatorSourceChanged(world, flagCustomDependency(sourceName), eid);
}

export function resetFlaginatorEntity<TWorld, TFlag extends string>(
  world: FlaginatorWorld<TWorld, TFlag>,
  eid: number,
) {
  const state = world.flaginator;
  const nextEpoch = (state.entityEpoch[eid] ?? 0) + 1;
  state.entityEpoch[eid] = nextEpoch;

  for (const store of state.flags.values()) {
    clearFlagStoreForEntity(store, eid, nextEpoch);
  }
}

export function advanceFlaginatorTick<TWorld, TFlag extends string>(
  world: FlaginatorWorld<TWorld, TFlag>,
) {
  world.flaginator.tick += 1;
  return world.flaginator.tick;
}

export function flaginatorSystem<TWorld, TFlag extends string>(
  world: FlaginatorWorld<TWorld, TFlag>,
) {
  advanceFlaginatorTick(world);
}

export function evaluateFlaginatorFlag<TWorld, TFlag extends string>(
  world: FlaginatorWorld<TWorld, TFlag>,
  flag: TFlag,
  eid: number,
) {
  const state = world.flaginator;
  if (!entityExists(world, eid)) {
    return false;
  }

  const store = assertFlagStore(state, flag);
  syncEntityEpoch(state, store, eid);

  const cycleKey = `${flag}:${eid}`;
  const cycleIndex = state.evaluationStack.indexOf(cycleKey);
  if (cycleIndex >= 0) {
    const cyclePath = state.evaluationStack.slice(cycleIndex).concat(cycleKey);
    throw new Error(
      `Flaginator dependency cycle detected: ${cyclePath.join(" -> ")}`,
    );
  }

  state.evaluationStack.push(cycleKey);

  try {
    const dependencyVersion = resolveDependencyVersion(
      world,
      store.definition.dependencies,
      eid,
    );
    if (
      store.lastComputedVersion[eid] !== 0 &&
      store.computedAgainstVersion[eid] === dependencyVersion
    ) {
      return store.values[eid] === 1;
    }

    const hadCachedValue = store.lastComputedVersion[eid] !== 0;
    const previousValue = store.values[eid];
    const nextValue = store.definition.evaluate({
      world,
      eid,
      flag,
      tick: state.tick,
      evaluateFlag(nextFlag, nextEid = eid) {
        return evaluateFlaginatorFlag(world, nextFlag, nextEid);
      },
      getFlagMeta(nextFlag, nextEid = eid) {
        return getFlaginatorFlagMeta(world, nextFlag, nextEid);
      },
      getSourceVersion(source, nextEid = eid) {
        return readSourceVersion(state, source, nextEid);
      },
    });
    const normalizedValue = nextValue ? 1 : 0;

    store.computedAgainstVersion[eid] = dependencyVersion;
    store.lastComputedVersion[eid] = nextComputeVersion(state);
    store.lastComputedTick[eid] = state.tick;

    if (!hadCachedValue || previousValue !== normalizedValue) {
      store.values[eid] = normalizedValue;
      store.lastChangedVersion[eid] = nextChangeVersion(state);
      store.lastChangedTick[eid] = state.tick;
    } else {
      store.values[eid] = normalizedValue;
    }

    return normalizedValue === 1;
  } finally {
    state.evaluationStack.pop();
  }
}

export function getFlaginatorFlagMeta<TWorld, TFlag extends string>(
  world: FlaginatorWorld<TWorld, TFlag>,
  flag: TFlag,
  eid: number,
) {
  if (entityExists(world, eid)) {
    evaluateFlaginatorFlag(world, flag, eid);
  }

  const store = assertFlagStore(world.flaginator, flag);
  return readFlagMeta(world.flaginator, store, eid);
}

export function evaluateAllFlaginatorFlags<TWorld, TFlag extends string>(
  world: FlaginatorWorld<TWorld, TFlag>,
  opts: {
    eids?: ArrayLike<number>;
    flags?: readonly TFlag[];
  } = {},
): FlaginatorBatchResult<TFlag> {
  const eids = opts.eids ?? getAllEntities(world);
  const flags = opts.flags ?? Array.from(world.flaginator.flags.keys());
  let totalEvaluations = 0;

  for (let i = 0; i < eids.length; i += 1) {
    const eid = eids[i]!;
    for (let j = 0; j < flags.length; j += 1) {
      evaluateFlaginatorFlag(world, flags[j]!, eid);
      totalEvaluations += 1;
    }
  }

  return {
    eids,
    flags,
    totalEvaluations,
  };
}
