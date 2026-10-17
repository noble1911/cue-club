import { describe, expect, it } from 'vitest';
import { castBall, simulate, summarise, type Ball } from '../src/sim/physics.ts';
import { POOL_UK, POOL_US, SNOOKER, TABLES } from '../src/sim/tables.ts';
import { dcos, dsin } from '../src/sim/dmath.ts';

const ball = (id: number, x: number, y: number): Ball => ({ id, x, y, vx: 0, vy: 0, wx: 0, wy: 0, wz: 0, on: true });
const plain = { side: 0, height: 0 };

describe('dmath', () => {
  it('matches Math.sin/cos closely', () => {
    for (let a = -7; a < 7; a += 0.37) {
      expect(dsin(a)).toBeCloseTo(Math.sin(a), 12);
      expect(dcos(a)).toBeCloseTo(Math.cos(a), 12);
    }
  });
});

describe('physics', () => {
  it('a rolling ball slows and stops in a straight line', () => {
    const r = simulate(SNOOKER, [ball(0, -1, 0)], { dx: 1, dy: 0, power: 0.2, ...plain });
    expect(r.balls[0].x).toBeGreaterThan(-0.5);
    expect(r.balls[0].y).toBe(0);
    expect(r.balls[0].vx).toBe(0);
  });

  it('screw comes back, follow goes through, stun stops near contact', () => {
    const at = (height: number) => simulate(SNOOKER, [ball(0, -0.5, 0), ball(1, 0, 0)], { dx: 1, dy: 0, power: 0.35, side: 0, height }).balls[0].x;
    const contact = -2 * SNOOKER.ballRadius;
    expect(at(-1)).toBeLessThan(contact - 0.1);
    expect(at(1)).toBeGreaterThan(0.3);
    expect(Math.abs(at(-0.45) - contact)).toBeLessThan(0.12);
  });

  it('right-hand side throws the cue ball right off a cushion', () => {
    const r = simulate(SNOOKER, [ball(0, 1.2, 0)], { dx: 1, dy: 0, power: 0.3, side: 1, height: 0 });
    expect(r.balls[0].y).toBeLessThan(-0.05); // −y is the shooter's right facing +x
    const l = simulate(SNOOKER, [ball(0, 1.2, 0)], { dx: 1, dy: 0, power: 0.3, side: -1, height: 0 });
    expect(l.balls[0].y).toBeGreaterThan(0.05);
  });

  it('angle in is roughly angle out off a cushion', () => {
    const r = simulate(POOL_US, [ball(0, 0, 0)], { dx: 0.7071, dy: 0.7071, power: 0.15, side: 0, height: 0.4 }, { record: true });
    const hit = r.events.find((e) => e.type === 'cushion')!;
    expect(hit).toBeTruthy();
    // after bouncing off the long cushion (+y) the ball heads +x, −y
    const last = r.balls[0];
    expect(last.x).toBeGreaterThan(0.3);
    expect(last.y).toBeLessThan(POOL_US.width / 2);
  });

  it('pots a straight ball into every pocket of every table', () => {
    for (const t of Object.values(TABLES)) {
      t.pockets.forEach((p, i) => {
        const ox = p.aim.x * 0.6;
        const oy = p.aim.y * 0.6;
        const ux = p.aim.x - ox;
        const uy = p.aim.y - oy;
        const l = Math.sqrt(ux * ux + uy * uy);
        const r = simulate(t, [ball(0, ox - (ux / l) * 0.4, oy - (uy / l) * 0.4), ball(1, ox, oy)], { dx: ux / l, dy: uy / l, power: 0.4, side: 0, height: -0.6 });
        const s = summarise(r.events);
        expect(s.potted, `${t.id} pocket ${i}`).toContain(1);
        expect(s.pockets[1]).toBe(i);
      });
    }
  });

  it('never lets a ball through a cushion', () => {
    for (let a = 0; a < 6.28; a += 0.21) {
      const r = simulate(POOL_UK, [ball(0, 0.1, 0.05)], { dx: Math.cos(a), dy: Math.sin(a), power: 1, side: 0.5, height: 0.5 }, { record: true });
      for (const f of r.frames) {
        const onTable = Math.abs(f[0]) <= POOL_UK.length / 2 + 0.01 || Math.abs(f[1]) <= POOL_UK.width / 2 + 0.01;
        expect(onTable).toBe(true);
      }
      const b = r.balls[0];
      if (b.on) {
        expect(Math.abs(b.x)).toBeLessThanOrEqual(POOL_UK.length / 2);
        expect(Math.abs(b.y)).toBeLessThanOrEqual(POOL_UK.width / 2);
      }
    }
  });

  it('is deterministic: the same break twice gives identical balls', () => {
    const rack = [ball(0, -1.2, 0.05)];
    let id = 1;
    for (let row = 0; row < 5; row++) for (let j = 0; j <= row; j++) rack.push(ball(id++, 0.9 + row * 0.0526 * 0.866, (j - row / 2) * 0.0526));
    const shot = { dx: 1, dy: 0.001, power: 1, side: 0.2, height: 0.1 };
    const a = simulate(SNOOKER, rack, shot);
    const b = simulate(SNOOKER, rack, shot);
    expect(JSON.stringify(a.balls)).toBe(JSON.stringify(b.balls));
    expect(a.events.length).toBe(b.events.length);
  });

  it('castBall finds the first ball on the line and the cushion otherwise', () => {
    const balls = [ball(0, -0.5, 0), ball(1, 0, 0), ball(2, 0.3, 0)];
    const hit = castBall(SNOOKER, balls, 0, -0.5, 0, 1, 0);
    expect(hit.ball).toBe(1);
    expect(hit.dist).toBeCloseTo(0.5 - 2 * SNOOKER.ballRadius, 6);
    const miss = castBall(SNOOKER, balls, 0, -0.5, 0, 0, 1);
    expect(miss.ball).toBe(-1);
    expect(miss.dist).toBeCloseTo(SNOOKER.width / 2 - SNOOKER.ballRadius, 4);
  });
});

