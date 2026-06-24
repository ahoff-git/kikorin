"use client";

import type {
  CSSProperties,
  MouseEvent as ReactMouseEvent,
  RefObject,
} from "react";
import { useEffect, useRef, useState } from "react";
import {
  ControlSources,
  type ControlState,
  type Player,
  type Position,
  type Time,
  useKikorin,
  useKikorinEvent,
} from "@kikorin/react";
import { setupGame } from "./kikorin";
import { useNetworking, type ChatMessage } from "./useNetworking";
import { PlayerReactControls } from "./kikorinControls";
import { Box } from "@mui/material";
import { PageLayout } from "./kikorinLayout";

const CAMERA_DRAG_SENSITIVITY = 0.006;
const CHARACTER_SPIN_SENSITIVITY = 0.006;
const PRIMARY_POINTER_BUTTON_MASK = 1;
const SECONDARY_POINTER_BUTTON_MASK = 2;
const MIDDLE_POINTER_BUTTON_MASK = 4;
const CLICK_MAX_MOVEMENT_PX = 4;

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

const chatBoxStyle: CSSProperties = {
  marginTop: 12,
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const chatLogStyle: CSSProperties = {
  height: 140,
  overflowY: "auto",
  background: "#111",
  borderRadius: 4,
  padding: "6px 8px",
  fontSize: 11,
  fontFamily: "monospace",
  display: "flex",
  flexDirection: "column",
  gap: 2,
};

const chatInputRowStyle: CSSProperties = {
  display: "flex",
  gap: 4,
};

const chatInputStyle: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: "monospace",
  fontSize: 11,
};

const networkPanelStyle: CSSProperties = { marginTop: 16 };

const networkRowStyle: CSSProperties = {
  display: "flex",
  gap: 4,
  alignItems: "center",
  marginTop: 4,
};

const networkIdStyle: CSSProperties = {
  fontFamily: "monospace",
  fontSize: 11,
  wordBreak: "break-all",
  flex: 1,
};

const networkInputStyle: CSSProperties = {
  fontFamily: "monospace",
  fontSize: 11,
  flex: 1,
  minWidth: 0,
};

const networkPeerItemStyle: CSSProperties = {
  fontFamily: "monospace",
  fontSize: 11,
  marginTop: 2,
  color: "#ff44aa",
};

const CONTROL_INSTRUCTIONS =
  "W / S move forward and back, Q / E strafe, A / D or Left / Right turn, I / K pitch up and down, left click to fire, middle drag to orbit the camera, middle click to reset the camera, right drag to spin the player, and press Space to jump.";

const LEFT_NAV_CONTROL_INSTRUCTIONS =
  "Move forward and back with W and S, strafe with Q and E, turn with A and D or the left and right arrow keys, use I and K to pitch up and down, left click to fire a small block that can bounce off other blocks, middle-click drag to orbit the camera, middle click to reset the camera behind the player, right drag to spin the player, and press Space to jump.";

const CONTROL_SYSTEM_NOTE =
  "The React Boost Forward button in the header also feeds the same control system, so you can compare UI input with keyboard input.";

type WorldUiState = {
  player: Player | null;
  playerPosition: Position | null;
  timeMetrics: Time | null;
  controlStates: ControlState[];
  sprintStamina: number;
};

type CameraDragController = {
  disconnect: () => void;
};

