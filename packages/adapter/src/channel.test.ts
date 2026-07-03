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
});
