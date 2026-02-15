"use client"

import { useEffect, useRef, useState } from "react"
import { setupWorld, WorldBox } from "./kikorin"

export default function Home() {
  const worldRef = useRef<WorldBox | null>(null)
  const rafRef = useRef<number | null>(null)
  const [dt, setDT] = useState<number>(0);
  const [player, setPlayer] = useState<WorldBox["world"]["components"]["Player"][number] | null>(null);

  useEffect(() => {
    const world = setupWorld()
    console.log("START WORLD");
    world.start()
    worldRef.current = world
    console.log(world);

    const tick = () => {
      const w = worldRef.current
      if (w) {
        setDT(w.world.time.delta) // or w.world.time.elapsed etc
        setPlayer(w.world.components.Player[1] ?? null)
      }
      rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)

    return () => {
      console.log("STOP WORLD");
      world.stop()
    }
  }, [])

  return (
    <div>
      <div>DeltaT: {Math.round(dt ?? 0)}</div>
      <div>Player:
        <div> Name:{player?.name ?? "Nope"}</div>
        <div> XP:{Math.round(player?.experience ?? 0)}</div>
        <div> Level:{Math.round(player?.level ?? 0)}</div>
      </div>
    </div>
  )
}
