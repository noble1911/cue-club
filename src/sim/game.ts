// A match: frames of one variant, first to `raceTo` frames. Plain JSON all the way down, and the
// only way to change it is takeShot / concede / nextFrame, which the browsers (local play) and the
// server (online) call alike. Randomness (racks, coin tosses) comes from the match seed, so a
// match replays exactly.

import { simulate, summarise, type Shot, type SimResult } from './physics.ts';
import { Rng } from './rng.ts';
import { NINE } from './rules/nine.ts';
import { SNOOKER_RULES } from './rules/snooker.ts';
import { type Frame, type Player, type Rules, type VariantId, otherPlayer, spotFree, zoneContains } from './rules/types.ts';
import { UK8 } from './rules/uk8.ts';
import { US8 } from './rules/us8.ts';

export const VARIANTS: Record<VariantId, Rules> = { uk8: UK8, us8: US8, nine: NINE, snooker: SNOOKER_RULES };
export const VARIANT_IDS: VariantId[] = ['uk8', 'us8', 'nine', 'snooker'];

export interface MatchSetup {
  variant: VariantId;
  /** First to this many frames wins. */
  raceTo: number;
  names: [string, string];
  seed: number;
}

export interface Match {
  setup: MatchSetup;
  frame: Frame;
  /** 1-based. */
  frameNo: number;
  wins: [number, number];
  /** Who broke this frame. */
  breaker: Player;
  winner: Player | null;
}

const rngFor = (m: Pick<Match, 'setup' | 'frameNo'>, shots: number) => new Rng((m.setup.seed ^ Math.imul(m.frameNo, 0x9e3779b1) ^ Math.imul(shots + 1, 0x85ebca6b)) >>> 0);

export function rulesOf(m: Match): Rules {
  return VARIANTS[m.setup.variant];
}

function freshFrame(rules: Rules, rng: Rng, breaker: Player): Frame {
  return {
    balls: rules.rack(rng),
    turn: breaker,
    inHand: rules.breakZone,
    points: [0, 0],
    brk: 0,
    rule: rules.initRule(),
    over: null,
    shots: 0,
    message: `@${breaker} to break`,
    foul: false,
  };
}

export function newMatch(setup: MatchSetup): Match {
  const rules = VARIANTS[setup.variant];
  const breaker: Player = new Rng(setup.seed).next() < 0.5 ? 0 : 1;
  const m: Match = { setup, frameNo: 1, wins: [0, 0], breaker, winner: null, frame: null as unknown as Frame };
  m.frame = freshFrame(rules, rngFor(m, -1), breaker);
  return m;
}

/** Can the cue ball go at (x, y) right now? */
export function canPlace(m: Match, x: number, y: number): boolean {
  const f = m.frame;
  if (!f.inHand) return false;
  const rules = rulesOf(m);
  return zoneContains(rules.table, f.inHand, x, y) && spotFree(rules.table, f.balls, x, y, 0);
}

/** Why a shot can't be played, or null. */
export function checkShot(m: Match, shot: Shot): string | null {
  if (m.winner !== null || m.frame.over) return 'the frame is over';
  for (const k of ['dx', 'dy', 'power', 'side', 'height'] as const) if (typeof shot[k] !== 'number' || !Number.isFinite(shot[k])) return `bad ${k}`;
  if (Math.abs(shot.dx) > 10 || Math.abs(shot.dy) > 10 || shot.dx * shot.dx + shot.dy * shot.dy < 0.25) return 'no direction';
  if (shot.power < 0 || shot.power > 1 || Math.abs(shot.side) > 1 || Math.abs(shot.height) > 1) return 'out of range';
  if (m.frame.inHand) {
    if (!shot.place) return 'place the cue ball first';
    if (!canPlace(m, shot.place.x, shot.place.y)) return 'the cue ball can’t go there';
  } else if (shot.place) return 'the cue ball isn’t in hand';
  return null;
}

/** Normalise what a client sent into exactly the numbers the simulation will use. */
export function cleanShot(shot: Shot): Shot {
  const l = Math.sqrt(shot.dx * shot.dx + shot.dy * shot.dy);
  const q = (v: number) => Math.round(v * 1e6) / 1e6;
  const out: Shot = { dx: q(shot.dx / l), dy: q(shot.dy / l), power: q(shot.power), side: q(shot.side), height: q(shot.height) };
  if (shot.place) out.place = { x: q(shot.place.x), y: q(shot.place.y) };
  return out;
}

export interface ShotOutcome {
  match: Match;
  result: SimResult;
}

/** Play a shot (checked with checkShot first). Returns the new match; `m` is untouched. */
export function takeShot(m: Match, shot: Shot, record = false): ShotOutcome {
  const rules = rulesOf(m);
  const f = m.frame;
  const result = simulate(rules.table, f.balls, shot, { record });
  const after = result.balls.map((b) => ({ ...b }));
  const frame = rules.judge(f, after, summarise(result.events), rngFor(m, f.shots));
  const match: Match = { ...m, frame };
  if (frame.over) settleFrame(match);
  return { match, result };
}

function settleFrame(m: Match): void {
  const w = m.frame.over!.winner;
  m.wins = [m.wins[0], m.wins[1]];
  m.wins[w] += 1;
  if (m.wins[w] >= m.setup.raceTo) m.winner = w;
}

/** The player concedes the frame (or, with `match`, the whole match). */
export function concede(m: Match, p: Player, whole = false): Match {
  if (m.winner !== null) return m;
  const w = otherPlayer(p);
  // the frame is already decided (waiting for the next to be racked): don't count it twice
  if (m.frame.over) return whole ? { ...m, winner: w } : m;
  const out: Match = { ...m, frame: { ...m.frame, over: { winner: w, reason: `@${p} conceded` }, message: `@${p} concedes` } };
  settleFrame(out);
  if (whole) out.winner = w;
  return out;
}

/** Rack up the next frame; the other player breaks. */
export function nextFrame(m: Match): Match {
  if (!m.frame.over || m.winner !== null) return m;
  const breaker = otherPlayer(m.breaker);
  const out: Match = { ...m, frameNo: m.frameNo + 1, breaker };
  out.frame = freshFrame(rulesOf(m), rngFor(out, -1), breaker);
  return out;
}

/** Swap "@0"/"@1" for names (and mend the verb when a player is simply called "You"). */
export function say(text: string, names: readonly string[]): string {
  return text.replace(/@([01])/g, (_, i) => names[Number(i)]).replace(/\bYou ([a-z]+s)\b/g, (_, verb: string) => `You ${secondPerson(verb)}`);
}

function secondPerson(verb: string): string {
  if (verb === 'has') return 'have';
  if (verb === 'is') return 'are';
  if (/(ss|sh|ch|x)es$/.test(verb)) return verb.slice(0, -2);
  return verb.slice(0, -1);
}
