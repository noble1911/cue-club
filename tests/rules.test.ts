import { describe, expect, it } from 'vitest';
import type { Ball, ShotSummary } from '../src/sim/physics.ts';
import { Rng } from '../src/sim/rng.ts';
import { UK8 } from '../src/sim/rules/uk8.ts';
import { US8 } from '../src/sim/rules/us8.ts';
import { NINE } from '../src/sim/rules/nine.ts';
import { SNOOKER_RULES, SPOTS, BLACK, YELLOW } from '../src/sim/rules/snooker.ts';
import type { Frame, Rules } from '../src/sim/rules/types.ts';
import { newMatch, takeShot, concede, nextFrame, checkShot, canPlace, VARIANTS } from '../src/sim/game.ts';
const VARIANT_TABLE = { us8: VARIANTS.us8.table, uk8: VARIANTS.uk8.table, snooker: VARIANTS.snooker.table, nine: VARIANTS.nine.table };

const rng = () => new Rng(7);
function frame(rules: Rules, patch: Partial<Frame> = {}): Frame {
  return { balls: rules.rack(rng()), turn: 0, inHand: null, points: [0, 0], brk: 0, rule: rules.initRule(), over: null, shots: 5, message: '', foul: false, ...patch };
}
function summary(p: Partial<ShotSummary>): ShotSummary {
  return { firstHit: -1, potted: [], pockets: {}, cuePotted: false, cushionAfterContact: true, objectCushions: 0, ...p, ...(p.potted ? { cuePotted: p.potted.includes(0) } : {}) };
}
function after(f: Frame, potted: number[]): Ball[] {
  return f.balls.map((b) => (potted.includes(b.id) ? { ...b, on: false } : { ...b }));
}
const judge = (rules: Rules, f: Frame, s: Partial<ShotSummary>) => rules.judge(f, after(f, s.potted ?? []), summary(s), rng());

describe('UK 8-ball', () => {
  it('first legal pot after the break decides the colours', () => {
    const f = frame(UK8);
    const n = judge(UK8, f, { firstHit: 3, potted: [3] });
    expect(n.rule.groups).toEqual(['red', 'yellow']);
    expect(n.turn).toBe(0);
  });
  it('a foul gives the opponent two visits and a free shot', () => {
    const f = frame(UK8, { rule: { groups: ['red', 'yellow'], visits: 0, freeShot: false } });
    const n = judge(UK8, f, { firstHit: 9 });
    expect(n.foul).toBe(true);
    expect(n.turn).toBe(1);
    expect(n.rule.visits).toBe(1);
    expect(n.rule.freeShot).toBe(true);
    // they miss on the first visit: still theirs
    const n2 = judge(UK8, n, { firstHit: 2 });
    expect(n2.turn).toBe(1);
    expect(n2.foul).toBe(false);
    // and the second miss passes the table back
    const n3 = judge(UK8, n2, { firstHit: 10 });
    expect(n3.turn).toBe(0);
  });
  it('in-off gives ball in hand in baulk', () => {
    const f = frame(UK8, { rule: { groups: ['red', 'yellow'], visits: 0, freeShot: false } });
    const n = judge(UK8, f, { firstHit: 1, potted: [0] });
    expect(n.inHand).toBe('baulk');
    expect(n.balls[0].on).toBe(true);
  });
  it('potting the black early loses, potting it when on wins', () => {
    const f = frame(UK8, { rule: { groups: ['red', 'yellow'], visits: 0, freeShot: false } });
    expect(judge(UK8, f, { firstHit: 1, potted: [8] }).over?.winner).toBe(1);
    const cleared = frame(UK8, { rule: { groups: ['red', 'yellow'], visits: 0, freeShot: false } });
    cleared.balls = cleared.balls.map((b) => (b.id >= 1 && b.id <= 7 ? { ...b, on: false } : b));
    expect(judge(UK8, cleared, { firstHit: 8, potted: [8] }).over?.winner).toBe(0);
    expect(judge(UK8, cleared, { firstHit: 8, potted: [8, 0] }).over?.winner).toBe(1);
  });
  it('black on the break re-racks', () => {
    const f = frame(UK8, { shots: 0 });
    const n = judge(UK8, f, { firstHit: 1, potted: [8] });
    expect(n.over).toBeNull();
    expect(n.shots).toBe(0);
    expect(n.balls.every((b) => b.on)).toBe(true);
  });
});

