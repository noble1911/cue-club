// What every variant's rules share. A Frame is the whole state of a frame in progress: plain JSON,
// so the server can send it and a reloading browser can pick it up. Messages say "@0" and "@1"
// for the two players; the UI swaps in their names.

import type { Ball, ShotSummary } from '../physics.ts';
import type { Rng } from '../rng.ts';
import type { TableSpec, Vec } from '../tables.ts';

export type VariantId = 'uk8' | 'us8' | 'nine' | 'snooker';

/** Where the cue ball may be placed when it's in hand. */
export type Zone = 'd' | 'baulk' | 'anywhere';

export type Player = 0 | 1;

export interface Frame {
  balls: Ball[];
  turn: Player;
  /** The cue ball is in hand (and must be placed in this zone) before the next shot. */
  inHand: Zone | null;
  /** Snooker scores (pool leaves them at 0). */
  points: [number, number];
  /** The current break in snooker. */
  brk: number;
  /** The variant's own state (groups, visits, phase …). */
  rule: any;
  over: null | { winner: Player; reason: string };
  /** Shots played this frame; the first one is the break. */
  shots: number;
  /** What just happened, for the HUD. */
  message: string;
  foul: boolean;
}

export interface BallLook {
  color: string;
  number?: number;
  stripe?: boolean;
  name: string;
}

export interface Rules {
  id: VariantId;
  name: string;
  /** One line for the menu. */
  blurb: string;
  table: TableSpec;
  looks: BallLook[];
  /** The rack, cue ball (id 0) placed in the break zone. */
  rack(rng: Rng): Ball[];
  initRule(): any;
  breakZone: Zone;
  /** Balls the shooter may hit first (every object ball when it's empty). */
  ballsOn(f: Frame): number[];
  /** "Reds", "Yellows", "Lowest: 3", "Red" … what the shooter is on. */
  onText(f: Frame, p: Player): string;
  /** After the balls stop: who's next, fouls, scores, the end of the frame. */
  judge(f: Frame, after: Ball[], s: ShotSummary, rng: Rng): Frame;
}

export function ballAt(id: number, x: number, y: number): Ball {
  return { id, x, y, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, on: true };
}

/** Triangle (or diamond) rows going up the table from the apex at (x, y). */
export function rackPositions(t: TableSpec, apex: Vec, rows: number[]): Vec[] {
  const R = t.ballRadius;
  const gap = 0.00012; // a hair apart so the break travels through the pack
  const d = 2 * R + gap;
  const out: Vec[] = [];
  rows.forEach((count, i) => {
    for (let j = 0; j < count; j++) out.push({ x: apex.x + i * d * 0.8660254037844386, y: apex.y + (j - (count - 1) / 2) * d });
  });
  return out;
}

export function zoneContains(t: TableSpec, zone: Zone, x: number, y: number): boolean {
  const R = t.ballRadius;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
  if (Math.abs(x) > t.length / 2 - R || Math.abs(y) > t.width / 2 - R) return false;
  // not where it would drop at once, nor touching a pocket jaw (in a pocket's mouth)
  for (const p of t.pockets) if ((x - p.x) ** 2 + (y - p.y) ** 2 < (p.r + R * 0.5) ** 2) return false;
  for (const s of t.cushions) {
    const ex = s.bx - s.ax;
    const ey = s.by - s.ay;
    const k = Math.max(0, Math.min(1, ((x - s.ax) * ex + (y - s.ay) * ey) / (ex * ex + ey * ey)));
    if ((x - s.ax - ex * k) ** 2 + (y - s.ay - ey * k) ** 2 < R * R) return false;
  }
  if (zone === 'anywhere') return true;
  if (x > t.baulkX) return false;
  if (zone === 'd') return (x - t.baulkX) * (x - t.baulkX) + y * y <= t.dRadius * t.dRadius;
  return true;
}

export function spotFree(t: TableSpec, balls: readonly Ball[], x: number, y: number, ignore = -1): boolean {
  const d = 2 * t.ballRadius + 0.0005;
  return balls.every((b) => !b.on || b.id === ignore || (b.x - x) * (b.x - x) + (b.y - y) * (b.y - y) >= d * d);
}

/**
 * Put ball `id` back: on the first free spot in `spots`, else as near as possible to the first
 * spot going up the table (towards the top cushion), else down it.
 */
export function respot(t: TableSpec, balls: Ball[], id: number, spots: Vec[]): void {
  const b = balls[id];
  const place = (x: number, y: number) => {
    Object.assign(b, { x, y, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, on: true });
  };
  for (const s of spots) {
    if (spotFree(t, balls, s.x, s.y, id)) return place(s.x, s.y);
  }
  const home = spots[0];
  const step = t.ballRadius / 8;
  for (let x = home.x; x < t.length / 2 - t.ballRadius; x += step) if (spotFree(t, balls, x, home.y, id)) return place(x, home.y);
  for (let x = home.x; x > -t.length / 2 + t.ballRadius; x -= step) if (spotFree(t, balls, x, home.y, id)) return place(x, home.y);
  place(home.x, home.y);
}

export function otherPlayer(p: Player): Player {
  return p === 0 ? 1 : 0;
}

/** The frame after a shot, carrying the balls over; callers fill in the rest. */
export function next(f: Frame, after: Ball[], patch: Partial<Frame>): Frame {
  return { ...f, balls: after, shots: f.shots + 1, inHand: null, foul: false, ...patch };
}
