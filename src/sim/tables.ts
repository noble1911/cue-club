// Table geometry, in metres. Origin at the centre of the bed, x along the length (the baulk or
// head end is at -length/2), y across (+y is on the left when you stand at the baulk end looking
// up the table). Everything the physics needs: the cushion noses as line segments (pocket jaws
// included) and the pockets as capture circles. DOM-free: the server referees with it.

import { dcos, dsin } from './dmath.ts';

export type TableId = 'snooker' | 'pool-uk' | 'pool-us';

export interface Vec {
  x: number;
  y: number;
}

/** A cushion nose (or pocket jaw) the balls bounce off: the segment a→b. */
export interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
}

export interface Pocket {
  x: number;
  y: number;
  /** A ball whose centre comes this close to (x, y) has dropped. */
  r: number;
  kind: 'corner' | 'middle';
  /** Where to aim: the middle of the pocket mouth, just inside the cushion line. */
  aim: Vec;
}

export interface TableSpec {
  id: TableId;
  /** The bed between the cushion noses. */
  length: number;
  width: number;
  ballRadius: number;
  /** Corner and middle pocket mouths, jaw tip to jaw tip. */
  cornerMouth: number;
  middleMouth: number;
  pockets: Pocket[];
  cushions: Segment[];
  /** The baulk line (snooker, UK pool) or head string (US pool): a line x = baulkX. */
  baulkX: number;
  /** Radius of the snooker D (0 when there isn't one). */
  dRadius: number;
  /** Foot spot, where the apex ball of a pool rack sits. */
  footSpot: Vec;
  /** Fastest cue ball the player can hit, m/s. */
  maxSpeed: number;
  /** Cloth: sliding and rolling friction, spin decay. */
  muSlide: number;
  muRoll: number;
  muSpin: number;
  /** Restitution ball-ball and ball-cushion, and cushion friction. */
  eBall: number;
  eCushion: number;
  muCushion: number;
  /** Rendering only: cushion and rail sizes, cloth colour. */
  cushionWidth: number;
  railWidth: number;
  cloth: string;
}

const deg = Math.PI / 180;

interface Dimensions {
  id: TableId;
  length: number;
  width: number;
  ballRadius: number;
  cornerMouth: number;
  middleMouth: number;
  /** Angle between the cushion face and the jaw, measured outside the bed (snooker ~142° corner). */
  cornerJawAngle: number;
  middleJawAngle: number;
  baulkX: number;
  dRadius: number;
  footSpot: Vec;
  maxSpeed: number;
  muRoll: number;
  eCushion: number;
  cushionWidth: number;
  railWidth: number;
  cloth: string;
}