describe('US 8-ball', () => {
  it('no rail after contact is a foul with ball in hand', () => {
    const f = frame(US8);
    const n = judge(US8, f, { firstHit: 3, cushionAfterContact: false });
    expect(n.foul).toBe(true);
    expect(n.inHand).toBe('anywhere');
  });
  it('scratch on the break puts the cue ball in the kitchen', () => {
    const n = judge(US8, frame(US8, { shots: 0 }), { firstHit: 1, potted: [0] });
    expect(n.inHand).toBe('baulk');
  });
  it('the 8 on the break is spotted', () => {
    const n = judge(US8, frame(US8, { shots: 0 }), { firstHit: 1, potted: [8] });
    expect(n.over).toBeNull();
    expect(n.balls[8].on).toBe(true);
  });
  it('groups split solids and stripes', () => {
    const n = judge(US8, frame(US8, { turn: 1 }), { firstHit: 11, potted: [11] });
    expect(n.rule.groups).toEqual(['solids', 'stripes']);
  });
});

describe('9-ball', () => {
  it('must hit the lowest ball first', () => {
    const n = judge(NINE, frame(NINE), { firstHit: 2 });
    expect(n.foul).toBe(true);
    expect(n.inHand).toBe('anywhere');
  });
  it('a combination on the 9 wins', () => {
    expect(judge(NINE, frame(NINE), { firstHit: 1, potted: [9] }).over?.winner).toBe(0);
  });
  it('the 9 potted on a foul comes back', () => {
    const n = judge(NINE, frame(NINE), { firstHit: 1, potted: [9, 0] });
    expect(n.over).toBeNull();
    expect(n.balls[9].on).toBe(true);
  });
});

describe('snooker', () => {
  it('red then colour: points, colour respotted, back on a red', () => {
    const f = frame(SNOOKER_RULES);
    const a = judge(SNOOKER_RULES, f, { firstHit: 4, potted: [4] });
    expect(a.points).toEqual([1, 0]);
    expect(a.rule.phase).toBe('colour');
    const b = judge(SNOOKER_RULES, a, { firstHit: BLACK, potted: [BLACK] });
    expect(b.points).toEqual([8, 0]);
    expect(b.brk).toBe(8);
    expect(b.balls[BLACK].on).toBe(true);
    expect(b.balls[BLACK].x).toBeCloseTo(SPOTS[BLACK].x);
    expect(b.rule.phase).toBe('red');
  });
  it('fouls score at least four, or the value of the ball involved', () => {
    const f = frame(SNOOKER_RULES);
    expect(judge(SNOOKER_RULES, f, {}).points).toEqual([0, 4]);
    expect(judge(SNOOKER_RULES, f, { firstHit: 20 }).points).toEqual([0, 6]);
    expect(judge(SNOOKER_RULES, f, { firstHit: 2, potted: [2, BLACK] }).points).toEqual([0, 7]);
    const inOff = judge(SNOOKER_RULES, f, { firstHit: 2, potted: [0] });
    expect(inOff.inHand).toBe('d');
  });
  it('the colours go down in order once the reds are gone', () => {
    const f = frame(SNOOKER_RULES, { rule: { phase: 'sequence' } });
    f.balls = f.balls.map((b) => (b.id >= 1 && b.id <= 15 ? { ...b, on: false } : b));
    expect(SNOOKER_RULES.ballsOn(f)).toEqual([YELLOW]);
    const n = judge(SNOOKER_RULES, f, { firstHit: YELLOW, potted: [YELLOW] });
    expect(n.balls[YELLOW].on).toBe(false);
    expect(SNOOKER_RULES.ballsOn(n)).toEqual([YELLOW + 1]);
  });
  it('level after the black: re-spotted black', () => {
    const f = frame(SNOOKER_RULES, { rule: { phase: 'sequence' }, points: [40, 47] });
    f.balls = f.balls.map((b) => (b.id >= 1 && b.id < BLACK ? { ...b, on: false } : b));
    const n = judge(SNOOKER_RULES, f, { firstHit: BLACK, potted: [BLACK] });
    expect(n.over).toBeNull();
    expect(n.balls[BLACK].on).toBe(true);
    expect(n.inHand).toBe('d');
  });
});

