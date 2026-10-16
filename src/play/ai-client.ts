// The computer player runs in a Web Worker so the table keeps animating while it thinks.

import type { AiLevel } from '../sim/ai.ts';
import type { Match } from '../sim/game.ts';
import type { Shot } from '../sim/physics.ts';

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, (s: Shot) => void>();

export function think(match: Match, level: AiLevel, seed: number): Promise<Shot> {
  if (!worker) {
    worker = new Worker(new URL('./ai.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<{ id: number; shot: Shot }>) => {
      pending.get(e.data.id)?.(e.data.shot);
      pending.delete(e.data.id);
    };
  }
  const id = nextId++;
  return new Promise((res) => {
    pending.set(id, res);
    worker!.postMessage({ id, match, level, seed });
  });
}
