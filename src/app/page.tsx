"use client"

import { useEffect, useRef, useState } from "react"
import { setupWorld, WorldBox } from "./kikorin"
import { eventBus } from "@/packages/core/mitt"

export default function Home() {
  const worldRef = useRef<WorldBox | null>(null)
  const rafRef = useRef<number | null>(null)
  const [playerData, setPlayerData] = useState<WorldBox["world"]["components"]["Player"][number] | null>(null);
  const [timeData, setTimeData] = useState<WorldBox["time"] | null>(null);
 
  useEffect(() => {
    const world = setupWorld()
    console.log("START WORLD");
    world.start()
    worldRef.current = world
    console.log(world);

    eventBus.on("ui:timeMetricsUpdate", (value)=>{setTimeData(value.time)});
    eventBus.on("ui:playerUpdate", (value)=>{setPlayerData(value.Player)});

    return () => {
      console.log("STOP WORLD");
      world.stop()
    }
  }, [])

  return (
    <div>
      <div>DeltaT: {Math.round(timeData?.avgDelta ?? 0)}</div>
      <div>TPS: {Math.round(timeData?.ticksPerSecond ?? 0)}</div>
      <div>Player:
        <div> Name:{playerData?.name ?? "Nope"}</div>
        <div> XP:{Math.round(playerData?.experience ?? 0)}</div>
        <div> Level:{Math.round(playerData?.level ?? 0)}</div>
      </div>
    </div>
  )
}
