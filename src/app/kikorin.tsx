import {
  CoreFlags,
  ControlSources,
  evaluateFlaginatorFlag,
  hasEntityComponents,
  KeyboardControls,
  markFlaginatorComponentChanged,
  queryEntities,
  rotateLocalVectorByEntityRotation,
  setEntityRotation,
  setupCoreWorld,
  spawnEntity,
  type CoreWorld,
  type CoreWorldBox,
  type Player,
  type Position,
  type Rotation,
  type Velocity,
} from "@/packages/core/core";
import { findHighestFloorTopAtPosition } from "@/packages/core/systems/gravity";
import { clamp, rng } from "@/packages/util/random";
import {
  BoxGeometry,
  EdgesGeometry,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
} from "three";
import { PlayerReactControls } from "./kikorinControls";

const PERSON_COLLIDER = {
  halfWidth: 0.5,
  halfHeight: 0.5,
  halfDepth: 0.5,
};
const PERSON_GEOMETRY = new BoxGeometry(
  PERSON_COLLIDER.halfWidth * 2,
  PERSON_COLLIDER.halfHeight * 2,
  PERSON_COLLIDER.halfDepth * 2,
);
const PERSON_EDGE_GEOMETRY = new EdgesGeometry(PERSON_GEOMETRY);
const PERSON_BODY_COLOR = 0x66ccff;
const PERSON_FRONT_COLOR = 0xffe082;
const PERSON_TOUCH_COLOR = 0xff6b3d;
const PERSON_TOUCH_FRONT_COLOR = 0xffc46b;
const PERSON_EDGE_MATERIAL = new LineBasicMaterial({ color: 0x16324f });
const FLOOR_COLLIDER = {
  halfWidth: 240,
  halfHeight: 1,
  halfDepth: 240,
};
const FLOOR_TOP_Y = 0;
const FLOOR_GEOMETRY = new BoxGeometry(
  FLOOR_COLLIDER.halfWidth * 2,
  FLOOR_COLLIDER.halfHeight * 2,
  FLOOR_COLLIDER.halfDepth * 2,
);
const FLOOR_EDGE_GEOMETRY = new EdgesGeometry(FLOOR_GEOMETRY);
const FLOOR_BASE_MATERIAL = new MeshBasicMaterial({ color: 0x445342 });
const FLOOR_EDGE_MATERIAL = new LineBasicMaterial({ color: 0x243022 });
const FLOOR_POSITION = {
  x: 0,
  y: FLOOR_TOP_Y - FLOOR_COLLIDER.halfHeight,
  z: 0,
};
const PLAYER_ACCELERATION = 30;
const PLAYER_MAX_SPEED = 18;
const PLAYER_DRAG_PER_SECOND = 4;
const PLAYER_JUMP_SPEED = 8;
const PLAYER_FORWARD_BOOST = 10;
const PLAYER_FORWARD_KEYS = [
  KeyboardControls.KeyW,
  KeyboardControls.ArrowUp,
];
const PLAYER_BACKWARD_KEYS = [
  KeyboardControls.KeyS,
  KeyboardControls.ArrowDown,
];
const PLAYER_STRAFE_LEFT_KEYS = [KeyboardControls.KeyQ];
const PLAYER_STRAFE_RIGHT_KEYS = [KeyboardControls.KeyE];
const PLAYER_LOOK_LEFT_KEYS = [
  KeyboardControls.KeyA,
  KeyboardControls.ArrowLeft,
];
const PLAYER_LOOK_RIGHT_KEYS = [
  KeyboardControls.KeyD,
  KeyboardControls.ArrowRight,
];
const PLAYER_PITCH_UP_KEYS = [KeyboardControls.KeyI];
const PLAYER_PITCH_DOWN_KEYS = [KeyboardControls.KeyK];
const PLAYER_PITCH_SPEED = 1.5;
const PLAYER_YAW_SPEED = 1.5;
const PLAYER_MAX_PITCH = Math.PI * 0.45;
const AMBIENT_PERSON_COUNT = 8000;

function createPersonFaceMaterials(bodyColor: number, frontColor: number) {
  return [
    ...Array.from({ length: 5 }, () => {
      return new MeshBasicMaterial({ color: bodyColor });
    }),
    // BoxGeometry groups are +X, -X, +Y, -Y, +Z, -Z. This project treats -Z as forward.
    new MeshBasicMaterial({ color: frontColor }),
  ];
}

const PERSON_BASE_MATERIALS = createPersonFaceMaterials(
  PERSON_BODY_COLOR,
  PERSON_FRONT_COLOR,
);
const PERSON_TOUCH_MATERIALS = createPersonFaceMaterials(
  PERSON_TOUCH_COLOR,
  PERSON_TOUCH_FRONT_COLOR,
);

