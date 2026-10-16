// The computer player. It looks for pots the way a player does (ghost ball: where must the cue
// ball be at contact to send the object ball at the pocket?), keeps the easiest dozen, then plays
// each one in its head a few ways (power × screw/follow) with the real physics and the real rules.
// A shot is worth: keeping the table, and how easy the next pot is from where the cue ball stops.
// Fouls cost. When nothing pots it plays safe: whatever leaves the opponent the hardest next shot.
// Levels differ in how far it looks and how straight it actually hits.

import { castBall, pathClear, type Ball, type Shot } from './physics.ts';
import { cleanShot, rulesOf, takeShot, canPlace, type Match } from './game.ts';
import { Rng } from './rng.ts';
import type { Frame, Player, Rules } from './rules/types.ts';

export type AiLevel = 'easy' | 'medium' | 'hard' | 'pro';

interface LevelSpec {
  /** Aim error, radians (one standard deviation). */
  aim: number;
  /** Power error as a fraction. */
  power: number;
  /** Pot candidates to try, and variations of each. */
  candidates: number;
  powers: number[];
  heights: number[];
  /** Noisy re-checks of the best few shots (robustness). */
  recheck: number;
  /** Cue-ball placements tried when it's in hand. */
  placements: number;
}

export const LEVELS: Record<AiLevel, LevelSpec> = {
  easy: { aim: 0.026, power: 0.14, candidates: 4, powers: [0.45], heights: [0], recheck: 0, placements: 6 },
  medium: { aim: 0.011, power: 0.08, candidates: 8, powers: [0.75, 1.15], heights: [-0.5, 0.35], recheck: 0, placements: 14 },
  hard: { aim: 0.0045, power: 0.05, candidates: 12, powers: [0.6, 0.9, 1.3], heights: [-0.7, 0, 0.5], recheck: 3, placements: 24 },
  pro: { aim: 0.0016, power: 0.03, candidates: 16, powers: [0.5, 0.75, 1.0, 1.4], heights: [-0.8, -0.3, 0.2, 0.6], recheck: 4, placements: 36 },
};

interface PotLine {
  ball: number;
  pocket: number;
  dx: number;
  dy: number;
  /** Straight-line distances cue → contact and object → pocket. */
  d1: number;
  d2: number;
  ease: number;
}

/** Every makeable pot for the player at the table, easiest first. */
export function potLines(rules: Rules, f: Frame, cueX = f.balls[0].x, cueY = f.balls[0].y): PotLine[] {
  const t = rules.table;
  const R = t.ballRadius;
  const out: PotLine[] = [];
  const on = rules.ballsOn(f);
  const balls = f.balls.map((b) => (b.id === 0 ? { ...b, x: cueX, y: cueY, on: true } : b));
  for (const id of on) {
    const b = balls[id];
    if (!b.on) continue;
    for (let p = 0; p < t.pockets.length; p++) {
      const pk = t.pockets[p];
      let ux = pk.aim.x - b.x;
      let uy = pk.aim.y - b.y;
      const d2 = Math.sqrt(ux * ux + uy * uy);
      ux /= d2;
      uy /= d2;
      // middle pockets refuse balls coming in at a shallow angle
      if (pk.kind === 'middle' && Math.abs(uy) < 0.45) continue;
      const gx = b.x - ux * 2 * R;
      const gy = b.y - uy * 2 * R;
      let wx = gx - cueX;
      let wy = gy - cueY;
      const d1 = Math.sqrt(wx * wx + wy * wy);
      if (d1 < 1e-6) continue;
      wx /= d1;
      wy /= d1;
      const cut = wx * ux + wy * uy;
      if (cut < 0.22) continue; // thinner than ~77° isn't a shot
      if (!pathClear(t, balls, b.x, b.y, pk.aim.x, pk.aim.y, [id])) continue;
      if (!pathClear(t, balls, cueX, cueY, gx, gy, [0, id])) continue;
      // the cue ball must really reach this ball first (cushions included)
      const hit = castBall(t, balls, 0, cueX, cueY, wx, wy);
      if (hit.ball !== id) continue;
      const ease = (cut * cut * cut) / ((1 + 0.6 * d1) * (1 + 1.2 * d2));
      out.push({ ball: id, pocket: p, dx: wx, dy: wy, d1, d2, ease });
    }
  }
  return out.sort((a, b) => b.ease - a.ease);
}

function bestEase(rules: Rules, f: Frame): number {
  if (f.inHand) return 0.6; // ball in hand is worth a lot
  const lines = potLines(rules, f);
  return lines.length ? lines[0].ease : 0;
}

