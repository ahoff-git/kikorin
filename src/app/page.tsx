"use client";

import type {
  ChangeEvent,
  CSSProperties,
  RefObject,
} from "react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { eventBus, type EventBusEvents } from "@/packages/core/mitt";
import {
  type CameraSettings,
  type CameraViewMode,
  type Player,
  type Position,
  type ProjectionMode,
  type Time,
} from "@/packages/core/types";
import { setupWorld, type WorldBox } from "./kikorin";
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
  alignItems: "center",
  padding: "6px 10px",
  overflowX: "auto",
  overflowY: "hidden",
};

const cameraControlsStyle: CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "nowrap",
  alignItems: "center",
  minWidth: "max-content",
};

const cameraControlCardStyle: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  minWidth: 112,
  padding: "6px 8px",
  border: "1px solid #d7d7d7",
  borderRadius: 8,
  background: "rgba(255, 255, 255, 0.92)",
};

const cameraControlLabelRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  justifyContent: "space-between",
  gap: 8,
  fontSize: 11,
  fontWeight: 700,
  lineHeight: 1.1,
  textTransform: "uppercase",
};

const cameraSliderStyle: CSSProperties = {
  width: "100%",
  margin: 0,
  height: 18,
};

const cameraSelectStyle: CSSProperties = {
  width: "100%",
  minHeight: 28,
  padding: "4px 6px",
  border: "1px solid #c9c9c9",
  borderRadius: 6,
  background: "#fff",
  fontSize: 12,
};

const DEFAULT_CAMERA_SETTINGS = {
  fov: 75,
  followDistance: 10.8,
  viewMode: "follow",
  projectionMode: "perspective",
  orthographicZoom: 1,
} satisfies CameraSettings;

const CAMERA_FOV_RANGE = {
  min: 20,
  max: 140,
  step: 1,
} as const;

const CAMERA_FOLLOW_DISTANCE_RANGE = {
  min: 0.5,
  max: 60,
  step: 0.5,
} as const;

const CAMERA_ORTHOGRAPHIC_ZOOM_RANGE = {
  min: 0.25,
  max: 12,
  step: 0.05,
} as const;

type WorldUiState = {
  player: Player | null;
  playerPosition: Position | null;
  timeMetrics: Time | null;
};

type CameraDragController = {
  disconnect: () => void;
};

type EventBusEventName = keyof EventBusEvents;

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const worldRef = useRef<WorldBox | null>(null);
  const uiState = useWorldUiState();
  const [cameraSettings, setCameraSettings] = useState<CameraSettings>(
    DEFAULT_CAMERA_SETTINGS,
  );

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.style.cursor = "default";
    const world = setupWorld(canvas);
    worldRef.current = world;
    setCameraSettings(world.readCameraSettings());

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

  function handleCameraFovChange(event: ChangeEvent<HTMLInputElement>) {
    const fov = Number(event.currentTarget.value);
    setCameraSettings((current) => ({ ...current, fov }));
    worldRef.current?.setCameraFov(fov);
  }

  function handleCameraFollowDistanceChange(
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const followDistance = Number(event.currentTarget.value);
    setCameraSettings((current) => ({ ...current, followDistance }));
    worldRef.current?.setCameraFollowDistance(followDistance);
  }

  function handleCameraOrthographicZoomChange(
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const orthographicZoom = Number(event.currentTarget.value);
    setCameraSettings((current) => ({ ...current, orthographicZoom }));
    worldRef.current?.setOrthographicZoom(orthographicZoom);
  }

  function handleCameraViewModeChange(event: ChangeEvent<HTMLSelectElement>) {
    const viewMode = event.currentTarget.value as CameraViewMode;
    setCameraSettings((current) => ({ ...current, viewMode }));
    worldRef.current?.setCameraViewMode(viewMode);
  }

  function handleProjectionModeChange(event: ChangeEvent<HTMLSelectElement>) {
    const projectionMode = event.currentTarget.value as ProjectionMode;
    setCameraSettings((current) => ({ ...current, projectionMode }));
    worldRef.current?.setProjectionMode(projectionMode);
  }

  return (
    <PageLayout
      header={
        <Header
          cameraSettings={cameraSettings}
          onCameraFollowDistanceChange={handleCameraFollowDistanceChange}
          onCameraFovChange={handleCameraFovChange}
          onCameraOrthographicZoomChange={handleCameraOrthographicZoomChange}
          onProjectionModeChange={handleProjectionModeChange}
          onCameraViewModeChange={handleCameraViewModeChange}
        />
      }
      left={null}
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

  return {
    player,
    playerPosition,
    timeMetrics,
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
  cameraSettings,
  onCameraFollowDistanceChange,
  onCameraFovChange,
  onCameraOrthographicZoomChange,
  onProjectionModeChange,
  onCameraViewModeChange,
}: {
  cameraSettings: CameraSettings;
  onCameraFollowDistanceChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onCameraFovChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onCameraOrthographicZoomChange: (
    event: ChangeEvent<HTMLInputElement>,
  ) => void;
  onProjectionModeChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  onCameraViewModeChange: (event: ChangeEvent<HTMLSelectElement>) => void;
}) {
  return (
    <div style={headerStyle}>
      <div style={cameraControlsStyle}>
        <CameraViewModeControl
          onChange={onCameraViewModeChange}
          value={cameraSettings.viewMode}
        />
        <CameraProjectionModeControl
          onChange={onProjectionModeChange}
          value={cameraSettings.projectionMode}
        />
        <CameraSettingControl
          disabled={cameraSettings.projectionMode === "orthographic"}
          label="FOV"
          max={CAMERA_FOV_RANGE.max}
          min={CAMERA_FOV_RANGE.min}
          onChange={onCameraFovChange}
          step={CAMERA_FOV_RANGE.step}
          value={cameraSettings.fov}
          valueFormatter={(value) => `${Math.round(value)} deg`}
        />
        <CameraSettingControl
          disabled={cameraSettings.viewMode === "firstPerson"}
          label="Dist"
          max={CAMERA_FOLLOW_DISTANCE_RANGE.max}
          min={CAMERA_FOLLOW_DISTANCE_RANGE.min}
          onChange={onCameraFollowDistanceChange}
          step={CAMERA_FOLLOW_DISTANCE_RANGE.step}
          value={cameraSettings.followDistance}
          valueFormatter={(value) => `${value.toFixed(1)} u`}
        />
        <CameraSettingControl
          disabled={cameraSettings.projectionMode !== "orthographic"}
          label="Ortho"
          max={CAMERA_ORTHOGRAPHIC_ZOOM_RANGE.max}
          min={CAMERA_ORTHOGRAPHIC_ZOOM_RANGE.min}
          onChange={onCameraOrthographicZoomChange}
          step={CAMERA_ORTHOGRAPHIC_ZOOM_RANGE.step}
          value={cameraSettings.orthographicZoom}
          valueFormatter={(value) => `${value.toFixed(2)}x`}
        />
      </div>
    </div>
  );
}