export type World = CoreWorld;
export type WorldBox = CoreWorldBox;

type FloorEids = ArrayLike<number>;

function createPersonRenderMesh() {
  const mesh = new Mesh(PERSON_GEOMETRY, PERSON_BASE_MATERIALS);
  const outline = new LineSegments(PERSON_EDGE_GEOMETRY, PERSON_EDGE_MATERIAL);
  outline.renderOrder = 1;
  outline.scale.setScalar(1.001);
  mesh.userData.baseMaterial = PERSON_BASE_MATERIALS;
  mesh.userData.touchMaterial = PERSON_TOUCH_MATERIALS;
  mesh.add(outline);
  return mesh;
}

function createFloorRenderMesh() {
  const mesh = new Mesh(FLOOR_GEOMETRY, FLOOR_BASE_MATERIAL);
  const outline = new LineSegments(FLOOR_EDGE_GEOMETRY, FLOOR_EDGE_MATERIAL);
  outline.renderOrder = 1;
  outline.scale.setScalar(1.0005);
  mesh.add(outline);
  return mesh;
}

function setupWorld(canvas: HTMLCanvasElement | null) {
  const worldBox: WorldBox = setupCoreWorld({
    canvas,
    autoStart: true,
  });
  createFloor(worldBox.world, FLOOR_POSITION);

  const floorEids = queryFloorEids(worldBox.world);
  const prime = createPrimePlayer(worldBox.world, floorEids);
  registerPrimeControls(worldBox.world, prime);
  worldBox.setCameraFollowTarget(prime);
  spawnAmbientPeople(worldBox.world, floorEids);

  return worldBox;
}

function queryFloorEids(world: World): FloorEids {
  return queryEntities(world, ["Floor", "Position", "Rotation", "Collider"]);
}

function createPrimePlayer(world: CoreWorld, floorEids: FloorEids) {
  return createPerson(
    world,
    { x: 0, y: 12, z: 0 },
    { x: 0, y: 0, z: 0 },
    100,
    { level: 0, experience: 0, name: "DoomPrime" },
    floorEids,
  );
}

function spawnAmbientPeople(
  world: CoreWorld,
  floorEids: FloorEids,
  count = AMBIENT_PERSON_COUNT,
) {
  const spawnRangeX = FLOOR_COLLIDER.halfWidth - 4;
  const spawnRangeZ = FLOOR_COLLIDER.halfDepth - 4;

  for (let i = 0; i < count; i += 1) {
    const moving = rng(0, 10) > 9; // 10% chance to be moving
    const velocity = {
      x: moving ? rng(-10, 10, 2) : 0,
      y: 0,
      z: moving ? rng(-10, 10, 2) : 0,
    };
    const position = {
      x: rng(-spawnRangeX, spawnRangeX),
      y: rng(FLOOR_TOP_Y + 4, FLOOR_TOP_Y + 60),
      z: rng(-spawnRangeZ, spawnRangeZ),
    };

    createPerson(
      world,
      position,
      velocity,
      100,
      {
        level: 0,
        experience: 0,
        name: `Doom${i}`,
      },
      floorEids,
    );
  }
}

