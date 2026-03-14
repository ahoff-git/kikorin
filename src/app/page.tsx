"use client";

import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  RefObject,
} from "react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { eventBus, type EventBusEvents } from "@/packages/core/mitt";
import {
  ControlSources,
  type ControlState,
  type Player,
  type Position,
  type Time,
} from "@/packages/core/types";
import { setupWorld, type WorldBox } from "./kikorin";
import { PlayerReactControls } from "./kikorinControls";
import { PageLayout } from "./kikorinLayout";

const CAMERA_DRAG_SENSITIVITY = 0.006;
const PRIMARY_POINTER_BUTTON_MASK = 1;
const SECONDARY_POINTER_BUTTON_MASK = 2;

const canvasViewportStyle: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "flex",
};

const canvasStyle: CSSProperties = {
  flex: 1,
  width: "100%",
  height: "100%",
  display: "block",
  touchAction: "none",
  cursor: "default",
};

const headerStyle: CSSProperties = {
  display: "flex",
  gap: 12,
  alignItems: "center",
  flexWrap: "wrap",
};

const navStyle: CSSProperties = {
  padding: "16px 20px",
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const sectionLabelStyle: CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  letterSpacing: "0.08em",
  textTransform: "uppercase",
};

const helperTextStyle: CSSProperties = {
  lineHeight: 1.6,
  color: "#555",
};

const controlsSectionStyle: CSSProperties = {
  marginTop: 12,
};

const CONTROL_INSTRUCTIONS =
  "W / S move forward and back, Q / E strafe, A / D or Left / Right turn, I / K pitch up and down, left click to fire a small block, right drag inside the canvas to orbit the camera, and press Space to jump.";

const LEFT_NAV_CONTROL_INSTRUCTIONS =
  "Move forward and back with W and S, strafe with Q and E, turn with A and D or the left and right arrow keys, use I and K to pitch up and down, left click to fire a small block that can bounce off other blocks, right drag inside the canvas to orbit the camera, and press Space to jump.";

const CONTROL_SYSTEM_NOTE =
  "The React Boost Forward button in the header also feeds the same control system, so you can compare UI input with keyboard input.";

type WorldUiState = {
  player: Player | null;
  playerPosition: Position | null;
  timeMetrics: Time | null;
  controlStates: ControlState[];
};

type CameraDragController = {
  disconnect: () => void;
};

type EventBusEventName = keyof EventBusEvents;

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const worldRef = useRef<WorldBox | null>(null);
  const uiState = useWorldUiState();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.style.cursor = "default";
    const world = setupWorld(canvas);
    worldRef.current = world;

    const cameraDragController = createCameraDragController(
      canvas,
      (deltaX, deltaY) => {
        world.adjustCameraFollowOrbit(
          -deltaX * CAMERA_DRAG_SENSITIVITY,
          -deltaY * CAMERA_DRAG_SENSITIVITY,
        );
      },
      (active) => {
        world.setCameraFollowOrbitControlActive(active);
      },
    );

    return () => {
      cameraDragController.disconnect();
      canvas.style.cursor = "default";
      worldRef.current = null;
      world.dispose();
    };
  }, []);

  function handleBoostForward(event: ReactMouseEvent<HTMLButtonElement>) {
    worldRef.current?.world.controls.enqueue({
      timestamp: event.timeStamp,
      source: ControlSources.React,
      controlId: PlayerReactControls.BoostForward,
      phase: "trigger",
      payload: {
        kind: "button-click",
      },
    });
  }

  return (
    <PageLayout
      header={<Header onBoostForward={handleBoostForward} />}
      left={<LeftNav />}
      right={<RightPanel {...uiState} />}
      footer={<Footer />}
    >
      <CanvasViewport canvasRef={canvasRef} />
    </PageLayout>
  );
}

function useWorldUiState(): WorldUiState {
  const [player, setPlayer] = useState<Player | null>(null);
  const [playerPosition, setPlayerPosition] = useState<Position | null>(null);
  const [timeMetrics, setTimeMetrics] = useState<Time | null>(null);
  const [controlStates, setControlStates] = useState<ControlState[]>([]);

  useEventBusState(
    "ui:timeMetricsUpdate",
    setTimeMetrics,
    ({ timeMetrics }) => {
      return timeMetrics;
    },
  );
  useEventBusState("ui:playerUpdate", setPlayer, ({ player }) => {
    return player;
  });
  useEventBusState(
    "ui:playerPositionUpdate",
    setPlayerPosition,
    ({ playerPosition: nextPlayerPosition }) => {
      return nextPlayerPosition;
    },
  );
  useEventBusState(
    "ui:controlsUpdate",
    setControlStates,
    ({ controlStates }) => {
      return controlStates;
    },
  );

  return {
    player,
    playerPosition,
    timeMetrics,
    controlStates,
  };
}

function useEventBusState<TValue, TEventName extends EventBusEventName>(
  eventName: TEventName,
  setValue: (value: TValue) => void,
  selectValue: (event: EventBusEvents[TEventName]) => TValue,
) {
  const onEvent = useEffectEvent((event: EventBusEvents[TEventName]) => {
    setValue(selectValue(event));
  });

  useEffect(() => {
    const listener = (event: EventBusEvents[TEventName]) => {
      onEvent(event);
    };

    eventBus.on(eventName, listener);
    return () => {
      eventBus.off(eventName, listener);
    };
  }, [eventName]);
}

