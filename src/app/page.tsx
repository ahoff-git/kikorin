"use client"
import { MouseEvent, ReactNode, useEffect, useRef, useState } from "react"
import { setupWorld, WorldBox } from "./kikorin"
import { PlayerReactControls } from "./kikorinControls";
import { PageLayout } from "./kikorinLayout";
import { eventBus } from "@/packages/core/mitt";
import { ControlSources, ControlState, Player, Position, Time } from "@/packages/core/types";

export default function Home() {
  console.log("render");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const worldRef = useRef<WorldBox | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current!;
    canvas.width = canvas.clientWidth;
    canvas.height = canvas.clientHeight;
    const world = setupWorld(canvas)
    console.log("START WORLD");
    world.start()
    worldRef.current = world
    console.log(world);
    return () => {
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
          }}
        />
      </div>
    )
  }
}

function Header({ onBoostForward }: { onBoostForward: (event: MouseEvent<HTMLButtonElement>) => void }): ReactNode {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
      <span>WASD / Arrow keys build momentum. I / K pitch up and down. Click the canvas to hop.</span>
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
        Move with WASD or the arrow keys, use I and K to pitch up and down, and click inside the canvas to hop.
        The React Boost Forward button in the header also feeds the same control system, so you can compare UI
        input with keyboard and pointer input.
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
    const onTime = (v: any) => setTimeData(v.time);
    const onPlayer = (v: any) => setPlayerData(v.Player);
    const onPlayerLoc = (v: any) => { setPlayerLoc(v.Player) };
    const onControls = (v: any) => setControlStates(v.controls);
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
  return (<>Hi - I'm the Footer</>)
}

