import { createWorld, hasComponent } from "bitecs";
import { createChronoTrigger } from "../util/chronoTrigger";
import { createChillUpdater } from "../util/chillUpdate";
import { createRingBuffer } from "../util/ringBuffer";
import { CoreFlagCustomSources, CoreFlags } from "./coreFlags";
import {
  destroyEntity,
  hasEntityComponents,
  queryEntities,
  setEntityPosition,
  setEntityRotation,
  setEntityVelocity,
  spawnEntity,
} from "./entities";
import {
  adjustCameraFollowOrbit,
  cameraFollowSystem,
  resetCameraTarget,
  setCameraFollowOrbitControlActive,
  setCameraFollowTarget,
  setCameraLookAtTarget,
} from "./systems/cameraFollow";
import {
  collisionSystem,
  createCollisionState,
  setupCollisionSystem,
} from "./systems/collision";
import { commandsSystem, createCoreCommands } from "./systems/commands";
import {
  controlsSystem,
  createControls,
  setupControlInputs,
} from "./systems/controls";
import { dirtyTransformsSystem } from "./systems/dirtyTransforms";
import { fallCleanupSystem } from "./systems/entityCleanup";
import { experienceSystem } from "./systems/experience";
import {
  createFlaginator,
  flagComponentDependency,
  flagCustomDependency,
  flagDependency,
  flagMarkerDependency,
  flaginatorSystem,
  registerFlaginatorFlag,
} from "./systems/flaginator";
import { gravitySystem } from "./systems/gravity";
import { healthSystem } from "./systems/health";
import { movementSystem } from "./systems/movement";
import { disposeRenderer, renderSystem, setupRenderer } from "./systems/render";
import { timeSystem } from "./systems/time";
import { uiBridgeSystem } from "./systems/uiBridge";
import type {
  CoreWorld,
  CoreWorldBox,
  Player,
  SetupCoreWorldOptions,
} from "./types";

export type {
  BounceSuggestionState,
  CoreColliderConfig,
  CollisionDirtyFlags,
  CollisionState,
  ColliderShapes,
  CoreComponentName,
  ControlEvent,
  ControlEventFilter,
  ControlEventHandler,
  ControlEventInput,
  ControlFilter,
  ControlMatch,
  ControlPhase,
  ControlSourceId,
  ControlState,
  ControlTick,
  ControlTickHandler,
  CoreCommand,
  CoreCommandHandler,
  CoreCommandInput,
  CoreCommands,
  CoreControls,
  CoreEntityBlueprint,
  CoreWorld,
  CoreWorldBox,
  GravityState,
  KeyboardControlId,
  Player,
  Players,
  PointerControlId,
  Position,
  Positions,
  Rotation,
  Time,
  TouchPairList,
  Vec3,
  Velocities,
  Velocity,
  SetupCoreWorldOptions,
} from "./types";
export type { CoreFlagCustomSourceName, CoreFlagName } from "./coreFlags";
export type {
  FlaginatorBatchResult,
  FlaginatorDependency,
  FlaginatorEvaluationContext,
  FlaginatorFlagDefinition,
  FlaginatorFlagMeta,
  FlaginatorFlagStore,
  FlaginatorSourceDependency,
  FlaginatorSourceKind,
  FlaginatorSourceState,
  FlaginatorState,
  FlaginatorWorld,
} from "./systems/flaginator";
export { CoreFlagCustomSources, CoreFlags } from "./coreFlags";
export { ControlSources, KeyboardControls, PointerControls } from "./types";
export {
  configureCuboidCollider,
  getBounceSuggestion,
  getTouchPairs,
  getTouchingEntities,
  markCollisionTransformDirty,
} from "./systems/collision";
export {
  destroyEntity,
  hasEntityComponents,
  queryEntities,
  spawnEntity,
} from "./entities";
export {
  getYawFromXZDirection,
  markTransformDirty,
  setEntityPosition,
  rotateLocalVectorByEntityRotation,
  setEntityRotation,
  setEntityVelocity,
} from "./systems/transforms";
export {
  advanceFlaginatorTick,
  evaluateAllFlaginatorFlags,
  evaluateFlaginatorFlag,
  flagComponentDependency,
  flagCustomDependency,
  flagDependency,
  flagMarkerDependency,
  getFlaginatorFlagMeta,
  getFlaginatorFlagStore,
  markFlaginatorComponentChanged,
  markFlaginatorCustomSourceChanged,
  markFlaginatorMarkerChanged,
  markFlaginatorSourceChanged,
  registerFlaginatorFlag,
  resetFlaginatorEntity,
} from "./systems/flaginator";

type CoreSystem = (world: CoreWorld) => void;

