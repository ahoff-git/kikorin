"use client"
import { MouseEvent, ReactNode, useEffect, useRef, useState } from "react"
import { setupWorld, WorldBox } from "./kikorin"
import { PlayerReactControls } from "./kikorinControls";
import { PageLayout } from "./kikorinLayout";
import { eventBus } from "@/packages/core/mitt";
import { ControlSources, ControlState, Player, Position, Time } from "@/packages/core/types";

const CAMERA_DRAG_SENSITIVITY = 0.006;

export default function Home() {
  console.log("render");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const worldRef = useRef<WorldBox | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current!;
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    canvas.style.cursor = "grab";

    const world = setupWorld(canvas)
    console.log("START WORLD");
    world.start()
    worldRef.current = world
    console.log(world);

    let activePointerId: number | null = null;
    let lastClientX = 0;
    let lastClientY = 0;

    const stopDragging = (pointerId?: number) => {
      if (pointerId !== undefined && activePointerId !== pointerId) return;
      activePointerId = null;
      canvas.style.cursor = "grab";
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      activePointerId = event.pointerId;
      lastClientX = event.clientX;
      lastClientY = event.clientY;
      canvas.style.cursor = "grabbing";
      event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent) => {
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

      world.adjustCameraFollowOrbit(
        -deltaX * CAMERA_DRAG_SENSITIVITY,
        -deltaY * CAMERA_DRAG_SENSITIVITY,
      );
      event.preventDefault();
    };

    const onPointerUp = (event: PointerEvent) => {
      stopDragging(event.pointerId);
    };

    const onPointerCancel = (event: PointerEvent) => {
      stopDragging(event.pointerId);
    };

    const onLostPointerCapture = () => {
      stopDragging();
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas.addEventListener("lostpointercapture", onLostPointerCapture);

    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("lostpointercapture", onLostPointerCapture);
      canvas.style.cursor = "default";
      world.dispose();
    };
  }, [])

  const handleBoostForward = (event: MouseEvent<HTMLButtonElement>) => {
    worldRef.current?.world.controls.enqueue({
      timestamp: event.timeStamp,
      source: ControlSources.React,
      controlId: PlayerReactControls.BoostForward,
      phase: "trigger",
      payload: {
        kind: "button-click"
      }
    });
  };

  return (
    <>
      <PageLayout
        header={<Header onBoostForward={handleBoostForward} />}
        left={<LeftNav />}
        right={<RightPanel />}
        footer={<Footer />}
      >
        <Content />
      </PageLayout>
    </>
  )
  function Content() {
    return (
      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        <canvas
          ref={canvasRef}
          style={{
            flex: 1,
            width: "100%",
            height: "100%",
            display: "block",
            touchAction: "none",
            cursor: "grab",
          }}
        />
      </div>
    )
  }
}

function Header({ onBoostForward }: { onBoostForward: (event: MouseEvent<HTMLButtonElement>) => void }): ReactNode {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <span>W / S move forward and back, Q / E strafe, A / D or Left / Right turn, I / K pitch up and down, drag inside the canvas to orbit the camera, and press Space to jump.</span>
      <button type="button" onClick={onBoostForward}>
        React Boost Forward
      </button>
    </div>
  )
}
function LeftNav() {
  return (
    <div style={{ padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase" }}>
        Controls
      </div>
      <div style={{ lineHeight: 1.6, color: "#555" }}>
        Everything now falls until it lands on the floor, but floor contact alone will not trigger the orange touch
        highlight. Move forward and back with W and S, strafe with Q and E, turn with A and D or the left and right
        arrow keys, use I and K to pitch up and down, drag inside the canvas to orbit the camera, and press Space to
        jump. The React Boost Forward button in the header also feeds the same control system, so you can compare UI
        input with keyboard input.
      </div>
    </div>
  )
}

function RightPanel() {
  const [playerData, setPlayerData] = useState<Player | null>(null);
  const [playerLoc, setPlayerLoc] = useState<Position | null>(null);
  const [timeData, setTimeData] = useState<Time | null>(null);
  const [controlStates, setControlStates] = useState<ControlState[]>([]);

  useEffect(() => {
    const onTime = ({ time }: { time: Time }) => setTimeData(time);
    const onPlayer = ({ Player }: { Player: Player }) => setPlayerData(Player);
    const onPlayerLoc = ({ Player }: { Player: Position }) => { setPlayerLoc(Player) };
    const onControls = ({ controls }: { controls: ControlState[] }) => setControlStates(controls);
    eventBus.on("ui:timeMetricsUpdate", onTime);
    eventBus.on("ui:playerUpdate", onPlayer);
    eventBus.on("ui:playerUpdateLoc", onPlayerLoc);
    eventBus.on("ui:controlsUpdate", onControls);
    return () => {
      eventBus.off("ui:timeMetricsUpdate", onTime);
      eventBus.off("ui:playerUpdate", onPlayer);
      eventBus.off("ui:playerUpdateLoc", onPlayerLoc);
      eventBus.off("ui:controlsUpdate", onControls);
    };
  }, []);

  return (
    <div>
      <div>DeltaT: {Math.round(timeData?.avgDelta ?? 0)}</div>
      <div>TPS: {Math.round(timeData?.ticksPerSecond ?? 0)}</div>
      <div>Player:
        <div> Name:{playerData?.name ?? "Nope"}</div>
        <div> XP:{(Math.round((playerData?.experience ?? 0) * 100) / 100)}</div>
        <div> Level:{Math.round(playerData?.level ?? 0)}</div>
        <div> Position: {playerLoc?.x ?? 0}, {playerLoc?.y ?? 0}, {playerLoc?.z ?? 0}</div>
      </div>
      <div style={{ marginTop: 12 }}>
        <div>Controls:</div>
        {controlStates.length === 0 ? (
          <div>No controls seen yet</div>
        ) : (
          controlStates.map((controlState) => (
            <div key={controlState.key}>
              {controlState.key}: {controlState.active ? "active" : controlState.phase} for {Math.round(controlState.durationMs)}ms
            </div>
          ))
        )}
      </div>
    </div>
  )
}
function Footer() {
  return (<>Hi - I&apos;m the Footer</>)
}

