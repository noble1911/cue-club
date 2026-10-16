import { chooseShot, type AiLevel } from '../sim/ai.ts';
import type { Match } from '../sim/game.ts';

self.onmessage = (e: MessageEvent<{ id: number; match: Match; level: AiLevel; seed: number }>) => {
  const { id, match, level, seed } = e.data;
  const shot = chooseShot(match, level, seed);
  (self as unknown as Worker).postMessage({ id, shot });
};