describe('throw', () => {
  it('right-hand side throws a head-on object ball to the left (spin-induced throw)', () => {
    const r = simulate(SNOOKER, [ball(0, -0.4, 0), ball(1, 0, 0)], { dx: 1, dy: 0, power: 0.3, side: 1, height: 0 });
    expect(r.balls[1].y).toBeGreaterThan(0); // +y is left of a shot along +x
    const l = simulate(SNOOKER, [ball(0, -0.4, 0), ball(1, 0, 0)], { dx: 1, dy: 0, power: 0.3, side: -1, height: 0 });
    expect(l.balls[1].y).toBeLessThan(0);
  });
});

describe('cut shots go where the ghost ball says', () => {
  it('a perfectly aimed cut pots, and throw stays small (it used to miss every cut over 20°)', () => {
    const R = SNOOKER.ballRadius;
    const P = SNOOKER.pockets[0];
    const u = { x: Math.SQRT1_2, y: Math.SQRT1_2 };
    for (const cut of [15, 30, 45, 60]) {
      for (const power of [0.4, 0.7]) {
        const ob = { x: P.aim.x - u.x * 1.0, y: P.aim.y - u.y * 1.0 };
        const gx = ob.x - u.x * 2 * R;
        const gy = ob.y - u.y * 2 * R;
        const a = Math.atan2(u.y, u.x) + (cut * Math.PI) / 180;
        const r = simulate(SNOOKER, [ball(0, gx - Math.cos(a) * 0.6, gy - Math.sin(a) * 0.6), ball(1, ob.x, ob.y)], { dx: Math.cos(a), dy: Math.sin(a), power, side: 0, height: 0 }, { record: true });
        expect(summarise(r.events).potted, `${cut}° at power ${power}`).toContain(1);
        // the object ball's line just after contact, against the line to the pocket
        const hit = r.events.find((e) => e.type === 'ball')!;
        const i = Math.ceil((hit.t + 0.05) * 60);
        const f0 = r.frames[i - 3];
        const f1 = r.frames[i];
        const err = Math.abs(Math.atan2(f1[6] - f0[6], f1[5] - f0[5]) - Math.atan2(u.y, u.x)) * (180 / Math.PI);
        expect(err, `${cut}° at power ${power}: ${err.toFixed(2)}° off`).toBeLessThan(1.5);
      }
    }
  });
});
