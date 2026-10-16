// Ball physics: sliding and rolling on the cloth, spin, ball-ball and cushion impacts, pockets.
//
// Each ball has a position, a velocity and an angular velocity (wx, wy about the horizontal
// axes, wz about the vertical one). The contact point with the cloth slides while
// u = v + w × (−R ẑ) ≠ 0; sliding friction drives u to zero (7/2 times faster than it slows the
// ball), after which the ball rolls and only rolling resistance acts. That one model gives stun,
// screw (draw) and follow for free: an impact swaps linear velocity but leaves spin alone, so a
// back-spun cue ball stops dead and friction then drags it back.
//
// Deterministic: only + − × ÷ √ (see dmath.ts), fixed time steps, fixed iteration order. The
// server runs the same code to referee, the browsers to animate.

import type { TableSpec } from './tables.ts';

export interface Ball {
  id: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  wx: number;
  wy: number;
  wz: number;
  /** Still on the table (false once potted). */
  on: boolean;
}

/** What the player does. `dx, dy` is a unit vector; `side` and `height` are the tip's offset
 *  from the centre of the cue ball as a fraction of the maximum (−1…1, right/top positive). */
export interface Shot {
  dx: number;
  dy: number;
  /** 0…1 of the table's maximum speed. */
  power: number;
  side: number;
  height: number;
  /** Where the cue ball was placed first, when it was in hand. */
  place?: { x: number; y: number };
}

export type SimEvent =
  | { t: number; type: 'ball'; a: number; b: number; speed: number }
  | { t: number; type: 'cushion'; a: number; speed: number }
  | { t: number; type: 'pot'; a: number; pocket: number; speed: number };

export interface SimResult {
  balls: Ball[];
  events: SimEvent[];
  /** Seconds until everything stopped. */
  duration: number;
  /** Per recorded frame (FRAME_DT apart): x, y, wx, wy, wz for every ball, in id order. */
  frames: Float32Array[];
}

export const FRAME_DT = 1 / 60;
const DT = 1 / 1000;
const G = 9.81;
const MAX_TIME = 40;
/** How far the cue tip can be off centre at full side or screw, as a fraction of the radius. */
export const MAX_TIP_OFFSET = 0.55;

export function cloneBalls(balls: readonly Ball[]): Ball[] {
  return balls.map((b) => ({ ...b }));
}

export function speedFor(table: TableSpec, power: number): number {
  const p = Math.min(1, Math.max(0, power));
  // a gentle curve: fine control at the soft end where most positional shots live
  return table.maxSpeed * (0.04 + 0.96 * p * (0.35 + 0.65 * p));
}

