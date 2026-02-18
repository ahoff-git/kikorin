"use client"
import { ReactNode, useEffect, useRef, useState } from "react"
import { setupWorld, WorldBox } from "./kikorin"
import { PageLayout } from "./kikorinLayout";
import { eventBus } from "@/packages/core/mitt";
import { Player, Position, Time } from "@/packages/core/types";

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
      world.stop();
    };
  }, [])

  return (
    <>
      <PageLayout
        header={<Header />}
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

function Header(): ReactNode {
  return (<>Hi - I'm the Header</>)
}
function LeftNav() {
  return (<>Hi - I'm the LeftNav</>)
}

function RightPanel() {
  const [playerData, setPlayerData] = useState<Player | null>(null);
  const [playerLoc, setPlayerLoc] = useState<Position | null>(null);
  const [timeData, setTimeData] = useState<Time | null>(null);

  useEffect(() => {
    const onTime = (v: any) => setTimeData(v.time);
    const onPlayer = (v: any) => setPlayerData(v.Player);
    const onPlayerLoc = (v: any) => { setPlayerLoc(v.Player) };
    eventBus.on("ui:timeMetricsUpdate", onTime);
    eventBus.on("ui:playerUpdate", onPlayer);
    eventBus.on("ui:playerUpdateLoc", onPlayerLoc);
    return () => {
      eventBus.off("ui:timeMetricsUpdate", onTime);
      eventBus.off("ui:playerUpdate", onPlayer);
      eventBus.off("ui:playerUpdateLoc", onPlayerLoc);
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
    </div>
  )
}
function Footer() {
  return (<>Hi - I'm the Footer</>)
}