describe('match', () => {
  it('race to two, alternate breaks, concede', () => {
    let m = newMatch({ variant: 'nine', raceTo: 2, names: ['A', 'B'], seed: 3 });
    const firstBreaker = m.breaker;
    m = concede(m, 0);
    expect(m.wins).toEqual([0, 1]);
    expect(m.winner).toBeNull();
    m = nextFrame(m);
    expect(m.breaker).toBe(1 - firstBreaker);
    m = concede(m, 0);
    expect(m.winner).toBe(1);
  });
  it('rejects a shot without placing the cue ball when it is in hand', () => {
    const m = newMatch({ variant: 'snooker', raceTo: 1, names: ['A', 'B'], seed: 3 });
    expect(checkShot(m, { dx: 1, dy: 0, power: 0.5, side: 0, height: 0 })).toMatch(/place/);
    expect(canPlace(m, m.setup.variant === 'snooker' ? -1.2 : 0, 0.1)).toBe(true);
    expect(canPlace(m, 0, 0)).toBe(false);
    const ok = { dx: 1, dy: 0, power: 0.5, side: 0, height: 0, place: { x: -1.2, y: 0.1 } };
    expect(checkShot(m, ok)).toBeNull();
    const out = takeShot(m, ok, true);
    expect(out.match.frame.shots).toBe(1);
    expect(out.result.frames.length).toBeGreaterThan(10);
  });
});

describe('review fixes', () => {
  it('snooker: a foul on the last black that levels the scores re-spots it, in hand, lots drawn', () => {
    const f = frame(SNOOKER_RULES, { rule: { phase: 'sequence' }, points: [47, 40] });
    f.balls = f.balls.map((b) => (b.id >= 1 && b.id < BLACK ? { ...b, on: false } : b));
    const n = judge(SNOOKER_RULES, f, { firstHit: -1 });
    expect(n.points).toEqual([47, 47]);
    expect(n.over).toBeNull();
    expect(n.inHand).toBe('d');
    expect(n.balls[BLACK].x).toBeCloseTo(SPOTS[BLACK].x);
    expect(n.message).toMatch(/re-spotted black/);
  });
  it('snooker: the last red going down in a foul puts the next player on the yellow (the rules)', () => {
    const f = frame(SNOOKER_RULES);
    f.balls = f.balls.map((b) => (b.id >= 2 && b.id <= 15 ? { ...b, on: false } : b));
    const n = judge(SNOOKER_RULES, f, { firstHit: 1, potted: [1, 0] });
    expect(SNOOKER_RULES.ballsOn(n)).toEqual([YELLOW]);
  });
  it('no cue ball in a pocket mouth when in hand', () => {
    for (const variant of ['us8', 'uk8', 'snooker', 'nine'] as const) {
      const m = newMatch({ variant, raceTo: 1, names: ['A', 'B'], seed: 1 });
      const t = { ...m, frame: { ...m.frame, inHand: 'anywhere' as const } };
      const L = VARIANT_TABLE[variant].length / 2;
      const W = VARIANT_TABLE[variant].width / 2;
      const R = VARIANT_TABLE[variant].ballRadius;
      expect(canPlace(t, L - R - 1e-6, W - R - 1e-6), variant).toBe(false);
      expect(canPlace(t, 0.1, 0.1), variant).toBe(true);
    }
  });
});

describe('review fixes (batch 3)', () => {
  it('a forfeit after a frame is already over does not count that frame twice', () => {
    let m = newMatch({ variant: 'nine', raceTo: 3, names: ['A', 'B'], seed: 1 });
    m = concede(m, 0);
    m = concede(m, 0, true);
    expect(m.wins).toEqual([0, 1]);
    expect(m.winner).toBe(1);
  });
  it('rejects absurd shot directions', () => {
    const m = newMatch({ variant: 'nine', raceTo: 1, names: ['A', 'B'], seed: 1 });
    expect(checkShot(m, { dx: 1e160, dy: 1e160, power: 0.5, side: 0, height: 0, place: { x: -0.8, y: 0 } })).toMatch(/direction/);
  });
  it('US 8-ball: the 8 alone on the break is spotted and the breaker carries on', () => {
    const n = judge(US8, frame(US8, { shots: 0 }), { firstHit: 1, potted: [8] });
    expect(n.turn).toBe(0);
    expect(n.balls[8].on).toBe(true);
  });
});
