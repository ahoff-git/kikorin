"use client"
import { ReactNode, useEffect, useRef, useState } from "react"
import { setupWorld, WorldBox } from "./kikorin"
import { PageLayout } from "./kikorinLayout";
import { eventBus } from "@/packages/core/mitt";

export default function Home() {
  console.log("render");
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const worldRef = useRef<WorldBox | null>(null)
  const [playerData, setPlayerData] = useState<WorldBox["world"]["components"]["Player"][number] | null>(null);
  const [timeData, setTimeData] = useState<WorldBox["world"]["time"] | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
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
      <div>
        Before<canvas ref={canvasRef} style={{ maxWidth: "100%", display: "block" }} />After
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
  const [playerData, setPlayerData] = useState<any>(null);
  const [timeData, setTimeData] = useState<any>(null);

  useEffect(() => {
    const onTime = (v: any) => setTimeData(v.time);
    const onPlayer = (v: any) => setPlayerData(v.Player);
    eventBus.on("ui:timeMetricsUpdate", onTime);
    eventBus.on("ui:playerUpdate", onPlayer);
    return () => {
      eventBus.off("ui:timeMetricsUpdate", onTime);
      eventBus.off("ui:playerUpdate", onPlayer);
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
      </div>
    </div>
  )
}
function Footer() {
  return (<>Hi - I'm the Footer</>)
}

