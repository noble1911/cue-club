// UK 8-ball (pub rules): seven reds, seven yellows and the black on a 7ft table.
//
// - Break from in hand behind the baulk line. Black potted on the break: re-rack, same breaker.
// - The table stays open until someone pots on a legal shot after the break; the colour of the
//   first ball potted becomes theirs.
// - Fouls (miss, wrong ball first, in-off, potting the opponent's ball): the opponent gets two
//   visits, and the first of them is a free shot (any ball may be hit first). An in-off also
//   gives them the cue ball in hand behind the baulk line.
// - Pot your seven, then the black. Potting the black early, or fouling while potting it, loses.

import { POOL_UK } from '../tables.ts';
import type { Ball, ShotSummary } from '../physics.ts';
import type { Rng } from '../rng.ts';
import { ballAt, next, otherPlayer, rackPositions, respot, type Frame, type Player, type Rules } from './types.ts';

type Colour = 'red' | 'yellow';
interface UkRule {
  /** Each player's colour, once decided. */
  groups: [Colour, Colour] | null;
  /** Extra visits the shooter still has after this one (1 after an opponent's foul). */
  visits: number;
  /** The shooter may hit any ball first (the first visit after a foul). */
  freeShot: boolean;
}

const T = POOL_UK;
const RED = '#c8102e';
const YELLOW = '#ffcc00';
const colourOf = (id: number): Colour | 'black' | 'cue' => (id === 0 ? 'cue' : id === 8 ? 'black' : id <= 7 ? 'red' : 'yellow');
const left = (balls: readonly Ball[], c: Colour) => balls.filter((b) => b.on && colourOf(b.id) === c).length;

// rows from the apex: R / Y R / R B Y / Y R Y R / R Y Y R Y  (ids: reds 1-7, black 8, yellows 9-15)
const PATTERN = ['r', 'y', 'r', 'r', 'b', 'y', 'y', 'r', 'y', 'r', 'r', 'y', 'y', 'r', 'y'];

