// Snooker on a full-size 12ft table: 15 reds and six colours.
//
// - On a red: hit a red first, pot only reds (1 point each), then you're on a colour.
// - On a colour: the first colour you hit is the one you've nominated; pot only that one. Colours
//   come back to their spots while reds remain (and for the colour after the last red).
// - After the reds: the colours in order, yellow (2) to black (7), and they stay down.
// - A foul gives the opponent max(4, value of the ball on, of the ball hit first, of anything
//   potted wrongly) and the next turn; after an in-off the cue ball is in hand in the D.
// - Scores level after the black: it's re-spotted, the cue ball is in hand, a coin decides who
//   plays. Not modelled: free ball, the miss rule, "play again".

import { SNOOKER } from '../tables.ts';
import type { Ball, ShotSummary } from '../physics.ts';
import type { Rng } from '../rng.ts';
import type { Vec } from '../tables.ts';
import { ballAt, next, otherPlayer, rackPositions, respot, type Frame, type Player, type Rules } from './types.ts';

type Phase = 'red' | 'colour' | 'sequence';
interface SnookerRule {
  phase: Phase;
}

const T = SNOOKER;
const L = T.length / 2;
/** Ids: 0 cue, 1-15 reds, then yellow, green, brown, blue, pink, black. */
export const YELLOW = 16;
export const BLACK = 21;
const NAMES = ['yellow', 'green', 'brown', 'blue', 'pink', 'black'];
const COLOURS = ['#f5c518', '#13804a', '#6e3b1c', '#1844c0', '#f182a7', '#121212'];
export const SPOTS: Record<number, Vec> = {
  16: { x: T.baulkX, y: -T.dRadius },
  17: { x: T.baulkX, y: T.dRadius },
  18: { x: T.baulkX, y: 0 },
  19: { x: 0, y: 0 },
  20: { x: L / 2, y: 0 },
  21: { x: L - 0.324, y: 0 },
};
const isRed = (id: number) => id >= 1 && id <= 15;
const isColour = (id: number) => id >= YELLOW;
export const value = (id: number) => (isRed(id) ? 1 : isColour(id) ? id - 14 : 0);
const reds = (balls: readonly Ball[]) => balls.filter((b) => b.on && isRed(b.id));
const lowestColour = (balls: readonly Ball[]) => balls.filter((b) => b.on && isColour(b.id)).reduce((m, b) => Math.min(m, b.id), 99);
const ballName = (id: number) => (isRed(id) ? 'a red' : 'the ' + NAMES[id - YELLOW]);

/** Spots a colour may go back to: its own, then the others from the black down. */
function spotsFor(id: number): Vec[] {
  return [SPOTS[id], ...[21, 20, 19, 18, 17, 16].filter((s) => s !== id).map((s) => SPOTS[s])];
}

