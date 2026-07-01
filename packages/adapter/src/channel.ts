/**
 * Minimal pub/sub channel compatible with React's useSyncExternalStore.
 * subscribe() returns an unsubscribe function; getSnapshot() returns the current value.
 */
export class Channel<T> {
  private value: T;
  private listeners = new Set<() => void>();

  constructor(initial: T) {
    this.value = initial;
    // Bind so callers can use these as bare function references in useSyncExternalStore
    this.subscribe = this.subscribe.bind(this);
    this.getSnapshot = this.getSnapshot.bind(this);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getSnapshot(): T {
    return this.value;
  }

  emit(value: T): void {
    this.value = value;
    for (const listener of this.listeners) {
      listener();
    }
  }
}