export default function Home() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engine = useKikorin(canvasRef);
  const [playerEid, setPlayerEid] = useState<number | null>(null);
  const [ownedEids, setOwnedEids] = useState<readonly number[]>([]);
  const uiState = useWorldUiState();
  const { localPeerId, connectedPeers, chatMessages, connect, sendChatMessage, addOwnedEntity, removeOwnedEntity, signalEntityDestroyed, signalHitOnRemoteEntity, setHitHandler } = useNetworking(
    engine,
    playerEid,
    ownedEids,
  );

  useEffect(() => {
    if (!engine) return;

    const { playerEid: eid, ownedEids: owned, onRemoteEntityHit } = setupGame(engine, { addOwnedEntity, removeOwnedEntity, signalEntityDestroyed, signalHitOnRemoteEntity });
    setHitHandler(onRemoteEntityHit);
    setPlayerEid(eid);
    setOwnedEids(owned);

    const canvas = canvasRef.current!;
    canvas.style.cursor = "default";

    const cameraDragController = createCameraDragController(
      canvas,
      (deltaX, deltaY) => {
        engine.adjustCameraFollowOrbit(
          -deltaX * CAMERA_DRAG_SENSITIVITY,
          -deltaY * CAMERA_DRAG_SENSITIVITY,
        );
      },
      (active) => {
        engine.setCameraFollowOrbitControlActive(active);
      },
      (deltaX) => {
        const { Rotation } = engine.world.components;
        const newYaw = Rotation.yaw[eid] - deltaX * CHARACTER_SPIN_SENSITIVITY;
        engine.setEntityRotation(eid, { yaw: newYaw });
      },
      () => {
        engine.resetCameraFollowOrbitBehindTarget();
      },
    );

    return () => {
      setHitHandler(null);
      cameraDragController.disconnect();
      canvas.style.cursor = "default";
      setPlayerEid(null);
      setOwnedEids([]);
    };
  }, [engine]);

  function handleBoostForward(event: ReactMouseEvent<HTMLButtonElement>) {
    engine?.world.controls.enqueue({
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
      right={
        <RightPanel
          {...uiState}
          localPeerId={localPeerId}
          connectedPeers={connectedPeers}
          onConnect={connect}
          chatMessages={chatMessages}
          onSendChat={sendChatMessage}
        />
      }
      footer={<Footer sprintStamina={uiState.sprintStamina} />}
    >
      <CanvasViewport canvasRef={canvasRef} />
    </PageLayout>
  );
}

const INITIAL_UI_STATE: WorldUiState = {
  player: null,
  playerPosition: null,
  timeMetrics: null,
  controlStates: [],
  sprintStamina: 1,
};

function useWorldUiState(): WorldUiState {
  const [state, setState] = useState<WorldUiState>(INITIAL_UI_STATE);

  useKikorinEvent("ui:timeMetricsUpdate", ({ timeMetrics }) =>
    setState(s => ({ ...s, timeMetrics })),
  );
  useKikorinEvent("ui:playerUpdate", ({ player }) =>
    setState(s => ({ ...s, player })),
  );
  useKikorinEvent("ui:playerPositionUpdate", ({ playerPosition }) =>
    setState(s => ({ ...s, playerPosition })),
  );
  useKikorinEvent("ui:controlsUpdate", ({ controlStates }) =>
    setState(s => ({ ...s, controlStates })),
  );
  useKikorinEvent("ui:sprintStaminaUpdate", ({ stamina }) =>
    setState(s => ({ ...s, sprintStamina: stamina })),
  );

  return state;
}

function createCameraDragController(
  canvas: HTMLCanvasElement,
  onCameraDrag: (deltaX: number, deltaY: number) => void,
  onCameraDragActiveChange: ((active: boolean) => void) | undefined,
  onCharacterDrag: (deltaX: number, deltaY: number) => void,
  onMiddleClick: (() => void) | undefined,
): CameraDragController {
  type SessionType = "camera" | "character";

  type Session = {
    pointerId: number;
    buttonsMask: number;
    type: SessionType;
    startX: number;
    startY: number;
    lastX: number;
    lastY: number;
    hasDragged: boolean;
  };

  let session: Session | null = null;

  function stopSession(pointerId?: number) {
    if (session === null) return;
    if (pointerId !== undefined && session.pointerId !== pointerId) return;

    const ended = session;
    session = null;
    canvas.style.cursor = "default";

    if (ended.type === "camera") {
      if (ended.hasDragged) {
        onCameraDragActiveChange?.(false);
      } else {
        onMiddleClick?.();
      }
    }
  }

  function onPointerDown(event: PointerEvent) {
    if (session !== null) return;

    let sessionType: SessionType | null = null;
    let buttonsMask = 0;

    if (event.pointerType === "mouse") {
      if (event.button === 1) {
        sessionType = "camera";
        buttonsMask = MIDDLE_POINTER_BUTTON_MASK;
      } else if (event.button === 2) {
        sessionType = "character";
        buttonsMask = SECONDARY_POINTER_BUTTON_MASK;
      }
    } else if (event.button === 0) {
      sessionType = "camera";
      buttonsMask = PRIMARY_POINTER_BUTTON_MASK;
    }

    if (sessionType === null) return;

    session = {
      pointerId: event.pointerId,
      buttonsMask,
      type: sessionType,
      startX: event.clientX,
      startY: event.clientY,
      lastX: event.clientX,
      lastY: event.clientY,
      hasDragged: false,
    };

    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Some browsers reject capture when the pointer is already gone.
    }

    event.preventDefault();
  }

  function onPointerMove(event: PointerEvent) {
    if (session === null || session.pointerId !== event.pointerId) return;
    if ((event.buttons & session.buttonsMask) === 0) {
      stopSession(event.pointerId);
      return;
    }

    const deltaX = event.clientX - session.lastX;
    const deltaY = event.clientY - session.lastY;
    session.lastX = event.clientX;
    session.lastY = event.clientY;

    if (!session.hasDragged) {
      const totalDX = event.clientX - session.startX;
      const totalDY = event.clientY - session.startY;
      if (Math.hypot(totalDX, totalDY) > CLICK_MAX_MOVEMENT_PX) {
        session.hasDragged = true;
        if (session.type === "camera") {
          canvas.style.cursor = "grabbing";
          onCameraDragActiveChange?.(true);
        }
      }
    }

    if (!session.hasDragged || (deltaX === 0 && deltaY === 0)) return;

    if (session.type === "camera") {
      onCameraDrag(deltaX, deltaY);
    } else {
      onCharacterDrag(deltaX, deltaY);
    }

    event.preventDefault();
  }

  function onPointerUp(event: PointerEvent) {
    try {
      canvas.releasePointerCapture(event.pointerId);
    } catch {
      // Safe to ignore if capture was already released elsewhere.
    }
    stopSession(event.pointerId);
  }

  function onPointerCancel(event: PointerEvent) {
    stopSession(event.pointerId);
  }

  function onLostPointerCapture() {
    stopSession();
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
      stopSession();
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
      <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={onBoostForward}>
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
  localPeerId,
  connectedPeers,
  onConnect,
  chatMessages,
  onSendChat,
}: Omit<WorldUiState, "controlStates"> & {
  localPeerId: string | null;
  connectedPeers: string[];
  onConnect: (peerId: string) => void;
  chatMessages: ChatMessage[];
  onSendChat: (text: string) => void;
}) {
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
      <ChatBox
        messages={chatMessages}
        localPeerId={localPeerId}
        onSend={onSendChat}
      />
      <NetworkPanel
        localPeerId={localPeerId}
        connectedPeers={connectedPeers}
        onConnect={onConnect}
      />
    </div>
  );
}

