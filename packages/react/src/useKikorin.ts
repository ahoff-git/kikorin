import { setupCoreWorld } from '@kikorin/engine'
import type { CoreWorldBox } from '@kikorin/engine'
import { type RefObject, useEffect, useState } from 'react'

export interface UseKikorinOptions {
  maxEntities?: number
  worldTickRate?: number
  /** Default: true */
  autoStart?: boolean
}

/**
 * Attach the kikorin engine to an existing canvas element.
 *
 * Returns null until the canvas mounts and the engine is ready.
 * The engine is disposed automatically when the component unmounts.
 *
 * @example
 * const canvasRef = useRef<HTMLCanvasElement>(null)
 * const engine = useKikorin(canvasRef)
 * useEffect(() => {
 *   if (!engine) return
 *   const eid = engine.spawnEntity({ position: { x:0, y:0, z:0 }, gravity: true })
 *   return () => engine.destroyEntity(eid)
 * }, [engine])
 * return <canvas ref={canvasRef} />
 */
export function useKikorin(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  options?: UseKikorinOptions,
): CoreWorldBox | null {
  const [box, setBox] = useState<CoreWorldBox | null>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const newBox = setupCoreWorld({
      canvas,
      maxEntities: options?.maxEntities,
      worldTickRate: options?.worldTickRate,
    })

    if (options?.autoStart !== false) newBox.start()

    setBox(newBox)

    return () => {
      newBox.dispose()
      setBox(null)
    }
    // options are mount-time config — intentionally not in deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return box
}
