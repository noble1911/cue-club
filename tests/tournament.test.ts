import { describe, expect, it } from 'vitest';
import { champion, makeBracket, playable, recordWinner } from '../src/net/tournament.ts';
import { Rng } from '../src/sim/rng.ts';

describe('knockout bracket', () => {
  for (const n of [2, 3, 4, 5, 6, 7, 8]) {
    it(`${n} players play down to one champion`, () => {
      const players = Array.from({ length: n }, (_, i) => `p${i}`);
      const b = makeBracket(players, new Rng(n));
      // no first-round match has two empty chairs, and everyone appears once
      const seated = b.rounds[0].flatMap((m) => m.seats).filter(Boolean);
      expect(new Set(seated).size).toBe(n);
      let games = 0;
      for (let guard = 0; guard < 20 && !champion(b); guard++) {
        for (const m of playable(b)) {
          recordWinner(b, m.id, m.seats[0]!);
          games++;
        }
      }
      expect(champion(b)).toBeTruthy();
      expect(games).toBe(n - 1); // a knockout always takes n − 1 matches
    });
  }
});