function createCameraDragController(
  canvas: HTMLCanvasElement,
  onDrag: (deltaX: number, deltaY: number) => void,
  onDragActiveChange?: (active: boolean) => void,
): CameraDragController {
  let activePointerId: number | null = null;
  let activeButtonsMask = 0;
  let lastClientX = 0;
  let lastClientY = 0;

  function getCameraDragButton(event: PointerEvent): number {
    return event.pointerType === "mouse" ? 2 : 0;
  }

  function getCameraDragButtonsMask(event: PointerEvent): number {
    return event.pointerType === "mouse"
      ? SECONDARY_POINTER_BUTTON_MASK
      : PRIMARY_POINTER_BUTTON_MASK;
  }

  function stopDragging(pointerId?: number) {
    if (pointerId !== undefined && activePointerId !== pointerId) return;
    const wasDragging = activePointerId !== null;
    activePointerId = null;
    activeButtonsMask = 0;
    canvas.style.cursor = "default";
    if (wasDragging) {
      onDragActiveChange?.(false);
    }
  }

  function onPointerDown(event: PointerEvent) {
    if (event.button !== getCameraDragButton(event)) return;

    activePointerId = event.pointerId;
    activeButtonsMask = getCameraDragButtonsMask(event);
    lastClientX = event.clientX;
    lastClientY = event.clientY;
    canvas.style.cursor = "grabbing";
    onDragActiveChange?.(true);

    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Some browsers reject capture when the pointer is already gone.
    }

    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent) {
    if (activePointerId !== event.pointerId) return;
    if ((event.buttons & activeButtonsMask) === 0) {
      stopDragging(event.pointerId);
      return;
    }

    const deltaX = event.clientX - lastClientX;
    const deltaY = event.clientY - lastClientY;
    lastClientX = event.clientX;
    lastClientY = event.clientY;

    if (deltaX === 0 && deltaY === 0) return;

    onDrag(deltaX, deltaY);
    event.preventDefault();
  }

  function onPointerUp(event: PointerEvent) {
    try {
      canvas.releasePointerCapture(event.pointerId);
    } catch {
      // Safe to ignore if capture was already released elsewhere.
    }

    stopDragging(event.pointerId);
  }

  function onPointerCancel(event: PointerEvent) {
    stopDragging(event.pointerId);
  }

  function onLostPointerCapture() {
    stopDragging();
  }

  function onContextMenu(event: MouseEvent) {
    event.preventDefault();
  }

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("lostpointercapture", onLostPointerCapture);
  canvas.addEventListener("contextmenu", onContextMenu);

  return {
    disconnect() {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("lostpointercapture", onLostPointerCapture);
      canvas.removeEventListener("contextmenu", onContextMenu);
      stopDragging();
    },
  };
}

function CanvasViewport({
  canvasRef,
}: {
  canvasRef: RefObject<HTMLCanvasElement | null>;
}) {
  return (
    <div style={canvasViewportStyle}>
      <canvas ref={canvasRef} style={canvasStyle} />
    </div>
  );
}

function Header({
  onBoostForward,
}: {
  onBoostForward: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div style={headerStyle}>
      <span>{CONTROL_INSTRUCTIONS}</span>
      <button type="button" onClick={onBoostForward}>
        React Boost Forward
      </button>
    </div>
  );
}

function LeftNav() {
  return (
    <div style={navStyle}>
      <div style={sectionLabelStyle}>Controls</div>
      <div style={helperTextStyle}>
        Everything now falls until it lands on the floor, but floor contact
        alone will not trigger the orange touch highlight.{" "}
        {LEFT_NAV_CONTROL_INSTRUCTIONS} {CONTROL_SYSTEM_NOTE}
      </div>
    </div>
  );
}

function RightPanel({
  player,
  playerPosition,
  timeMetrics,
  controlStates,
}: WorldUiState) {
  const averageDelta = Math.round(timeMetrics?.avgDelta ?? 0);
  const ticksPerSecond = Math.round(timeMetrics?.ticksPerSecond ?? 0);
  const playerName = player?.name ?? "No player";
  const playerExperience = Math.round((player?.experience ?? 0) * 100) / 100;
  const playerLevel = Math.round(player?.level ?? 0);
  const positionLabel = formatPosition(playerPosition);

  return (
    <div>
      <div>DeltaT: {averageDelta}</div>
      <div>TPS: {ticksPerSecond}</div>
      <div>
        Player:
        <div>Name: {playerName}</div>
        <div>XP: {playerExperience}</div>
        <div>Level: {playerLevel}</div>
        <div>Position: {positionLabel}</div>
      </div>
      <div style={controlsSectionStyle}>
        <div>Controls:</div>
        {controlStates.length === 0 ? (
          <div>No controls seen yet</div>
        ) : (
          controlStates.map((controlState) => (
            <div key={controlState.key}>
              {controlState.key}:{" "}
              {controlState.active ? "active" : controlState.phase} for{" "}
              {Math.round(controlState.durationMs)}ms
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function Footer() {
  return <>Hi - I&apos;m the Footer</>;
}

function formatPosition(position: Position | null) {
  if (!position) return "0, 0, 0";
  return [
    formatCoordinate(position.x),
    formatCoordinate(position.y),
    formatCoordinate(position.z),
  ].join(", ");
}

function formatCoordinate(value: number) {
  return Math.round(value * 100) / 100;
}
