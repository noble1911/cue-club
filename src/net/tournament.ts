// Knockout brackets. Players are shuffled into a bracket the size of the next power of two; the
// spare places are byes, at most one per first-round match, so nobody meets an empty chair twice.
// DOM-free: the server keeps the bracket, the browsers draw it.

import type { Rng } from '../sim/rng.ts';

export interface BracketMatch {
  /** "r<round>m<index>", also the id of the live match while it's played. */
  id: string;
  seats: [string | null, string | null];
  winner: string | null;
  /** A bye: one seat stays empty and the other goes through. */
  bye: boolean;
}

export interface Bracket {
  rounds: BracketMatch[][];
}

export function makeBracket(players: string[], rng: Rng): Bracket {
  const n = players.length;
  if (n < 2) throw new Error('a bracket needs two players');
  let size = 2;
  while (size < n) size *= 2;
  const order = rng.shuffle(players.slice());
  const byes = size - n;
  const first: BracketMatch[] = [];
  // byes spread evenly: every other first-round match from the top gets one
  const byeSlots = new Set<number>();
  const step = size / 2 / Math.max(1, byes);
  for (let i = 0; i < byes; i++) byeSlots.add(Math.floor(i * step));
  let k = 0;
  for (let i = 0; i < size / 2; i++) {
    const a = order[k++];
    const b = byeSlots.has(i) ? null : order[k++];
    first.push({ id: `r0m${i}`, seats: [a, b], winner: b === null ? a : null, bye: b === null });
  }
  const rounds: BracketMatch[][] = [first];
  for (let r = 1, count = size / 4; count >= 1; r++, count /= 2) {
    rounds.push(Array.from({ length: count }, (_, i) => ({ id: `r${r}m${i}`, seats: [null, null] as [string | null, string | null], winner: null, bye: false })));
  }
  const b: Bracket = { rounds };
  for (const m of first) if (m.winner) carry(b, 0, first.indexOf(m), m.winner);
  return b;
}

function carry(b: Bracket, round: number, index: number, winner: string): void {
  const nextRound = b.rounds[round + 1];
  if (!nextRound) return;
  nextRound[index >> 1].seats[index & 1] = winner;
}

export function findMatch(b: Bracket, id: string): { round: number; index: number; m: BracketMatch } | null {
  for (let r = 0; r < b.rounds.length; r++) {
    const i = b.rounds[r].findIndex((m) => m.id === id);
    if (i >= 0) return { round: r, index: i, m: b.rounds[r][i] };
  }
  return null;
}

/** Record a result and move the winner on. */
export function recordWinner(b: Bracket, id: string, winner: string): void {
  const found = findMatch(b, id);
  if (!found || found.m.winner) return;
  found.m.winner = winner;
  carry(b, found.round, found.index, winner);
}

/** Matches with both players known and no result yet. */
export function playable(b: Bracket): BracketMatch[] {
  return b.rounds.flat().filter((m) => !m.winner && m.seats[0] !== null && m.seats[1] !== null);
}

export function champion(b: Bracket): string | null {
  return b.rounds[b.rounds.length - 1][0].winner;
}

export function roundName(b: Bracket, round: number): string {
  const fromEnd = b.rounds.length - 1 - round;
  return fromEnd === 0 ? 'Final' : fromEnd === 1 ? 'Semi-finals' : fromEnd === 2 ? 'Quarter-finals' : `Round ${round + 1}`;
}
