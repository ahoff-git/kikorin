import { eventBus } from '@kikorin/events'
import type { EventBusEvents } from '@kikorin/events'
import { useEffect, useRef } from 'react'

/**
 * Subscribe to a kikorin event bus event.
 *
 * Safe to use with inline handlers — the latest handler is always called
 * without the subscription being torn down and re-created on every render.
 *
 * @example
 * useKikorinEvent('ui:healthChange', ({ health }) => setHealth(health))
 */
export function useKikorinEvent<K extends keyof EventBusEvents>(
  event: K,
  handler: (data: EventBusEvents[K]) => void,
): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler

  useEffect(() => {
    const stable = (data: EventBusEvents[K]) => handlerRef.current(data)
    eventBus.on(event, stable)
    return () => eventBus.off(event, stable)
  }, [event])
}