function CameraViewModeControl({
  onChange,
  value,
}: {
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  value: CameraViewMode;
}) {
  return (
    <label style={cameraControlCardStyle}>
      <span style={cameraControlLabelRowStyle}>
        <span>View</span>
        <span>{formatCameraViewMode(value)}</span>
      </span>
      <select
        aria-label="Camera view"
        onChange={onChange}
        style={cameraSelectStyle}
        title="Camera view"
        value={value}
      >
        <option value="follow">Follow</option>
        <option value="firstPerson">First</option>
      </select>
    </label>
  );
}

function CameraProjectionModeControl({
  onChange,
  value,
}: {
  onChange: (event: ChangeEvent<HTMLSelectElement>) => void;
  value: ProjectionMode;
}) {
  return (
    <label style={cameraControlCardStyle}>
      <span style={cameraControlLabelRowStyle}>
        <span>Proj</span>
        <span>{formatProjectionMode(value)}</span>
      </span>
      <select
        aria-label="Projection mode"
        onChange={onChange}
        style={cameraSelectStyle}
        title="Projection mode"
        value={value}
      >
        <option value="perspective">Persp</option>
        <option value="orthographic">Ortho</option>
      </select>
    </label>
  );
}

function CameraSettingControl({
  disabled = false,
  label,
  max,
  min,
  onChange,
  step,
  value,
  valueFormatter,
}: {
  disabled?: boolean;
  label: string;
  max: number;
  min: number;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  step: number;
  value: number;
  valueFormatter: (value: number) => string;
}) {
  return (
    <label
      style={{
        ...cameraControlCardStyle,
        opacity: disabled ? 0.45 : 1,
      }}
    >
      <span style={cameraControlLabelRowStyle}>
        <span>{label}</span>
        <span>{valueFormatter(value)}</span>
      </span>
      <input
        disabled={disabled}
        max={max}
        min={min}
        onChange={onChange}
        step={step}
        title={label}
        style={cameraSliderStyle}
        type="range"
        value={value}
      />
    </label>
  );
}

function RightPanel({
  player,
  playerPosition,
  timeMetrics,
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

function formatCameraViewMode(viewMode: CameraViewMode) {
  if (viewMode === "firstPerson") return "First";
  return "Follow";
}

function formatProjectionMode(projectionMode: ProjectionMode) {
  if (projectionMode === "orthographic") return "Ortho";
  return "Persp";
}
