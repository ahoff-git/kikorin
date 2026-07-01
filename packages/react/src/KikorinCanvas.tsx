// TODO: KikorinCanvas previously bootstrapped the TypeScript ECS engine (@kikorin/engine).
// That package was removed. Game logic now runs in the Rust WASM engine (crates/engine).

import { type CSSProperties } from 'react'

export interface KikorinCanvasProps {
  className?: string
  style?: CSSProperties
  width?: number | string
  height?: number | string
  maxEntities?: number
  worldTickRate?: number
  onReady?: () => void
}

export function KikorinCanvas({ onReady: _onReady, ...canvasProps }: KikorinCanvasProps) {
  return <canvas {...canvasProps} />
}
