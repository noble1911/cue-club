// The computer player runs in a Web Worker so the table keeps animating while it thinks.

import type { AiLevel } from '../sim/ai.ts';
import type { Match } from '../sim/game.ts';
import type { Shot } from '../sim/physics.ts';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { res: (s: Shot) => void; rej: (e: unknown) => void; timer: ReturnType<typeof setTimeout> }>();

/** The worker broke: fail everything waiting on it and start a fresh one next time. */
function failAll(why: unknown): void {
  for (const p of pending.values()) {
    clearTimeout(p.timer);
    p.rej(why);
  }
  pending.clear();
  worker?.terminate();
  worker = null;
}

export function think(match: Match, level: AiLevel, seed: number): Promise<Shot> {
  if (!worker) {
    worker = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; shot: Shot }>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(e.data.id);
      p.res(e.data.shot);
    };
    worker.onerror = (e) => failAll(e.message || 'worker error');
    worker.onmessageerror = () => failAll('worker message error');
  }
  const id = nextId++;
  return new Promise((res, rej) => {
    // the computer never takes this long: something's wrong, let the caller fall back
    const timer = setTimeout(() => {
      pending.delete(id);
      rej(new Error('computer player timed out'));
    }, 20_000);
    pending.set(id, { res, rej, timer });
    worker!.postMessage({ id, match, level, seed });
  });
}
