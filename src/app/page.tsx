"use client";

import type { CSSProperties, MouseEvent, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { eventBus } from "@/packages/core/mitt";
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
  cursor: "grab",
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

type WorldUiState = {
  player: Player | null;
  playerPosition: Position | null;
  timeMetrics: Time | null;
  controlStates: ControlState[];
};

type CameraDragController = {
  disconnect: () => void;
};

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const worldRef = useRef<WorldBox | null>(null);
  const uiState = useWorldUiState();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.style.cursor = "grab";
    const world = setupWorld(canvas);
    worldRef.current = world;
    world.start();

    const cameraDragController = createCameraDragController(
      canvas,
      (deltaX, deltaY) => {
        world.adjustCameraFollowOrbit(
          -deltaX * CAMERA_DRAG_SENSITIVITY,
          -deltaY * CAMERA_DRAG_SENSITIVITY,
        );
      },
    );

    return () => {
      cameraDragController.disconnect();
      canvas.style.cursor = "default";
      worldRef.current = null;
      world.dispose();
    };
  }, []);

  function handleBoostForward(event: MouseEvent<HTMLButtonElement>) {
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

  useEffect(() => {
    const onTimeMetrics = ({ timeMetrics }: { timeMetrics: Time }) => {
      setTimeMetrics(timeMetrics);
    };
    const onPlayer = ({ player }: { player: Player | null }) => {
      setPlayer(player);
    };
    const onPlayerPosition = ({
      playerPosition,
    }: {
      playerPosition: Position | null;
    }) => {
      setPlayerPosition(playerPosition);
    };
    const onControls = ({
      controlStates,
    }: {
      controlStates: ControlState[];
    }) => {
      setControlStates(controlStates);
    };

    eventBus.on("ui:timeMetricsUpdate", onTimeMetrics);
    eventBus.on("ui:playerUpdate", onPlayer);
    eventBus.on("ui:playerPositionUpdate", onPlayerPosition);
    eventBus.on("ui:controlsUpdate", onControls);

    return () => {
      eventBus.off("ui:timeMetricsUpdate", onTimeMetrics);
      eventBus.off("ui:playerUpdate", onPlayer);
      eventBus.off("ui:playerPositionUpdate", onPlayerPosition);
      eventBus.off("ui:controlsUpdate", onControls);
    };
  }, []);

  return {
    player,
    playerPosition,
    timeMetrics,
    controlStates,
  };
}

function createCameraDragController(
  canvas: HTMLCanvasElement,
  onDrag: (deltaX: number, deltaY: number) => void,
): CameraDragController {
  let activePointerId: number | null = null;
  let lastClientX = 0;
  let lastClientY = 0;

  function stopDragging(pointerId?: number) {
    if (pointerId !== undefined && activePointerId !== pointerId) return;
    activePointerId = null;
    canvas.style.cursor = "grab";
  }

  function onPointerDown(event: PointerEvent) {
    if (event.button !== 0) return;

    activePointerId = event.pointerId;
    lastClientX = event.clientX;
    lastClientY = event.clientY;
    canvas.style.cursor = "grabbing";

    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Some browsers reject capture when the pointer is already gone.
    }

    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent) {
    if (activePointerId !== event.pointerId) return;
    if ((event.buttons & 1) === 0) {
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

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerCancel);
  canvas.addEventListener("lostpointercapture", onLostPointerCapture);

  return {
    disconnect() {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("lostpointercapture", onLostPointerCapture);
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
  onBoostForward: (event: MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <div style={headerStyle}>
      <span>
        W / S move forward and back, Q / E strafe, A / D or Left / Right turn,
        I / K pitch up and down, drag inside the canvas to orbit the camera,
        and press Space to jump.
      </span>
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
        alone will not trigger the orange touch highlight. Move forward and back
        with W and S, strafe with Q and E, turn with A and D or the left and
        right arrow keys, use I and K to pitch up and down, drag inside the
        canvas to orbit the camera, and press Space to jump. The React Boost
        Forward button in the header also feeds the same control system, so you
        can compare UI input with keyboard input.
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
  return `${formatCoordinate(position.x)}, ${formatCoordinate(position.y)}, ${formatCoordinate(position.z)}`;
}

function formatCoordinate(value: number) {
  return Math.round(value * 100) / 100;
}