function ChatBox({
  messages,
  localPeerId,
  onSend,
}: {
  messages: ChatMessage[];
  localPeerId: string | null;
  onSend: (text: string) => void;
}) {
  const [input, setInput] = useState("");
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  function handleSend() {
    const trimmed = input.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setInput("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleSend();
  }

  return (
    <div style={chatBoxStyle}>
      <div style={sectionLabelStyle}>Chat</div>
      <div ref={logRef} style={chatLogStyle}>
        {messages.length === 0 ? (
          <div style={{ color: "#555" }}>No messages yet</div>
        ) : (
          messages.map((msg) => (
            <div key={msg.id} style={{ color: msg.from === "me" ? "#4ade80" : "#ff44aa" }}>
              <span style={{ fontWeight: 700 }}>
                {msg.from === "me" ? "You" : msg.from.slice(0, 8)}
              </span>
              {": "}
              {msg.text}
            </div>
          ))
        )}
      </div>
      <div style={chatInputRowStyle}>
        <input
          style={chatInputStyle}
          placeholder="Type a message…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={!localPeerId}
        />
        <button
          type="button"
          onClick={handleSend}
          disabled={!localPeerId || !input.trim()}
        >
          Send
        </button>
      </div>
    </div>
  );
}

function NetworkPanel({
  localPeerId,
  connectedPeers,
  onConnect,
}: {
  localPeerId: string | null;
  connectedPeers: string[];
  onConnect: (peerId: string) => void;
}) {
  const [inputValue, setInputValue] = useState("");
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    if (!localPeerId) return;
    void navigator.clipboard.writeText(localPeerId).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  function handleConnect() {
    const trimmed = inputValue.trim();
    if (!trimmed || !localPeerId) return;
    onConnect(trimmed);
    setInputValue("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") handleConnect();
  }

  return (
    <div style={networkPanelStyle}>
      <div style={sectionLabelStyle}>Multiplayer</div>

      <div style={{ marginTop: 6 }}>
        <div style={{ fontSize: 11, color: "#555" }}>Your ID</div>
        <div style={networkRowStyle}>
          <span style={networkIdStyle}>
            {localPeerId ?? "connecting…"}
          </span>
          <button
            type="button"
            onClick={handleCopy}
            disabled={!localPeerId}
            style={{ whiteSpace: "nowrap" }}
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
      </div>

      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 11, color: "#555" }}>Connect to peer</div>
        <div style={networkRowStyle}>
          <input
            style={networkInputStyle}
            placeholder="Paste peer ID…"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={!localPeerId}
          />
          <button
            type="button"
            onClick={handleConnect}
            disabled={!localPeerId || !inputValue.trim()}
          >
            Join
          </button>
        </div>
      </div>

      {connectedPeers.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ fontSize: 11, color: "#555" }}>
            Connected ({connectedPeers.length})
          </div>
          {connectedPeers.map((id) => (
            <div key={id} style={networkPeerItemStyle}>
              {id}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function useFps(): number {
  const [fps, setFps] = useState(0);

  useEffect(() => {
    let frameCount = 0;
    let lastTime = performance.now();
    let rafId: number;

    function frame() {
      frameCount++;
      const now = performance.now();
      const elapsed = now - lastTime;
      if (elapsed >= 1000) {
        setFps(Math.round((frameCount * 1000) / elapsed));
        frameCount = 0;
        lastTime = now;
      }
      rafId = requestAnimationFrame(frame);
    }

    rafId = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(rafId);
  }, []);

  return fps;
}

const FOOTER_COLUMN_TEMPLATE = {
  xs: "1fr",
  md: "clamp(200px, 20%, 300px) minmax(0, 1fr) clamp(200px, 20%, 300px)",
};

const sprintBarTrackStyle: CSSProperties = {
  height: 6,
  background: "#1a1a1a",
  borderRadius: 3,
  overflow: "hidden",
};

function Footer({ sprintStamina }: { sprintStamina: number }) {
  const fps = useFps();
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: FOOTER_COLUMN_TEMPLATE,
        columnGap: 2,
        px: 0,
        py: "6px",
      }}
    >
      <Box
        sx={{
          display: { xs: "none", md: "flex" },
          alignItems: "center",
          justifyContent: "flex-end",
          fontSize: 11,
          color: "#555",
          pr: 1,
        }}
      >
        {fps} FPS
      </Box>
      <Box sx={{ display: "flex", flexDirection: "column", gap: "4px", justifyContent: "center" }}>
        <div style={sprintBarTrackStyle}>
          <div
            style={{
              height: "100%",
              width: `${sprintStamina * 100}%`,
              background: sprintStamina > 0.3 ? "#4ade80" : "#f97316",
              borderRadius: 3,
              transition: "width 0.05s linear, background 0.2s",
            }}
          />
        </div>
      </Box>
      <Box sx={{ display: { xs: "none", md: "block" } }} />
    </Box>
  );
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