function registerPrimeControls(world: CoreWorld, eid: number) {
  const isControllingPrime = (activeWorld: CoreWorld) => {
    return (
      hasEntityComponents(activeWorld, eid, [
        "Player",
        "Velocity",
        "Rotation",
        "Gravity",
      ]) && activeWorld.components.Player[eid]?.name === "DoomPrime"
    );
  };

  const jump = (activeWorld: CoreWorld) => {
    if (!isControllingPrime(activeWorld)) return;

    const { Gravity, Velocity } = activeWorld.components;
    if (!evaluateFlaginatorFlag(activeWorld, CoreFlags.OnGround, eid)) return;

    Velocity.y[eid] = clamp(
      PLAYER_JUMP_SPEED,
      -PLAYER_MAX_SPEED,
      PLAYER_MAX_SPEED,
    );
    Gravity.Grounded[eid] = 0;
    markFlaginatorComponentChanged(activeWorld, "Velocity", eid);
    markFlaginatorComponentChanged(activeWorld, "Gravity", eid);
  };

  world.controls.onTick((activeWorld, tick, controls) => {
    if (!isControllingPrime(activeWorld)) return;

    const dt = tick.deltaSeconds;
    if (dt === 0) return;

    const drag = Math.max(0, 1 - PLAYER_DRAG_PER_SECOND * dt);
    const { Velocity, Rotation } = activeWorld.components;
    const previousVelocityX = Velocity.x[eid];
    const previousVelocityY = Velocity.y[eid];
    const previousVelocityZ = Velocity.z[eid];
    Velocity.x[eid] *= drag;
    Velocity.z[eid] *= drag;

    const localAcceleration = {
      x:
        controls.getAxis(
          PLAYER_STRAFE_LEFT_KEYS,
          PLAYER_STRAFE_RIGHT_KEYS,
          ControlSources.Keyboard,
        ) * PLAYER_ACCELERATION,
      y: 0,
      z:
        controls.getAxis(
          PLAYER_FORWARD_KEYS,
          PLAYER_BACKWARD_KEYS,
          ControlSources.Keyboard,
        ) * PLAYER_ACCELERATION,
    };
    const pitchAxis = controls.getAxis(
      PLAYER_PITCH_DOWN_KEYS,
      PLAYER_PITCH_UP_KEYS,
      ControlSources.Keyboard,
    );
    const yawAxis = controls.getAxis(
      PLAYER_LOOK_RIGHT_KEYS,
      PLAYER_LOOK_LEFT_KEYS,
      ControlSources.Keyboard,
    );
    const worldAcceleration = rotateLocalVectorByEntityRotation(
      activeWorld,
      eid,
      localAcceleration,
    );

    Velocity.x[eid] = clamp(
      Velocity.x[eid] + worldAcceleration.x * dt,
      -PLAYER_MAX_SPEED,
      PLAYER_MAX_SPEED,
    );
    Velocity.y[eid] = clamp(
      Velocity.y[eid] + worldAcceleration.y * dt,
      -PLAYER_MAX_SPEED,
      PLAYER_MAX_SPEED,
    );
    Velocity.z[eid] = clamp(
      Velocity.z[eid] + worldAcceleration.z * dt,
      -PLAYER_MAX_SPEED,
      PLAYER_MAX_SPEED,
    );

    if (
      Velocity.x[eid] !== previousVelocityX ||
      Velocity.y[eid] !== previousVelocityY ||
      Velocity.z[eid] !== previousVelocityZ
    ) {
      markFlaginatorComponentChanged(activeWorld, "Velocity", eid);
    }

    if (pitchAxis === 0 && yawAxis === 0) return;

    const nextRotation: Partial<Rotation> = {};
    if (pitchAxis !== 0) {
      nextRotation.pitch = clamp(
        Rotation.pitch[eid] + pitchAxis * PLAYER_PITCH_SPEED * dt,
        -PLAYER_MAX_PITCH,
        PLAYER_MAX_PITCH,
      );
    }
    if (yawAxis !== 0) {
      nextRotation.yaw = Rotation.yaw[eid] + yawAxis * PLAYER_YAW_SPEED * dt;
    }
    setEntityRotation(activeWorld, eid, nextRotation);
  });

  world.controls.on(
    {
      source: ControlSources.Keyboard,
      controlId: KeyboardControls.Space,
      phase: "start",
    },
    (activeWorld) => {
      jump(activeWorld);
    },
  );

  world.controls.on(
    {
      source: ControlSources.React,
      controlId: PlayerReactControls.BoostForward,
      phase: "trigger",
    },
    (activeWorld) => {
      if (!isControllingPrime(activeWorld)) return;

      const { Velocity } = activeWorld.components;
      Velocity.z[eid] = clamp(
        Velocity.z[eid] - PLAYER_FORWARD_BOOST,
        -PLAYER_MAX_SPEED,
        PLAYER_MAX_SPEED,
      );
      markFlaginatorComponentChanged(activeWorld, "Velocity", eid);
    },
  );
}

function clampPersonSpawnPositionToFloor(
  world: World,
  position: Position,
  floorEids: FloorEids = queryFloorEids(world),
) {
  const floorTop = findHighestFloorTopAtPosition(
    world,
    floorEids,
    position.x,
    position.z,
  );
  if (floorTop === null) {
    return position;
  }

  return {
    x: position.x,
    y: Math.max(position.y, floorTop + PERSON_COLLIDER.halfHeight),
    z: position.z,
  };
}

function createPerson(
  world: World,
  position: Position,
  velocity: Velocity,
  health: number,
  player: Player,
  floorEids: FloorEids = queryFloorEids(world),
) {
  const spawnPosition = clampPersonSpawnPositionToFloor(
    world,
    position,
    floorEids,
  );

  return spawnEntity(world, {
    position: spawnPosition,
    velocity,
    gravity: true,
    health,
    player,
    collider: PERSON_COLLIDER,
    renderMesh: createPersonRenderMesh,
  });
}

function createFloor(world: World, position: Position) {
  return spawnEntity(world, {
    position,
    floor: true,
    collider: FLOOR_COLLIDER,
    renderMesh: createFloorRenderMesh,
  });
}

export { setupWorld };