const WORLD_SYSTEMS = [
  timeSystem,
  flaginatorSystem,
  controlsSystem,
  commandsSystem,
  gravitySystem,
  movementSystem,
  collisionSystem,
  fallCleanupSystem,
  experienceSystem,
  healthSystem,
] as const satisfies readonly CoreSystem[];

const RENDER_SYSTEMS = [
  cameraFollowSystem,
  renderSystem,
] as const satisfies readonly CoreSystem[];

function runSystems(world: CoreWorld, systems: readonly CoreSystem[]) {
  for (const system of systems) {
    system(world);
  }
}

function registerCoreFlags(world: CoreWorld) {
  registerFlaginatorFlag(world, CoreFlags.OnGround, {
    dependencies: [flagComponentDependency("Gravity")],
    evaluate: ({ world: activeWorld, eid }) => {
      const { Gravity } = activeWorld.components;
      return (
        hasComponent(activeWorld, eid, Gravity) && Gravity.Grounded[eid] === 1
      );
    },
  });

  registerFlaginatorFlag(world, CoreFlags.InAir, {
    dependencies: [
      flagComponentDependency("Gravity"),
      flagDependency(CoreFlags.OnGround),
    ],
    evaluate: ({ world: activeWorld, eid, evaluateFlag }) => {
      return (
        hasComponent(activeWorld, eid, activeWorld.components.Gravity) &&
        !evaluateFlag(CoreFlags.OnGround)
      );
    },
  });

  registerFlaginatorFlag(world, CoreFlags.Dead, {
    dependencies: [
      flagComponentDependency("Health"),
      flagMarkerDependency("HealthChanged"),
    ],
    evaluate: ({ world: activeWorld, eid }) => {
      const { Health } = activeWorld.components;
      return hasComponent(activeWorld, eid, Health) && Health[eid] <= 0;
    },
  });

  registerFlaginatorFlag(world, CoreFlags.TouchingNonFloor, {
    dependencies: [
      flagComponentDependency("Floor"),
      flagCustomDependency(CoreFlagCustomSources.Touching),
    ],
    evaluate: ({ world: activeWorld, eid }) => {
      const { Floor } = activeWorld.components;
      if (hasComponent(activeWorld, eid, Floor) && Floor[eid] === 1) {
        return false;
      }

      const touching = activeWorld.collision.touchingByEid[eid] ?? [];
      for (let i = 0; i < touching.length; i += 1) {
        if (!activeWorld.components.Floor[touching[i]!]) {
          return true;
        }
      }

      return false;
    },
  });
}

function createCoreWorldConfig(maxEntities: number): CoreWorld {
  return {
    components: {
      Position: {
        x: new Float32Array(maxEntities),
        y: new Float32Array(maxEntities),
        z: new Float32Array(maxEntities),
      },
      Velocity: {
        x: new Float32Array(maxEntities),
        y: new Float32Array(maxEntities),
        z: new Float32Array(maxEntities),
      },
      Rotation: {
        yaw: new Float32Array(maxEntities),
        pitch: new Float32Array(maxEntities),
        roll: new Float32Array(maxEntities),
      },
      FaceVelocity: new Int8Array(maxEntities),
      Collider: {
        Active: new Int8Array(maxEntities),
        Sensor: new Int8Array(maxEntities),
        HalfWidth: new Float32Array(maxEntities),
        HalfHeight: new Float32Array(maxEntities),
        HalfDepth: new Float32Array(maxEntities),
      },
      Gravity: {
        Grounded: new Int8Array(maxEntities),
      },
      Floor: new Int8Array(maxEntities),
      RenderDirtyFlags: {
        // Tracks render updates without duplicating entity ids in the dirty list.
        DirtyTransformFlag: new Int8Array(maxEntities),
        DirtyCount: 0,
        DirtyList: new Int32Array(maxEntities),
        DirtyFlagSet: new Int8Array(maxEntities),
      },
      CollisionDirtyFlags: {
        // Tracks collider updates separately from render changes.
        DirtyTransformFlag: new Int8Array(maxEntities),
        ConfigDirtyFlag: new Int8Array(maxEntities),
        DirtyCount: 0,
        DirtyList: new Int32Array(maxEntities),
        DirtyFlagSet: new Int8Array(maxEntities),
      },
      Render: new Int32Array(maxEntities),
      Health: new Int32Array(maxEntities),
      Player: [] as Player[],
    },
    collision: createCollisionState(maxEntities),
    time: {
      delta: 0,
      elapsed: 0,
      then: performance.now(),
      deltaBuffer: createRingBuffer(300),
      avgDelta: 0,
      ticksPerSecond: 0,
    },
    commands: createCoreCommands<CoreWorld>(),
    controls: createControls<CoreWorld>(),
    chillUpdater: createChillUpdater(),
    flaginator: createFlaginator<CoreWorld>(maxEntities),
  };
}

