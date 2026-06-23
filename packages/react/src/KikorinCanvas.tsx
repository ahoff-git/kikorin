import { setupCoreWorld } from '@kikorin/engine'
import type { CoreWorldBox } from '@kikorin/engine'
import { type CSSProperties, useEffect, useRef } from 'react'

export interface KikorinCanvasProps {
  className?: string
  style?: CSSProperties
  width?: number | string
  height?: number | string
  maxEntities?: number
  worldTickRate?: number
  /**
   * Called once when the engine is ready. Receives the engine instance.
   * Optionally return a cleanup function that runs before the engine is disposed.
   *
   * @example
   * onReady={(engine) => {
   *   const floor = spawnFloor(engine)
   *   const player = spawnPlayer(engine, { position: { x: 0, y: 2, z: 0 } })
   *   engine.setCameraFollowTarget(player)
   *   return () => {
   *     engine.destroyEntity(floor)
   *     engine.destroyEntity(player)
   *   }
   * }}
   */
  onReady?: (engine: CoreWorldBox) => (() => void) | void
}

/**
 * Drop-in canvas component that spins up the kikorin engine automatically.
 * The engine starts when the canvas mounts and is disposed on unmount.
 *
 * @example
 * <KikorinCanvas
 *   style={{ width: '100%', height: '100vh' }}
 *   onReady={(engine) => {
 *     spawnFloor(engine)
 *     const player = spawnPlayer(engine)
 *     engine.setCameraFollowTarget(player)
 *   }}
 * />
 */
export function KikorinCanvas({
  onReady,
  maxEntities,
  worldTickRate,
  ...canvasProps
}: KikorinCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  // onReady is a mount-time callback — capture once, don't track as reactive dep
  const onReadyRef = useRef(onReady)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const box = setupCoreWorld({ canvas, maxEntities, worldTickRate })
    box.start()

    const userCleanup = onReadyRef.current?.(box)

    return () => {
      if (typeof userCleanup === 'function') userCleanup()
      box.dispose()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return <canvas ref={canvasRef} {...canvasProps} />
}