function build(d: Dimensions): TableSpec {
  const L = d.length / 2;
  const W = d.width / 2;
  const R = d.ballRadius;
  const c = d.cornerMouth / Math.SQRT2; // along each rail from the corner to the jaw tip
  const m = d.middleMouth / 2;
  const jawLen = 3 * R;
  const cushions: Segment[] = [];

  // A jaw leaves a tip at (tx, ty), bending away from the cushion face (fx, fy) (the direction
  // the face runs from the tip into the bed) by the jaw angle, turned towards the rail (ox, oy).
  const jaw = (tx: number, ty: number, fx: number, fy: number, ox: number, oy: number, angle: number) => {
    // carry on past the tip (−face), turned out through the cushion line by π − angle
    const turn = Math.PI - angle;
    const dx = -fx * dcos(turn) + ox * dsin(turn);
    const dy = -fy * dcos(turn) + oy * dsin(turn);
    cushions.push({ ax: tx, ay: ty, bx: tx + dx * jawLen, by: ty + dy * jawLen });
  };

  // Long rails (y = ±W), each split by the middle pocket into two runs, and the two end rails.
  for (const sy of [1, -1]) {
    for (const sx of [1, -1]) {
      // run from the middle pocket (x = sx·m) to the corner (x = sx·(L − c)), on y = sy·W
      const x0 = sx * m;
      const x1 = sx * (L - c);
      cushions.push({ ax: x0, ay: sy * W, bx: x1, by: sy * W });
      jaw(x0, sy * W, sx, 0, 0, sy, d.middleJawAngle);
      jaw(x1, sy * W, -sx, 0, 0, sy, d.cornerJawAngle);
    }
  }
  for (const sx of [1, -1]) {
    const y0 = W - c;
    cushions.push({ ax: sx * L, ay: -y0, bx: sx * L, by: y0 });
    jaw(sx * L, y0, 0, -1, sx, 0, d.cornerJawAngle);
    jaw(sx * L, -y0, 0, 1, sx, 0, d.cornerJawAngle);
  }

  const pockets: Pocket[] = [];
  for (const sx of [1, -1]) {
    for (const sy of [1, -1]) {
      const out = 0.55 * R / Math.SQRT2;
      pockets.push({
        x: sx * (L + out),
        y: sy * (W + out),
        r: d.cornerMouth * 0.5,
        kind: 'corner',
        aim: { x: sx * (L - c / 2 + R * 0.35), y: sy * (W - c / 2 + R * 0.35) },
      });
    }
  }
  for (const sy of [1, -1]) {
    pockets.push({ x: 0, y: sy * (W + R), r: 1.5 * R, kind: 'middle', aim: { x: 0, y: sy * (W + 0.3 * R) } });
  }

  return {
    id: d.id,
    length: d.length,
    width: d.width,
    ballRadius: R,
    cornerMouth: d.cornerMouth,
    middleMouth: d.middleMouth,
    pockets,
    cushions,
    baulkX: d.baulkX,
    dRadius: d.dRadius,
    footSpot: d.footSpot,
    maxSpeed: d.maxSpeed,
    muSlide: 0.14,
    muRoll: d.muRoll,
    muSpin: 0.044,
    eBall: 0.94,
    eCushion: d.eCushion,
    muCushion: 0.2,
    cushionWidth: d.cushionWidth,
    railWidth: d.railWidth,
    cloth: d.cloth,
  };
}

/** Full-size 12ft snooker table (3569 × 1778 mm bed, 52.5 mm balls). */
export const SNOOKER = build({
  id: 'snooker',
  length: 3.569,
  width: 1.778,
  ballRadius: 0.02625,
  cornerMouth: 0.098,
  middleMouth: 0.112,
  cornerJawAngle: 142 * deg,
  middleJawAngle: 104 * deg,
  baulkX: -3.569 / 2 + 0.737,
  dRadius: 0.292,
  footSpot: { x: 3.569 / 4, y: 0 },
  maxSpeed: 6.5,
  muRoll: 0.0105,
  eCushion: 0.74,
  cushionWidth: 0.05,
  railWidth: 0.12,
  cloth: '#1f6e3a',
});

/** 7ft UK pub table (72 × 36 in bed, 2 in balls). */
export const POOL_UK = build({
  id: 'pool-uk',
  length: 1.829,
  width: 0.914,
  ballRadius: 0.0254,
  cornerMouth: 0.094,
  middleMouth: 0.102,
  cornerJawAngle: 140 * deg,
  middleJawAngle: 104 * deg,
  baulkX: -1.829 / 2 + 1.829 / 5,
  dRadius: 0,
  footSpot: { x: 1.829 / 4, y: 0 },
  maxSpeed: 6,
  muRoll: 0.012,
  eCushion: 0.76,
  cushionWidth: 0.042,
  railWidth: 0.1,
  cloth: '#24508f',
});

/** 9ft US pool table (100 × 50 in bed, 2¼ in balls). */
export const POOL_US = build({
  id: 'pool-us',
  length: 2.54,
  width: 1.27,
  ballRadius: 0.028575,
  cornerMouth: 0.117,
  middleMouth: 0.133,
  cornerJawAngle: 142 * deg,
  middleJawAngle: 104 * deg,
  baulkX: -2.54 / 4,
  dRadius: 0,
  footSpot: { x: 2.54 / 4, y: 0 },
  maxSpeed: 8,
  muRoll: 0.011,
  eCushion: 0.78,
  cushionWidth: 0.05,
  railWidth: 0.13,
  cloth: '#1b6fa8',
});

export const TABLES: Record<TableId, TableSpec> = { snooker: SNOOKER, 'pool-uk': POOL_UK, 'pool-us': POOL_US };
