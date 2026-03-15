import {
  CoreFlags,
  ControlSources,
  evaluateFlaginatorFlag,
  hasEntityComponents,
  KeyboardControls,
  markFlaginatorComponentChanged,
  rotateLocalVectorByEntityRotation,
  setEntityRotation,
  type CoreWorld,
  type Rotation,
} from "@/packages/core/core";
import { clamp } from "@/packages/util/random";
import { PlayerReactControls } from "./kikorinControls";

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

export function isPrimePlayerControlled(world: CoreWorld, eid: number) {
  return (
    hasEntityComponents(world, eid, [
      "Player",
      "Velocity",
      "Rotation",
      "Gravity",
    ]) && world.components.Player[eid]?.name === "DoomPrime"
  );
}

function jumpPrimePlayer(world: CoreWorld, eid: number) {
  if (!isPrimePlayerControlled(world, eid)) return;
  if (!evaluateFlaginatorFlag(world, CoreFlags.OnGround, eid)) return;

  const { Gravity, Velocity } = world.components;
  Velocity.y[eid] = clamp(
    PLAYER_JUMP_SPEED,
    -PLAYER_MAX_SPEED,
    PLAYER_MAX_SPEED,
  );
  Gravity.Grounded[eid] = 0;
  markFlaginatorComponentChanged(world, "Velocity", eid);
  markFlaginatorComponentChanged(world, "Gravity", eid);
}

function applyPrimeVelocityControls(
  world: CoreWorld,
  eid: number,
  deltaSeconds: number,
  controls: CoreWorld["controls"],
) {
  if (deltaSeconds === 0) return;

  const drag = Math.max(0, 1 - PLAYER_DRAG_PER_SECOND * deltaSeconds);
  const { Velocity } = world.components;
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
  const worldAcceleration = rotateLocalVectorByEntityRotation(
    world,
    eid,
    localAcceleration,
  );

  Velocity.x[eid] = clamp(
    Velocity.x[eid] + worldAcceleration.x * deltaSeconds,
    -PLAYER_MAX_SPEED,
    PLAYER_MAX_SPEED,
  );
  Velocity.y[eid] = clamp(
    Velocity.y[eid] + worldAcceleration.y * deltaSeconds,
    -PLAYER_MAX_SPEED,
    PLAYER_MAX_SPEED,
  );
  Velocity.z[eid] = clamp(
    Velocity.z[eid] + worldAcceleration.z * deltaSeconds,
    -PLAYER_MAX_SPEED,
    PLAYER_MAX_SPEED,
  );

  if (
    Velocity.x[eid] !== previousVelocityX ||
    Velocity.y[eid] !== previousVelocityY ||
    Velocity.z[eid] !== previousVelocityZ
  ) {
    markFlaginatorComponentChanged(world, "Velocity", eid);
  }
}

function applyPrimeRotationControls(
  world: CoreWorld,
  eid: number,
  deltaSeconds: number,
  controls: CoreWorld["controls"],
) {
  if (deltaSeconds === 0) return;

  const { Rotation } = world.components;
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
  if (pitchAxis === 0 && yawAxis === 0) return;

  const nextRotation: Partial<Rotation> = {};
  if (pitchAxis !== 0) {
    nextRotation.pitch = clamp(
      Rotation.pitch[eid] + pitchAxis * PLAYER_PITCH_SPEED * deltaSeconds,
      -PLAYER_MAX_PITCH,
      PLAYER_MAX_PITCH,
    );
  }
  if (yawAxis !== 0) {
    nextRotation.yaw =
      Rotation.yaw[eid] + yawAxis * PLAYER_YAW_SPEED * deltaSeconds;
  }
  setEntityRotation(world, eid, nextRotation);
}

function applyPrimeMovementControls(
  world: CoreWorld,
  eid: number,
  deltaSeconds: number,
  controls: CoreWorld["controls"],
) {
  if (!isPrimePlayerControlled(world, eid)) return;

  applyPrimeVelocityControls(world, eid, deltaSeconds, controls);
  applyPrimeRotationControls(world, eid, deltaSeconds, controls);
}

function boostPrimeForward(world: CoreWorld, eid: number) {
  if (!isPrimePlayerControlled(world, eid)) return;

  const { Velocity } = world.components;
  Velocity.z[eid] = clamp(
    Velocity.z[eid] - PLAYER_FORWARD_BOOST,
    -PLAYER_MAX_SPEED,
    PLAYER_MAX_SPEED,
  );
  markFlaginatorComponentChanged(world, "Velocity", eid);
}

export function registerPrimeMovementControls(world: CoreWorld, eid: number) {
  world.controls.onTick((activeWorld, tick, controls) => {
    applyPrimeMovementControls(activeWorld, eid, tick.deltaSeconds, controls);
  });

  world.controls.on(
    {
      source: ControlSources.Keyboard,
      controlId: KeyboardControls.Space,
      phase: "start",
    },
    (activeWorld) => {
      jumpPrimePlayer(activeWorld, eid);
    },
  );

  world.controls.on(
    {
      source: ControlSources.React,
      controlId: PlayerReactControls.BoostForward,
      phase: "trigger",
    },
    (activeWorld) => {
      boostPrimeForward(activeWorld, eid);
    },
  );
}
