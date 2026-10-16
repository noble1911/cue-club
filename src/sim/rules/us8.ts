// US 8-ball (WPA rules, simplified) on a 9ft table: solids 1-7, stripes 9-15, the 8.
//
// - Break from the kitchen (behind the head string). A scratch on the break gives the opponent
//   the cue ball in the kitchen; the 8 potted on the break is spotted again.
// - Open table until someone pots on a legal shot after the break.
// - Fouls (scratch, nothing hit, wrong ball first, no rail after contact): ball in hand anywhere.
// - Clear your group, then pot the 8. Potting the 8 early, or scratching on it, loses.
//   No called pockets (house rule).

import { POOL_US } from '../tables.ts';
import type { Ball, ShotSummary } from '../physics.ts';
import type { Rng } from '../rng.ts';
import { ballAt, next, otherPlayer, rackPositions, respot, type Frame, type Player, type Rules } from './types.ts';

type Group = 'solids' | 'stripes';
interface UsRule {
  groups: [Group, Group] | null;
}

const T = POOL_US;
export const US_COLOURS = ['#f4f1e8', '#f7c500', '#1d4fc4', '#d2201c', '#5b2a86', '#f0731d', '#127a43', '#7a1b1f', '#111111'];
const groupOf = (id: number): Group | 'eight' | 'cue' => (id === 0 ? 'cue' : id === 8 ? 'eight' : id < 8 ? 'solids' : 'stripes');
const left = (balls: readonly Ball[], g: Group) => balls.filter((b) => b.on && groupOf(b.id) === g).length;

export function poolLooks() {
  return Array.from({ length: 16 }, (_, id) =>
    id === 0 ? { color: US_COLOURS[0], name: 'cue ball' } : { color: US_COLOURS[id > 8 ? id - 8 : id], number: id, stripe: id > 8, name: `${id}-ball` },
  );
}

export const US8: Rules = {
  id: 'us8',
  name: 'US 8-Ball',
  blurb: 'Solids and stripes on a 9ft table. Fouls give ball in hand.',
  table: T,
  looks: poolLooks(),
  breakZone: 'baulk',
  rack(rng: Rng) {
    const spots = rackPositions(T, T.footSpot, [1, 2, 3, 4, 5]);
    // the 8 in the middle of the third row, a solid and a stripe in the back corners
    const solids = rng.shuffle([1, 2, 3, 4, 5, 6, 7]);
    const stripes = rng.shuffle([9, 10, 11, 12, 13, 14, 15]);
    const order = new Array<number>(15);
    order[4] = 8;
    const flip = rng.next() < 0.5;
    order[10] = (flip ? solids : stripes).pop()!;
    order[14] = (flip ? stripes : solids).pop()!;
    const rest = rng.shuffle([...solids, ...stripes]);
    for (let i = 0; i < 15; i++) if (order[i] === undefined) order[i] = rest.pop()!;
    const balls: Ball[] = [ballAt(0, T.baulkX - 0.15, (rng.next() - 0.5) * 0.3)];
    for (let i = 0; i < 15; i++) balls.push(ballAt(order[i], spots[i].x, spots[i].y));
    return balls.sort((a, b) => a.id - b.id);
  },
  initRule(): UsRule {
    return { groups: null };
  },
  ballsOn(f: Frame) {
    const rule = f.rule as UsRule;
    const objects = f.balls.filter((b) => b.on && b.id !== 0);
    if (f.shots === 0) return objects.map((b) => b.id);
    if (!rule.groups) return objects.filter((b) => b.id !== 8).map((b) => b.id);
    if (onEight(f, f.turn)) return [8];
    return objects.filter((b) => groupOf(b.id) === rule.groups![f.turn]).map((b) => b.id);
  },
  onText(f: Frame, p: Player) {
    const rule = f.rule as UsRule;
    if (!rule.groups) return 'Open table';
    if (onEight(f, p)) return 'On the 8';
    const g = rule.groups[p];
    return `${g === 'solids' ? 'Solids' : 'Stripes'} · ${left(f.balls, g)} left`;
  },
  judge(f: Frame, after: Ball[], s: ShotSummary): Frame {
    const rule = { ...(f.rule as UsRule) };
    const me = f.turn;
    const opp = otherPlayer(me);
    const isBreak = f.shots === 0;
    const potted = s.potted.filter((id) => id !== 0);
    const wasOnEight = onEight(f, me);

    let foul: string | null = null;
    if (s.firstHit < 0) foul = 'no ball hit';
    else if (!isBreak && !this.ballsOn(f).includes(s.firstHit)) foul = s.firstHit === 8 ? 'hit the 8 first' : `hit the ${s.firstHit} first`;
    else if (!isBreak && potted.length === 0 && !s.cushionAfterContact) foul = 'no rail after contact';
    if (s.cuePotted) foul = 'scratch';

    if (potted.includes(8)) {
      if (isBreak) {
        respot(T, after, 8, [T.footSpot]);
      } else if (foul) {
        return next(f, after, { over: { winner: opp, reason: `@${me} scratched on the 8` }, foul: true, message: `Foul on the 8: @${opp} wins the rack` });
      } else if (!wasOnEight) {
        return next(f, after, { over: { winner: opp, reason: `@${me} potted the 8 early` }, message: `8 potted early: @${opp} wins the rack` });
      } else {
        return next(f, after, { over: { winner: me, reason: `@${me} potted the 8` }, message: `@${me} sinks the 8 and wins the rack` });
      }
    }

    if (foul) {
      if (s.cuePotted) respot(T, after, 0, [{ x: T.baulkX - 0.15, y: 0 }]);
      return next(f, after, { turn: opp, inHand: isBreak && s.cuePotted ? 'baulk' : 'anywhere', rule, foul: true, message: `Foul (${foul}): ball in hand for @${opp}` });
    }

    const own = potted.filter((id) => id !== 8);
    if (!rule.groups && !isBreak && own.length > 0) {
      const g = groupOf(own[0]) as Group;
      const other: Group = g === 'solids' ? 'stripes' : 'solids';
      rule.groups = me === 0 ? [g, other] : [other, g];
    }
    const group = rule.groups ? rule.groups[me] : null;
    const scored = isBreak ? own.length > 0 : group ? own.some((id) => groupOf(id) === group) : false;
    if (scored) {
      const fresh = !(f.rule as UsRule).groups && rule.groups;
      return next(f, after, { rule, message: fresh ? `@${me} takes ${group}` : `@${me} keeps the table` });
    }
    return next(f, after, { turn: opp, rule, message: `@${opp} to shoot` });
  },
};

function onEight(f: Frame, p: Player): boolean {
  const rule = f.rule as UsRule;
  return !!rule.groups && left(f.balls, rule.groups[p]) === 0;
}