/** How good is this outcome for `me`? */
function score(rules: Rules, before: Match, after: Match, me: Player): number {
  const f = after.frame;
  if (after.frame.over) {
    const won = f.over!.winner === me;
    return won ? 100 : -100;
  }
  let s = 0;
  if (f.foul) s -= 2 + (rules.id === 'snooker' ? (f.points[1 - me] - before.frame.points[1 - me]) * 0.15 : 0);
  if (rules.id === 'snooker') s += (f.points[me] - before.frame.points[me]) * 0.12;
  if (f.turn === me) {
    s += 1.5 + 3 * bestEase(rules, f);
  } else {
    s -= 2.5 * bestEase(rules, f);
    // pool: having more of your own balls down is good even if you missed
  }
  return s;
}

function rotate(dx: number, dy: number, a: number): [number, number] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  return [dx * c - dy * s, dx * s + dy * c];
}

function gauss(rng: Rng): number {
  // Box-Muller (the AI's misses don't need to be bit-exact anywhere)
  const u = 1 - rng.next();
  const v = rng.next();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function evaluate(m: Match, shot: Shot, me: Player): number {
  const { match } = takeShot(m, cleanShot(shot));
  return score(rulesOf(m), m, match, me);
}

function noisy(shot: Shot, spec: LevelSpec, rng: Rng): Shot {
  const [dx, dy] = rotate(shot.dx, shot.dy, gauss(rng) * spec.aim);
  const power = Math.min(1, Math.max(0.02, shot.power * (1 + gauss(rng) * spec.power)));
  return { ...shot, dx, dy, power };
}

/** Power that sends the cue ball about `dist` metres then the object ball on: a rough feel. */
function feel(rules: Rules, d1: number, d2: number, k: number): number {
  const need = (d1 + d2 * 1.8 + 0.25) / rules.table.length;
  return Math.min(1, Math.max(0.12, Math.sqrt(need) * 0.55 * k));
}

interface Candidate {
  shot: Shot;
  value: number;
}

function searchFrom(m: Match, spec: LevelSpec, me: Player, place?: { x: number; y: number }): Candidate[] {
  const rules = rulesOf(m);
  const f = m.frame;
  const cx = place ? place.x : f.balls[0].x;
  const cy = place ? place.y : f.balls[0].y;
  const lines = potLines(rules, f, cx, cy).slice(0, spec.candidates);
  const out: Candidate[] = [];
  for (const line of lines) {
    for (const k of spec.powers) {
      for (const height of spec.heights) {
        const shot: Shot = { dx: line.dx, dy: line.dy, power: feel(rules, line.d1, line.d2, k), side: 0, height, place };
        out.push({ shot, value: evaluate(m, shot, me) });
      }
    }
  }
  return out;
}

/** Safety (or escaping a snooker): aim at balls on, thick and thin, soft and firm; plus kicks. */
function safeties(m: Match, spec: LevelSpec, me: Player, rng: Rng, place?: { x: number; y: number }): Candidate[] {
  const rules = rulesOf(m);
  const f = m.frame;
  const R = rules.table.ballRadius;
  const cx = place ? place.x : f.balls[0].x;
  const cy = place ? place.y : f.balls[0].y;
  const on = rules.ballsOn(f);
  const out: Candidate[] = [];
  const targets = on.slice().sort(() => rng.next() - 0.5).slice(0, 6);
  const cuts = spec.candidates >= 12 ? [-0.9, -0.5, 0, 0.5, 0.9] : [-0.6, 0, 0.6];
  for (const id of targets) {
    const b = f.balls[id];
    const dx = b.x - cx;
    const dy = b.y - cy;
    const d = Math.sqrt(dx * dx + dy * dy);
    for (const cut of cuts) {
      // offset the aim so contact is `cut` of the way from full to the thinnest edge
      const [ax, ay] = rotate(dx / d, dy / d, Math.asin(Math.min(0.99, (cut * 2 * R) / d)));
      for (const power of [0.18, 0.32, 0.5]) {
        const shot: Shot = { dx: ax, dy: ay, power, side: 0, height: 0, place };
        out.push({ shot, value: evaluate(m, shot, me) });
      }
    }
  }
  // kicks off the cushions for when every ball on is hidden
  for (let i = 0; i < (spec.candidates >= 12 ? 24 : 12); i++) {
    const a = rng.next() * Math.PI * 2;
    const shot: Shot = { dx: Math.cos(a), dy: Math.sin(a), power: 0.3 + rng.next() * 0.4, side: 0, height: 0, place };
    out.push({ shot, value: evaluate(m, shot, me) });
  }
  return out;
}

function breakShot(m: Match, rng: Rng): Shot {
  const rules = rulesOf(m);
  const f = m.frame;
  const t = rules.table;
  if (rules.id === 'snooker') {
    // the standard break-off: from beside the yellow, clip the back red of the pack thin
    const place = { x: t.baulkX, y: -t.dRadius * 0.55 };
    const backRed = f.balls.filter((b) => b.id >= 11 && b.id <= 15).sort((a, b) => a.y - b.y)[0];
    const tx = backRed.x + t.ballRadius * 0.15;
    const ty = backRed.y - t.ballRadius * 1.6;
    const dx = tx - place.x;
    const dy = ty - place.y;
    const l = Math.sqrt(dx * dx + dy * dy);
    return { dx: dx / l, dy: dy / l, power: 0.42 + rng.next() * 0.04, side: 0.6, height: 0, place };
  }
  const place = { x: t.baulkX - 0.08, y: (rng.next() - 0.5) * 0.12 };
  const apex = f.balls.filter((b) => b.id !== 0).sort((a, b) => a.x - b.x)[0];
  const dx = apex.x - place.x;
  const dy = apex.y - place.y + (rng.next() - 0.5) * 0.004;
  const l = Math.sqrt(dx * dx + dy * dy);
  return { dx: dx / l, dy: dy / l, power: 0.96, side: 0, height: -0.15, place };
}

/** Places worth trying for the cue ball: around each easy pot's ghost ball, and a grid. */
function placements(m: Match, spec: LevelSpec, rng: Rng): { x: number; y: number }[] {
  const rules = rulesOf(m);
  const t = rules.table;
  const out: { x: number; y: number }[] = [];
  const zone = m.frame.inHand!;
  for (let i = 0; i < spec.placements * 6 && out.length < spec.placements; i++) {
    const x = zone === 'anywhere' ? (rng.next() - 0.5) * (t.length - 4 * t.ballRadius) : zone === 'd' ? t.baulkX - rng.next() * t.dRadius : -t.length / 2 + t.ballRadius * 2 + rng.next() * (t.baulkX + t.length / 2 - 2 * t.ballRadius);
    const y = zone === 'd' ? (rng.next() - 0.5) * 2 * t.dRadius : (rng.next() - 0.5) * (t.width - 4 * t.ballRadius);
    if (canPlace(m, x, y)) out.push({ x, y });
  }
  if (zone === 'anywhere') {
    // a straight-ish pot on each ball on, from a comfortable distance
    for (const id of rules.ballsOn(m.frame)) {
      const b = m.frame.balls[id];
      for (const pk of t.pockets) {
        const ux = pk.aim.x - b.x;
        const uy = pk.aim.y - b.y;
        const l = Math.sqrt(ux * ux + uy * uy);
        const x = b.x - (ux / l) * 0.35;
        const y = b.y - (uy / l) * 0.35 + 0.04;
        if (canPlace(m, x, y)) out.push({ x, y });
      }
    }
  }
  // rank by how easy the best pot is from there, keep the best
  return out
    .map((p) => ({ p, e: potLines(rules, m.frame, p.x, p.y)[0]?.ease ?? 0 }))
    .sort((a, b) => b.e - a.e)
    .slice(0, Math.max(3, Math.ceil(spec.placements / 4)))
    .map((x) => x.p);
}

/** Decide the computer's shot. Pure: the same match, level and seed give the same shot. */
export function chooseShot(m: Match, level: AiLevel, seed: number): Shot {
  const spec = LEVELS[level];
  const rng = new Rng(seed);
  const me = m.frame.turn;
  const rules = rulesOf(m);
  if (m.frame.shots === 0) return cleanShot(noisy(breakShot(m, rng), spec, rng));

  let cands: Candidate[] = [];
  const spots = m.frame.inHand ? placements(m, spec, rng) : [undefined];
  for (const place of spots) cands.push(...searchFrom(m, spec, me, place));
  cands.sort((a, b) => b.value - a.value);
  if (!cands.length || cands[0].value < 1.4) {
    for (const place of spots.slice(0, 2)) cands.push(...safeties(m, spec, me, rng, place));
    cands.sort((a, b) => b.value - a.value);
  }
  if (!cands.length) {
    // nothing at all: hit the nearest ball on
    const c = m.frame.balls[0];
    const b = rules.ballsOn(m.frame).map((id) => m.frame.balls[id]).sort((p, q) => dist(c, p) - dist(c, q))[0];
    const place = m.frame.inHand ? placements(m, spec, rng)[0] : undefined;
    const from = place ?? c;
    return cleanShot({ dx: b.x - from.x, dy: b.y - from.y, power: 0.4, side: 0, height: 0, place });
  }
  // robustness: replay the best few with this level's own unsteadiness and keep the safest bet
  if (spec.recheck > 0) {
    const top = cands.slice(0, 4);
    for (const c of top) {
      let sum = c.value;
      for (let i = 0; i < spec.recheck; i++) sum += evaluate(m, noisy(c.shot, spec, rng), me);
      c.value = sum / (spec.recheck + 1);
    }
    top.sort((a, b) => b.value - a.value);
    cands = top;
  }
  return cleanShot(noisy(cands[0].shot, spec, rng));
}

function dist(a: Ball, b: Ball): number {
  return Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
}
