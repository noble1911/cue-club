import { describe, expect, it } from 'vitest';
import { judgeMeter, judgeStroke, type StrokeSample } from '../src/play/stroke.ts';

/** A push from `from` (pull fraction) to the ball over `ms`, drifting `drift` px by the end. */
function push(from: number, ms: number, drift = 0, decel = false): StrokeSample[] {
  const out: StrokeSample[] = [];
  for (let i = 0; i <= 20; i++) {
    const k = i / 20;
    // a decelerating push covers most of the way early and crawls at the end
    const along = decel ? (k < 0.6 ? (k / 0.6) * 0.85 : 0.85 + ((k - 0.6) / 0.4) * 0.15) : k;
    out.push({ t: k * ms, x: drift * k, pull: from * (1 - along) });
  }
  return out;
}
const TRACK = 270;

describe('club cueing', () => {
  it('a smooth straight push plays the target power dead straight', () => {
    const r = judgeStroke('club', push(0.6, 250), TRACK);
    expect(r.power).toBeCloseTo(0.6);
    expect(Math.abs(r.aimError)).toBeLessThan(1e-9);
    expect(r.clean).toBe(true);
  });
  it('drifting right sends it right (clockwise), and costs more on a hard hit', () => {
    const soft = judgeStroke('club', push(0.2, 250, 30), TRACK);
    const hard = judgeStroke('club', push(0.9, 250, 30), TRACK);
    expect(soft.aimError).toBeLessThan(0);
    expect(hard.aimError).toBeLessThan(soft.aimError);
    expect(soft.verdict).toMatch(/right/);
    expect(judgeStroke('club', push(0.5, 250, -30), TRACK).aimError).toBeGreaterThan(0);
  });
  it('a snatch adds error, a decelerating push loses pace', () => {
    const snatch = judgeStroke('club', push(0.5, 30), TRACK);
    expect(snatch.clean).toBe(false);
    expect(Math.abs(snatch.aimError)).toBeGreaterThan(0.003);
    const decel = judgeStroke('club', push(0.5, 400, 0, true), TRACK);
    expect(decel.power).toBeLessThan(0.5);
    expect(decel.verdict).toMatch(/Decelerated/);
  });
});

describe('pro cueing', () => {
  it('the faster the push, the harder the hit', () => {
    const slow = judgeStroke('pro', push(0.8, 500), TRACK);
    const fast = judgeStroke('pro', push(0.8, 120), TRACK);
    expect(fast.power).toBeGreaterThan(slow.power * 2);
    expect(fast.power).toBeLessThanOrEqual(1);
  });
});

describe('keyboard meter', () => {
  it('club: stopping on the mark is clean; late or early goes off line', () => {
    expect(judgeMeter('club', 0.5, 0.51).clean).toBe(true);
    const late = judgeMeter('club', 0.5, 0.65);
    expect(late.clean).toBe(false);
    expect(Math.sign(late.aimError)).toBe(-Math.sign(judgeMeter('club', 0.5, 0.35).aimError));
  });
  it('pro: the power is wherever the meter stopped', () => {
    expect(judgeMeter('pro', 0, 0.73).power).toBeCloseTo(0.73);
  });
});

describe('pro cueing, coarse samples', () => {
  it('a fast stroke reported in few samples still plays hard', () => {
    const coarse = [
      { t: 0, x: 0, pull: 1 },
      { t: 30, x: 0, pull: 0.8 },
      { t: 60, x: 0, pull: 0.6 },
      { t: 90, x: 0, pull: 0 },
    ];
    expect(judgeStroke('pro', coarse, 270).power).toBeGreaterThan(0.5);
    expect(Number.isFinite(judgeStroke('pro', coarse, 0).power)).toBe(true);
  });
});