function normalizeSetupCoreWorldOptions(
  canvasOrOptions:
    | HTMLCanvasElement
    | null
    | SetupCoreWorldOptions
    | undefined,
  legacyMaxEntities: number,
): Required<SetupCoreWorldOptions> {
  if (isSetupCoreWorldOptions(canvasOrOptions)) {
    return {
      canvas: canvasOrOptions.canvas ?? null,
      maxEntities: canvasOrOptions.maxEntities ?? legacyMaxEntities,
      autoStart: canvasOrOptions.autoStart ?? false,
      worldTickRate: canvasOrOptions.worldTickRate ?? 60,
    };
  }

  if (
    canvasOrOptions === null ||
    canvasOrOptions === undefined ||
    (typeof HTMLCanvasElement !== "undefined" &&
      canvasOrOptions instanceof HTMLCanvasElement)
  ) {
    return {
      canvas: canvasOrOptions ?? null,
      maxEntities: legacyMaxEntities,
      autoStart: false,
      worldTickRate: 60,
    };
  }

  return {
    canvas: null,
    maxEntities: legacyMaxEntities,
    autoStart: false,
    worldTickRate: 60,
  };
}

function isSetupCoreWorldOptions(
  value: HTMLCanvasElement | null | SetupCoreWorldOptions | undefined,
): value is SetupCoreWorldOptions {
  if (value === null || value === undefined) return false;
  if (
    typeof HTMLCanvasElement !== "undefined" &&
    value instanceof HTMLCanvasElement
  ) {
    return false;
  }

  return true;
}

function setupCoreWorld(
  canvasOrOptions: HTMLCanvasElement | null | SetupCoreWorldOptions = null,
  legacyMaxEntities = 100000,
) {
  const options = normalizeSetupCoreWorldOptions(
    canvasOrOptions,
    legacyMaxEntities,
  );
  let runGameLoop = false;
  let disposed = false;
  const scheduler = createChronoTrigger();
  let worldTaskId: number | null = null;
  let renderTaskId: number | null = null;

  const world = createWorld<CoreWorld>(
    createCoreWorldConfig(options.maxEntities),
  );
  registerCoreFlags(world);
  const controlInputs = setupControlInputs(world, options.canvas);

  function worldTick(activeWorld: CoreWorld) {
    runSystems(activeWorld, WORLD_SYSTEMS);
    if (activeWorld.components.RenderDirtyFlags.DirtyCount > 0) {
      dirtyTransformsSystem(activeWorld);
    }
    uiBridgeSystem(activeWorld);
  }

  function renderTick(activeWorld: CoreWorld) {
    runSystems(activeWorld, RENDER_SYSTEMS);
  }

  function ensureSchedulerTasks() {
    if (worldTaskId !== null && renderTaskId !== null) return;

    worldTaskId = scheduler.runAt({
      name: "worldTick",
      fpsTarget: options.worldTickRate,
      callback: () => {
        if (!runGameLoop) return;
        worldTick(world);
      },
    });
    renderTaskId = scheduler.runAt({
      name: "renderSystem",
      callback: () => {
        if (!runGameLoop) return;
        renderTick(world);
      },
    });
  }

  function start() {
    if (disposed || runGameLoop) return;
    runGameLoop = true;
    ensureSchedulerTasks();
    scheduler.Start();
  }

  function stop() {
    runGameLoop = false;
    scheduler.Stop();
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stop();
    if (worldTaskId !== null) {
      scheduler.dispose(worldTaskId);
      worldTaskId = null;
    }
    if (renderTaskId !== null) {
      scheduler.dispose(renderTaskId);
      renderTaskId = null;
    }
    controlInputs.disconnect();
    world.commands.clear();
    world.controls.clear();
    disposeRenderer();
    resetCameraTarget();
  }

  setupRenderer(options.canvas);
  setupCollisionSystem(world);
  resetCameraTarget();

  const worldBox: CoreWorldBox = {
    world,
    start,
    stop,
    dispose,
    isRunning: () => runGameLoop,
    spawnEntity: (definition) => spawnEntity(world, definition),
    destroyEntity: (eid) => {
      destroyEntity(world, eid);
    },
    queryEntities: (componentNames) => queryEntities(world, componentNames),
    hasEntityComponents: (eid, componentNames) => {
      return hasEntityComponents(world, eid, componentNames);
    },
    setEntityPosition: (eid, position) => setEntityPosition(world, eid, position),
    setEntityVelocity: (eid, velocity) => setEntityVelocity(world, eid, velocity),
    setCameraFollowTarget,
    adjustCameraFollowOrbit,
    setCameraFollowOrbitControlActive,
    setCameraLookAtTarget,
    setEntityRotation: (eid, rotation) => setEntityRotation(world, eid, rotation),
    resetCameraTarget,
  };

  if (options.autoStart) {
    start();
  }

  return worldBox;
}

export { setupCoreWorld };