/** Set the cue ball moving: speed along (dx, dy), spin from where the tip struck it. */
export function strike(table: TableSpec, cue: Ball, shot: Shot): void {
  const R = table.ballRadius;
  const len = Math.sqrt(shot.dx * shot.dx + shot.dy * shot.dy) || 1;
  const dx = shot.dx / len;
  const dy = shot.dy / len;
  const v = speedFor(table, shot.power);
  const a = clamp(shot.side, -1, 1) * MAX_TIP_OFFSET * R;
  const b = clamp(shot.height, -1, 1) * MAX_TIP_OFFSET * R;
  // A level cue striking at height b gives angular speed 5vb/2R² about the horizontal axis
  // across the shot (b = 2R/5 is a natural roll), and at side offset a the same about vertical.
  const k = (5 * v) / (2 * R * R);
  const spin = k * b;
  cue.vx = dx * v;
  cue.vy = dy * v;
  // rolling forwards along (dx, dy) means (wx, wy) = (−dy, dx)·w
  cue.wx = -dy * spin;
  cue.wy = dx * spin;
  cue.wz = k * a; // right-hand side (a > 0) spins anticlockwise seen from above
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function moving(b: Ball): boolean {
  return b.on && (b.vx !== 0 || b.vy !== 0 || b.wx !== 0 || b.wy !== 0);
}

/** Advance one ball's motion over h seconds on the cloth (no collisions). */
function integrate(t: TableSpec, b: Ball, h: number): void {
  const R = t.ballRadius;
  let rest = h;
  // contact-point slip
  const ux = b.vx - R * b.wy;
  const uy = b.vy + R * b.wx;
  const u = Math.sqrt(ux * ux + uy * uy);
  if (u > 1e-9) {
    const a = t.muSlide * G;
    const tRoll = u / (3.5 * a);
    const s = tRoll < h ? tRoll : h;
    const nx = ux / u;
    const ny = uy / u;
    b.x += b.vx * s - 0.5 * a * nx * s * s;
    b.y += b.vy * s - 0.5 * a * ny * s * s;
    b.vx -= a * nx * s;
    b.vy -= a * ny * s;
    b.wx -= (2.5 * a * ny * s) / R;
    b.wy += (2.5 * a * nx * s) / R;
    rest = h - s;
    if (tRoll <= h) {
      // now rolling: pin the spin to the velocity exactly
      b.wx = -b.vy / R;
      b.wy = b.vx / R;
    }
  }
  if (rest > 0) {
    const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    if (sp > 0) {
      const dec = t.muRoll * G;
      const tStop = sp / dec;
      const s = tStop < rest ? tStop : rest;
      const k = (sp - dec * s) / sp;
      const avg = (1 + k) * 0.5;
      b.x += b.vx * s * avg;
      b.y += b.vy * s * avg;
      b.vx *= k;
      b.vy *= k;
      if (tStop <= rest) {
        b.vx = 0;
        b.vy = 0;
      }
      b.wx = -b.vy / R;
      b.wy = b.vx / R;
    }
  }
  // spin about the vertical decays on its own
  if (b.wz !== 0) {
    const dz = ((5 * t.muSpin * G) / (2 * R)) * h;
    b.wz = b.wz > 0 ? (b.wz > dz ? b.wz - dz : 0) : b.wz < -dz ? b.wz + dz : 0;
  }
  // tiny residues stop the ball
  if (b.vx * b.vx + b.vy * b.vy < 1e-10 && Math.abs(b.vx - R * b.wy) + Math.abs(b.vy + R * b.wx) < 1e-6) {
    b.vx = 0;
    b.vy = 0;
    b.wx = 0;
    b.wy = 0;
  }
}

function ballBall(t: TableSpec, a: Ball, b: Ball, time: number, events: SimEvent[]): boolean {
  const R2 = 2 * t.ballRadius;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d2 = dx * dx + dy * dy;
  if (d2 >= R2 * R2 || d2 === 0) return false;
  const d = Math.sqrt(d2);
  const nx = dx / d;
  const ny = dy / d;
  const approach = (a.vx - b.vx) * nx + (a.vy - b.vy) * ny;
  // push apart along the line of centres
  const push = (R2 - d) * 0.5;
  a.x -= nx * push;
  a.y -= ny * push;
  b.x += nx * push;
  b.y += ny * push;
  if (approach <= 0) return false;
  const p = ((1 + t.eBall) / 2) * approach;
  a.vx -= p * nx;
  a.vy -= p * ny;
  b.vx += p * nx;
  b.vy += p * ny;
  // A touch of throw: friction between the balls drags the object ball along the cue ball's
  // slip, limited to a small fraction of the normal impulse.
  const tx = -ny;
  const ty = nx;
  const R = t.ballRadius;
  const slip = (a.vx - b.vx) * tx + (a.vy - b.vy) * ty - R * (a.wz + b.wz);
  const jt = clamp(-slip / 7, -0.05 * p, 0.05 * p);
  a.vx += jt * tx;
  a.vy += jt * ty;
  b.vx -= jt * tx;
  b.vy -= jt * ty;
  events.push({ t: time, type: 'ball', a: a.id, b: b.id, speed: approach });
  return true;
}

function cushion(t: TableSpec, b: Ball, time: number, events: SimEvent[]): void {
  const R = t.ballRadius;
  for (let i = 0; i < t.cushions.length; i++) {
    const s = t.cushions[i];
    const ex = s.bx - s.ax;
    const ey = s.by - s.ay;
    const len2 = ex * ex + ey * ey;
    let k = ((b.x - s.ax) * ex + (b.y - s.ay) * ey) / len2;
    k = k < 0 ? 0 : k > 1 ? 1 : k;
    const qx = s.ax + ex * k;
    const qy = s.ay + ey * k;
    const dx = b.x - qx;
    const dy = b.y - qy;
    const d2 = dx * dx + dy * dy;
    if (d2 >= R * R || d2 === 0) continue;
    const d = Math.sqrt(d2);
    const nx = dx / d;
    const ny = dy / d;
    b.x = qx + nx * R;
    b.y = qy + ny * R;
    const vn = b.vx * nx + b.vy * ny;
    if (vn >= 0) continue;
    const tx = -ny;
    const ty = nx;
    const vt = b.vx * tx + b.vy * ty;
    // normal: bounce with restitution
    const jn = -(1 + t.eCushion) * vn;
    // tangential: friction at the contact point pulls the slip (from sliding and side) to zero
    const slip = vt - b.wz * R;
    const jt = clamp(-slip / 3.5, -t.muCushion * jn, t.muCushion * jn);
    const vn2 = -t.eCushion * vn;
    const vt2 = vt + jt;
    b.wz -= (2.5 * jt) / R;
    // the cushion nose sits above the ball's equator and kills most of the roll into the rail
    const sx = R * b.wy;
    const sy = -R * b.wx;
    const sn = (sx * nx + sy * ny) * 0.15;
    const st = sx * tx + sy * ty;
    b.wy = (sn * nx + st * tx) / R;
    b.wx = -(sn * ny + st * ty) / R;
    b.vx = vn2 * nx + vt2 * tx;
    b.vy = vn2 * ny + vt2 * ty;
    events.push({ t: time, type: 'cushion', a: b.id, speed: -vn });
  }
}

function pocketed(t: TableSpec, b: Ball): number {
  const R = t.ballRadius;
  for (let i = 0; i < t.pockets.length; i++) {
    const p = t.pockets[i];
    const dx = b.x - p.x;
    const dy = b.y - p.y;
    if (dx * dx + dy * dy < p.r * p.r) return i;
  }
  // past a cushion line by a radius can only be inside a pocket's throat
  if (Math.abs(b.x) > t.length / 2 + R || Math.abs(b.y) > t.width / 2 + R) {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < t.pockets.length; i++) {
      const p = t.pockets[i];
      const d = (b.x - p.x) * (b.x - p.x) + (b.y - p.y) * (b.y - p.y);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }
  return -1;
}

export interface SimOptions {
  /** Record animation frames (the AI's look-ahead doesn't need them). */
  record?: boolean;
}

/** Strike the cue ball (balls[0]) and run until everything stops. `balls` is not modified. */
export function simulate(table: TableSpec, start: readonly Ball[], shot: Shot, opts: SimOptions = {}): SimResult {
  const balls = cloneBalls(start);
  const cue = balls[0];
  if (shot.place) {
    cue.x = shot.place.x;
    cue.y = shot.place.y;
    cue.on = true;
  }
  strike(table, cue, shot);
  return run(table, balls, opts);
}

/** Run the balls as they are until they all stop. Modifies and returns `balls`. */
export function run(table: TableSpec, balls: Ball[], opts: SimOptions = {}): SimResult {
  const events: SimEvent[] = [];
  const frames: Float32Array[] = [];
  const n = balls.length;
  const R = table.ballRadius;
  const record = (): void => {
    const f = new Float32Array(n * 5);
    for (let i = 0; i < n; i++) {
      const b = balls[i];
      f[i * 5] = b.x;
      f[i * 5 + 1] = b.y;
      f[i * 5 + 2] = b.wx;
      f[i * 5 + 3] = b.wy;
      f[i * 5 + 4] = b.wz;
    }
    frames.push(f);
  };
  if (opts.record) record();
  let time = 0;
  let nextFrame = FRAME_DT;
  const active: Ball[] = [];
  while (time < MAX_TIME) {
    active.length = 0;
    let vmax = 0;
    for (let i = 0; i < n; i++) {
      const b = balls[i];
      if (!moving(b)) continue;
      active.push(b);
      const v2 = b.vx * b.vx + b.vy * b.vy;
      if (v2 > vmax) vmax = v2;
    }
    if (active.length === 0) break;
    // split the step so nothing moves more than a fifth of a radius at once
    const travel = Math.sqrt(vmax) * DT;
    const sub = travel > R * 0.2 ? Math.ceil(travel / (R * 0.2)) : 1;
    const h = DT / sub;
    for (let s = 0; s < sub; s++) {
      for (let i = 0; i < n; i++) if (moving(balls[i])) integrate(table, balls[i], h);
      time += h;
      // balls: every pair with at least one of them moving, in a fixed (id) order
      for (let i = 0; i < n; i++) {
        const a = balls[i];
        if (!a.on) continue;
        const am = moving(a);
        for (let j = i + 1; j < n; j++) {
          const b = balls[j];
          if (!b.on || (!am && !moving(b))) continue;
          const dx = b.x - a.x;
          if (dx > 2.2 * R || dx < -2.2 * R) continue;
          ballBall(table, a, b, time, events);
        }
      }
      for (let i = 0; i < n; i++) {
        const b = balls[i];
        if (!b.on) continue;
        // only balls near the edge can touch a cushion
        if (Math.abs(b.x) > table.length / 2 - 2 * R || Math.abs(b.y) > table.width / 2 - 2 * R) cushion(table, b, time, events);
        const p = pocketed(table, b);
        if (p >= 0) {
          events.push({ t: time, type: 'pot', a: b.id, pocket: p, speed: Math.sqrt(b.vx * b.vx + b.vy * b.vy) });
          b.on = false;
          b.vx = b.vy = b.wx = b.wy = b.wz = 0;
        }
      }
    }
    if (opts.record) {
      while (time >= nextFrame) {
        record();
        nextFrame += FRAME_DT;
      }
    }
  }
  for (const b of balls) b.wz = 0;
  if (opts.record) record();
  return { balls, events, duration: time, frames };
}

// ------------------------------------------------------------------ what happened

export interface ShotSummary {
  /** First ball the cue ball touched, or −1. */
  firstHit: number;
  /** Potted balls in the order they dropped (the cue ball is id 0). */
  potted: number[];
  /** Which pocket each potted ball went into. */
  pockets: Record<number, number>;
  cuePotted: boolean;
  /** Any ball touched a cushion after the cue ball's first contact. */
  cushionAfterContact: boolean;
  /** Object balls that touched a cushion (for break rules). */
  objectCushions: number;
}

export function summarise(events: readonly SimEvent[]): ShotSummary {
  let firstHit = -1;
  const potted: number[] = [];
  const pockets: Record<number, number> = {};
  let cushionAfterContact = false;
  const touched = new Set<number>();
  for (const e of events) {
    if (e.type === 'ball') {
      if (firstHit < 0 && (e.a === 0 || e.b === 0)) firstHit = e.a === 0 ? e.b : e.a;
    } else if (e.type === 'cushion') {
      if (firstHit >= 0) cushionAfterContact = true;
      if (e.a !== 0) touched.add(e.a);
    } else if (e.type === 'pot') {
      potted.push(e.a);
      pockets[e.a] = e.pocket;
      if (firstHit >= 0) cushionAfterContact = true; // a pot counts as reaching a cushion
    }
  }
  return { firstHit, potted, pockets, cuePotted: potted.includes(0), cushionAfterContact, objectCushions: touched.size };
}

// ------------------------------------------------------------------ prediction (aim line, AI)

export interface RayHit {
  /** Distance the cue ball's centre travels before contact. */
  dist: number;
  /** Ball hit (−1 for a cushion, −2 for nothing within reach / a pocket mouth). */
  ball: number;
  /** Normal at contact (from the obstacle towards the moving ball's centre). */
  nx: number;
  ny: number;
}

/** Where does a ball at (x, y) moving along unit (dx, dy) first touch something? */
export function castBall(table: TableSpec, balls: readonly Ball[], fromId: number, x: number, y: number, dx: number, dy: number): RayHit {
  const R = table.ballRadius;
  let best: RayHit = { dist: Infinity, ball: -2, nx: 0, ny: 0 };
  for (const b of balls) {
    if (!b.on || b.id === fromId) continue;
    const ox = b.x - x;
    const oy = b.y - y;
    const along = ox * dx + oy * dy;
    if (along <= 0) continue;
    const perp2 = ox * ox + oy * oy - along * along;
    const r2 = 4 * R * R;
    if (perp2 >= r2) continue;
    const d = along - Math.sqrt(r2 - perp2);
    if (d < best.dist && d > -R) {
      const cx = x + dx * d;
      const cy = y + dy * d;
      const nl = Math.sqrt((cx - b.x) * (cx - b.x) + (cy - b.y) * (cy - b.y)) || 1;
      best = { dist: Math.max(0, d), ball: b.id, nx: (cx - b.x) / nl, ny: (cy - b.y) / nl };
    }
  }
  for (const s of table.cushions) {
    const hit = rayCapsule(x, y, dx, dy, s.ax, s.ay, s.bx, s.by, R);
    if (hit && hit.dist < best.dist) best = { dist: hit.dist, ball: -1, nx: hit.nx, ny: hit.ny };
  }
  return best;
}

function rayCapsule(px: number, py: number, dx: number, dy: number, ax: number, ay: number, bx: number, by: number, r: number) {
  let best: { dist: number; nx: number; ny: number } | null = null;
  const ex = bx - ax;
  const ey = by - ay;
  const len = Math.sqrt(ex * ex + ey * ey);
  const tx = ex / len;
  const ty = ey / len;
  // the two offset faces of the segment
  for (const side of [1, -1]) {
    const nx = -ty * side;
    const ny = tx * side;
    const ox = ax + nx * r;
    const oy = ay + ny * r;
    const denom = dx * nx + dy * ny;
    if (denom >= 0) continue; // moving away from this face
    const d = ((ox - px) * nx + (oy - py) * ny) / denom;
    if (d < 0) continue;
    const hx = px + dx * d - ox;
    const hy = py + dy * d - oy;
    const along = hx * tx + hy * ty;
    if (along < 0 || along > len) continue;
    if (!best || d < best.dist) best = { dist: d, nx, ny };
  }
  // the rounded ends
  for (const [cx, cy] of [
    [ax, ay],
    [bx, by],
  ]) {
    const ox = cx - px;
    const oy = cy - py;
    const along = ox * dx + oy * dy;
    if (along <= 0) continue;
    const perp2 = ox * ox + oy * oy - along * along;
    if (perp2 >= r * r) continue;
    const d = along - Math.sqrt(r * r - perp2);
    if (d < 0) continue;
    if (!best || d < best.dist) {
      const hx = px + dx * d - cx;
      const hy = py + dy * d - cy;
      const l = Math.sqrt(hx * hx + hy * hy) || 1;
      best = { dist: d, nx: hx / l, ny: hy / l };
    }
  }
  return best;
}

/** Is the straight path of a ball from (x0,y0) to (x1,y1) clear of every ball but `ignore`? */
export function pathClear(table: TableSpec, balls: readonly Ball[], x0: number, y0: number, x1: number, y1: number, ignore: readonly number[]): boolean {
  const R2 = 2 * table.ballRadius;
  const ex = x1 - x0;
  const ey = y1 - y0;
  const len2 = ex * ex + ey * ey;
  if (len2 === 0) return true;
  for (const b of balls) {
    if (!b.on || ignore.includes(b.id)) continue;
    let k = ((b.x - x0) * ex + (b.y - y0) * ey) / len2;
    k = k < 0 ? 0 : k > 1 ? 1 : k;
    const dx = b.x - (x0 + ex * k);
    const dy = b.y - (y0 + ey * k);
    if (dx * dx + dy * dy < R2 * R2 * 0.98) return false;
  }
  return true;
}