export const SNOOKER_RULES: Rules = {
  id: 'snooker',
  name: 'Snooker',
  blurb: 'Fifteen reds, six colours, a 12ft table. Build your break.',
  table: T,
  looks: [
    { color: '#f4f1e8', name: 'cue ball' },
    ...Array.from({ length: 15 }, () => ({ color: '#b0101a', name: 'red' })),
    ...COLOURS.map((color, i) => ({ color, name: NAMES[i] })),
  ],
  breakZone: 'd',
  rack(rng: Rng) {
    const R = T.ballRadius;
    const apex = { x: SPOTS[20].x + 2 * R + 0.002, y: 0 };
    const reds = rackPositions(T, apex, [1, 2, 3, 4, 5]);
    const balls: Ball[] = [ballAt(0, T.baulkX - 0.02, -T.dRadius * (0.35 + 0.3 * rng.next()))];
    reds.forEach((p, i) => balls.push(ballAt(i + 1, p.x, p.y)));
    for (let id = YELLOW; id <= BLACK; id++) balls.push(ballAt(id, SPOTS[id].x, SPOTS[id].y));
    return balls;
  },
  initRule(): SnookerRule {
    return { phase: 'red' };
  },
  ballsOn(f: Frame) {
    const phase = (f.rule as SnookerRule).phase;
    if (phase === 'red') return reds(f.balls).map((b) => b.id);
    if (phase === 'colour') return f.balls.filter((b) => b.on && isColour(b.id)).map((b) => b.id);
    return [lowestColour(f.balls)];
  },
  onText(f: Frame, p: Player) {
    if (p !== f.turn) return '';
    const phase = (f.rule as SnookerRule).phase;
    if (phase === 'red') return `On a red · ${reds(f.balls).length} left`;
    if (phase === 'colour') return 'On a colour';
    const id = lowestColour(f.balls);
    return id === 99 ? '' : `On the ${NAMES[id - YELLOW]}`;
  },
  judge(f: Frame, after: Ball[], s: ShotSummary, rng: Rng): Frame {
    const phase = (f.rule as SnookerRule).phase;
    const me = f.turn;
    const opp = otherPlayer(me);
    const potted = s.potted.filter((id) => id !== 0);
    const on = this.ballsOn(f);

    let foul: string | null = null;
    if (s.firstHit < 0) foul = 'missed';
    else if (!on.includes(s.firstHit)) foul = `hit ${ballName(s.firstHit)} first`;
    if (!foul) {
      const legal = (id: number) => (phase === 'red' ? isRed(id) : id === s.firstHit);
      const wrong = potted.find((id) => !legal(id));
      if (wrong !== undefined) foul = `potted ${ballName(wrong)}`;
    }
    if (s.cuePotted) foul = 'in-off';

    // value of the ball on: a red, the nominated colour, or the next in sequence
    const onValue = phase === 'red' ? 1 : phase === 'colour' ? (s.firstHit >= 0 && isColour(s.firstHit) ? value(s.firstHit) : 4) : value(on[0]);
    const points: [number, number] = [f.points[0], f.points[1]];

    // colours go back unless legally potted in the final sequence
    for (const id of potted) {
      if (isColour(id) && (foul || phase !== 'sequence')) respot(T, after, id, spotsFor(id));
    }

    if (foul) {
      const penalty = Math.max(4, onValue, s.firstHit >= 0 ? value(s.firstHit) : 0, ...potted.map(value));
      points[opp] += penalty;
      if (s.cuePotted) respot(T, after, 0, [{ x: T.baulkX - 0.02, y: -0.08 }]);
      const nextPhase: Phase = reds(after).length > 0 ? 'red' : 'sequence';
      const base = { points, brk: 0, foul: true, turn: opp, inHand: s.cuePotted ? ('d' as const) : null, rule: { phase: nextPhase } };
      // a foul on the last black ends the frame (unless that levels the scores)
      if (phase === 'sequence' && lowestColour(f.balls) === BLACK && points[0] !== points[1]) {
        const winner: Player = points[0] > points[1] ? 0 : 1;
        return next(f, after, { ...base, over: { winner, reason: `foul on the black` }, message: `Foul on the black (${foul}): ${penalty} to @${opp}` });
      }
      return next(f, after, { ...base, message: `Foul (${foul}): ${penalty} points to @${opp}` });
    }

    let scored = 0;
    if (phase === 'red') scored = potted.length;
    else if (potted.length > 0) scored = value(potted[0]);
    points[me] += scored;

    if (scored === 0) {
      const nextPhase: Phase = reds(after).length > 0 ? 'red' : 'sequence';
      return next(f, after, { points, brk: 0, turn: opp, rule: { phase: nextPhase }, message: f.brk > 0 ? `@${me} ends on a break of ${f.brk}` : `@${opp} to play` });
    }

    const brk = f.brk + scored;
    if (phase === 'sequence' && lowestColour(after) === 99) {
      // the black is down
      if (points[0] === points[1]) {
        respot(T, after, BLACK, [SPOTS[BLACK]]);
        respot(T, after, 0, [{ x: T.baulkX - 0.02, y: 0.08 }]);
        const toss: Player = rng.next() < 0.5 ? 0 : 1;
        return next(f, after, { points, brk: 0, turn: toss, inHand: 'd', rule: { phase: 'sequence' }, message: `Scores level: re-spotted black, @${toss} plays` });
      }
      const winner: Player = points[0] > points[1] ? 0 : 1;
      return next(f, after, { points, brk, over: { winner, reason: `${points[0]}–${points[1]}` }, message: `@${me} pots the black: @${winner} wins the frame ${points[winner]}–${points[otherPlayer(winner)]}` });
    }
    const nextPhase: Phase = phase === 'red' ? 'colour' : phase === 'colour' ? (reds(after).length > 0 ? 'red' : 'sequence') : 'sequence';
    return next(f, after, { points, brk, rule: { phase: nextPhase }, message: `Break: ${brk}` });
  },
};

/** Points still on the table for the player at the table (reds at 8 each, plus the colours). */
export function pointsRemaining(f: Frame): number {
  const r = reds(f.balls).length;
  const colours = f.balls.filter((b) => b.on && isColour(b.id)).reduce((s, b) => s + value(b.id), 0);
  const phase = (f.rule as SnookerRule).phase;
  return r * 8 + colours + (phase === 'colour' ? 7 : 0);
}
