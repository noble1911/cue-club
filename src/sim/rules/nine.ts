// 9-ball (WPA rules, simplified): balls 1-9 racked in a diamond, the 1 at the front and the 9
// in the middle. Always hit the lowest-numbered ball first; any ball potted on a legal shot
// keeps you at the table; potting the 9 legally (combinations and the break included) wins.
// Fouls (scratch, wrong ball first, nothing hit, no rail after contact) give ball in hand
// anywhere, and a 9 potted on a foul is spotted again. No push-out, no three-foul rule.

import { POOL_US } from '../tables.ts';
import type { Ball, ShotSummary } from '../physics.ts';
import type { Rng } from '../rng.ts';
import { ballAt, next, otherPlayer, rackPositions, respot, type Frame, type Rules } from './types.ts';
import { poolLooks } from './us8.ts';

const T = POOL_US;
const lowest = (balls: readonly Ball[]) => balls.filter((b) => b.on && b.id !== 0).reduce((m, b) => Math.min(m, b.id), 99);

export const NINE: Rules = {
  id: 'nine',
  name: '9-Ball',
  blurb: 'Hit the lowest ball first, pot the 9 to win. Fast and brutal.',
  table: T,
  looks: poolLooks().slice(0, 10),
  breakZone: 'baulk',
  rack(rng: Rng) {
    const spots = rackPositions(T, T.footSpot, [1, 2, 3, 2, 1]);
    const middle = rng.shuffle([2, 3, 4, 5, 6, 7, 8]);
    const order = [1, middle[0], middle[1], middle[2], 9, middle[3], middle[4], middle[5], middle[6]];
    const balls: Ball[] = [ballAt(0, T.baulkX - 0.15, (rng.next() - 0.5) * 0.3)];
    for (let i = 0; i < 9; i++) balls.push(ballAt(order[i], spots[i].x, spots[i].y));
    return balls.sort((a, b) => a.id - b.id);
  },
  initRule() {
    return {};
  },
  ballsOn(f: Frame) {
    return [lowest(f.balls)];
  },
  onText(f: Frame) {
    return `On the ${lowest(f.balls)}`;
  },
  judge(f: Frame, after: Ball[], s: ShotSummary): Frame {
    const me = f.turn;
    const opp = otherPlayer(me);
    const potted = s.potted.filter((id) => id !== 0);
    const on = lowest(f.balls);

    let foul: string | null = null;
    if (s.firstHit < 0) foul = 'no ball hit';
    else if (s.firstHit !== on) foul = `hit the ${s.firstHit} before the ${on}`;
    else if (potted.length === 0 && !s.cushionAfterContact) foul = 'no rail after contact';
    if (s.cuePotted) foul = 'scratch';

    if (potted.includes(9)) {
      if (!foul) return next(f, after, { over: { winner: me, reason: `@${me} potted the 9` }, message: `@${me} pots the 9 and wins the rack` });
      respot(T, after, 9, [T.footSpot]);
    }
    if (foul) {
      if (s.cuePotted) respot(T, after, 0, [{ x: T.baulkX - 0.15, y: 0 }]);
      return next(f, after, { turn: opp, inHand: 'anywhere', foul: true, message: `Foul (${foul}): ball in hand for @${opp}` });
    }
    if (potted.length > 0) return next(f, after, { message: `@${me} stays at the table` });
    return next(f, after, { turn: opp, message: `@${opp} to shoot` });
  },
};
