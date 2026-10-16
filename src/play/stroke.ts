// Cueing: turning a player's stroke into a shot.
//
// casual  pick a power, the shot goes exactly where you aimed (8 Ball Pool style).
// club    pull back to a power (shown as a target), then push through. Drifting sideways while
//         you push sends the shot off-line, more so on hard hits; snatching it adds error;
//         decelerating through the ball loses pace (Snooker 19 style).
// pro     no meter: the speed of the push is the power, straightness still counts (Virtual
//         Pool / Pure Pool style).
//
// Pure functions: the browser measures the stroke and sends the resulting shot, which the
// server then referees like any other.

export type Cueing = 'casual' | 'club' | 'pro';
export const CUEINGS: Cueing[] = ['casual', 'club', 'pro'];

export interface StrokeSample {
  /** ms */
  t: number;
  /** Sideways drift from where the stroke started, px (right positive). */
  x: number;
  /** How far the cue is drawn back, 0 (at the ball) … 1 (fully back). */
  pull: number;
}

export interface StrokeResult {
  power: number;
  /** Radians to turn the aim by (positive = anticlockwise from above, i.e. to the left). */
  aimError: number;
  verdict: string;
  clean: boolean;
}

/** Pixels of sideways drift that count as a fully off-line push. */
const DRIFT_PX = 40;
/** A push faster than this (ms, start to strike) is a snatch. */
const SNATCH_MS = 55;

/**
 * Judge the forward stroke (samples from the furthest pull back to the strike).
 * `trackPx` is the length of the stroke pad, for turning pull fractions into speed.
 */
export function judgeStroke(mode: Exclude<Cueing, 'casual'>, forward: StrokeSample[], trackPx: number): StrokeResult {
  if (forward.length < 2) return { power: 0, aimError: 0, verdict: 'No stroke', clean: false };
  const first = forward[0];
  const last = forward[forward.length - 1];
  const dur = Math.max(1, last.t - first.t);
  const travel = first.pull - last.pull;

  // power
  let power: number;
  if (mode === 'club') power = first.pull;
  else {
    // the speed through the last half of the push, as a fraction of a full-length stroke in 130 ms
    // (coarse samples can put the half-way point on the last one: then use the whole push)
    let mid = forward.find((s) => s.pull <= first.pull - travel / 2) ?? first;
    if (last.t - mid.t < 8) mid = first;
    const v = ((mid.pull - last.pull) * trackPx) / Math.max(1, last.t - mid.t);
    power = trackPx > 0 ? v / (trackPx / 130) : 0;
  }

  // deceleration: the last third of the push much slower than the first two thirds
  let decel = false;
  const third = forward.find((s) => s.pull <= first.pull - (travel * 2) / 3);
  if (third && last.t > third.t && third.t > first.t) {
    const early = (first.pull - third.pull) / (third.t - first.t);
    const late = (third.pull - last.pull) / (last.t - third.t);
    if (late < early * 0.45) decel = true;
  }
  if (decel) power *= 0.86;
  power = Math.min(1, Math.max(0.02, power));

  // line: average drift during the push, the harder the hit the more it costs
  const drift = forward.reduce((s, p) => s + (p.x - first.x), 0) / forward.length;
  const off = Math.max(-1.5, Math.min(1.5, drift / DRIFT_PX));
  let aimError = -off * (0.003 + 0.016 * power);
  const snatch = dur < SNATCH_MS;
  if (snatch) aimError += (off >= 0 ? -1 : 1) * 0.004;

  const deg = Math.abs((aimError * 180) / Math.PI);
  let verdict: string;
  if (snatch) verdict = `Snatched it: ${deg.toFixed(1)}° off line`;
  else if (decel) verdict = 'Decelerated through the ball: short of pace';
  else if (deg >= 0.08) verdict = `Pushed ${off > 0 ? 'right' : 'left'}: ${deg.toFixed(1)}° off line`;
  else verdict = 'Smooth, straight cue action';
  return { power, aimError, verdict, clean: !snatch && !decel && deg < 0.08 };
}

/** The keyboard version: a sweeping meter stopped by a key press, `at` 0…1 where it stopped. */
export function judgeMeter(mode: Exclude<Cueing, 'casual'>, target: number, at: number): StrokeResult {
  if (mode === 'pro') {
    const power = Math.min(1, Math.max(0.02, at));
    return { power, aimError: 0, verdict: `Struck at ${Math.round(power * 100)}%`, clean: true };
  }
  const miss = at - target;
  const power = Math.min(1, Math.max(0.02, target + miss * 0.5));
  const aimError = -Math.sign(miss) * Math.min(1, Math.abs(miss) / 0.15) * (0.002 + 0.012 * target);
  const deg = Math.abs((aimError * 180) / Math.PI);
  const clean = Math.abs(miss) < 0.03;
  return { power, aimError, verdict: clean ? 'Timed it perfectly' : `${miss > 0 ? 'Late' : 'Early'}: ${deg.toFixed(1)}° off line`, clean };
}
