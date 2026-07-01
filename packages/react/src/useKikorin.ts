// TODO: The TypeScript ECS engine (setupCoreWorld from @kikorin/engine) was removed.
// useKikorin is kept for API compatibility but always returns null.
// Game logic now runs in the Rust WASM engine (crates/engine).

import { type RefObject } from 'react'

export interface UseKikorinOptions {
  maxEntities?: number
  worldTickRate?: number
  autoStart?: boolean
}

export function useKikorin(
  _canvasRef: RefObject<HTMLCanvasElement | null>,
  _options?: UseKikorinOptions,
): null {
  return null
}