export const UK8: Rules = {
  id: 'uk8',
  name: 'UK 8-Ball',
  blurb: 'Reds and yellows on a 7ft pub table. Fouls give two visits.',
  table: T,
  looks: [
    { color: '#f4f1e8', name: 'cue ball' },
    ...Array.from({ length: 7 }, () => ({ color: RED, name: 'red' })),
    { color: '#111111', name: 'black' },
    ...Array.from({ length: 7 }, () => ({ color: YELLOW, name: 'yellow' })),
  ],
  breakZone: 'baulk',
  rack(rng: Rng) {
    const spots = rackPositions(T, T.footSpot, [1, 2, 3, 4, 5]);
    const balls: Ball[] = [ballAt(0, T.baulkX - 0.12, (rng.next() - 0.5) * 0.2)];
    let r = 1;
    let y = 9;
    const placed: Ball[] = [];
    PATTERN.forEach((k, i) => {
      const id = k === 'b' ? 8 : k === 'r' ? r++ : y++;
      placed.push(ballAt(id, spots[i].x, spots[i].y));
    });
    // swap the colours over half the time so neither side always has the apex
    if (rng.next() < 0.5) for (const b of placed) if (b.id !== 8) b.id = b.id <= 7 ? b.id + 8 : b.id - 8;
    placed.sort((a, b) => a.id - b.id);
    return [...balls, ...placed];
  },
  initRule(): UkRule {
    return { groups: null, visits: 0, freeShot: false };
  },
  ballsOn(f: Frame) {
    const rule = f.rule as UkRule;
    const objects = f.balls.filter((b) => b.on && b.id !== 0);
    if (f.shots === 0 || rule.freeShot) return objects.filter((b) => b.id !== 8 || onBlack(f, f.turn)).map((b) => b.id);
    if (!rule.groups) return objects.filter((b) => b.id !== 8).map((b) => b.id);
    if (onBlack(f, f.turn)) return [8];
    return objects.filter((b) => colourOf(b.id) === rule.groups![f.turn]).map((b) => b.id);
  },
  onText(f: Frame, p: Player) {
    const rule = f.rule as UkRule;
    if (!rule.groups) return 'Open table';
    if (onBlack(f, p)) return 'On the black';
    const c = rule.groups[p];
    return `${c === 'red' ? 'Reds' : 'Yellows'} · ${left(f.balls, c)} left`;
  },
  judge(f: Frame, after: Ball[], s: ShotSummary, rng: Rng): Frame {
    const rule = { ...(f.rule as UkRule) };
    const me = f.turn;
    const opp = otherPlayer(me);
    const isBreak = f.shots === 0;
    const potted = s.potted.filter((id) => id !== 0);
    const wasOnBlack = onBlack(f, me);
    const mine = rule.groups ? rule.groups[me] : null;

    let foul: string | null = null;
    if (s.firstHit < 0) foul = 'missed everything';
    else if (!isBreak && !this.ballsOn(f).includes(s.firstHit)) foul = s.firstHit === 8 ? 'hit the black first' : `hit ${colourOf(s.firstHit) === 'red' ? 'a red' : 'a yellow'} first`;
    if (s.cuePotted) foul = 'in-off';
    if (!foul && mine && !rule.freeShot && potted.some((id) => id !== 8 && colourOf(id) !== mine)) foul = "potted the opponent's ball";

    if (potted.includes(8)) {
      if (isBreak) {
        const balls = this.rack(rng);
        return { ...f, balls, shots: 0, inHand: 'baulk', rule: this.initRule(), message: 'Black on the break: re-rack, @' + me + ' breaks again', foul: false };
      }
      if (foul) return next(f, after, { over: { winner: opp, reason: `@${me} fouled (${foul}) while potting the black` }, foul: true, message: `Foul on the black: @${opp} wins the frame` });
      if (!wasOnBlack) return next(f, after, { over: { winner: opp, reason: `@${me} potted the black early` }, message: `Black potted early: @${opp} wins the frame` });
      return next(f, after, { over: { winner: me, reason: `@${me} potted the black` }, message: `@${me} pots the black and wins the frame` });
    }

    if (foul) {
      // a ball in hand only after an in-off; the opponent has two visits, the first a free shot
      if (s.cuePotted) respot(T, after, 0, [{ x: T.baulkX - 0.12, y: 0 }]);
      const keepGroups = rule.groups;
      return next(f, after, {
        turn: opp,
        inHand: s.cuePotted ? 'baulk' : null,
        rule: { groups: keepGroups, visits: 1, freeShot: true } satisfies UkRule,
        foul: true,
        message: `Foul (${foul}): @${opp} has two visits`,
      });
    }

    // decide the colours on the first legal pot after the break
    if (!rule.groups && !isBreak && potted.length > 0) {
      const c = colourOf(potted[0]) as Colour;
      rule.groups = me === 0 ? [c, c === 'red' ? 'yellow' : 'red'] : [c === 'red' ? 'yellow' : 'red', c];
    }
    const group = rule.groups ? rule.groups[me] : null;
    const scored = isBreak ? potted.length > 0 : group ? potted.some((id) => colourOf(id) === group) : false;
    rule.freeShot = false;
    if (scored) {
      const named = !mine && group ? `@${me} is ${group === 'red' ? 'reds' : 'yellows'}` : `@${me} pots ${potted.length === 1 ? 'one' : potted.length}`;
      return next(f, after, { rule, message: named });
    }
    if (rule.visits > 0) {
      rule.visits -= 1;
      return next(f, after, { rule, message: `@${me} takes the second visit` });
    }
    rule.visits = 0;
    return next(f, after, { turn: opp, rule, message: `@${opp} to play` });
  },
};

function onBlack(f: Frame, p: Player): boolean {
  const rule = f.rule as UkRule;
  return !!rule.groups && left(f.balls, rule.groups[p]) === 0;
}
