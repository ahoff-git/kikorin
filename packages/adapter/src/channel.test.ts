import { describe, expect, it } from 'vitest';
import { Channel } from './channel';

describe('Channel', () => {
  it('delivers emitted values to all subscribers', () => {
    const ch = new Channel<number[]>([]);
    const log: number[][] = [];
    const unsub = ch.subscribe(() => log.push(ch.getSnapshot()));

    ch.emit([1, 2]);
    ch.emit([3, 4]);

    expect(log).toEqual([[1, 2], [3, 4]]);
    unsub();
    ch.emit([99]);
    expect(log).toHaveLength(2);
  });

  it('getSnapshot returns initial value before any emission', () => {
    const ch = new Channel<string>('hello');
    expect(ch.getSnapshot()).toBe('hello');
  });

  it('delivers to every subscriber, and unsubscribing one leaves the others live', () => {
    const ch = new Channel<number>(0);
    const seenA: number[] = [];
    const seenB: number[] = [];
    const unsubA = ch.subscribe(() => seenA.push(ch.getSnapshot()));
    ch.subscribe(() => seenB.push(ch.getSnapshot()));

    ch.emit(1);
    unsubA();
    ch.emit(2);

    expect(seenA).toEqual([1]);
    expect(seenB).toEqual([1, 2]);
  });
});
