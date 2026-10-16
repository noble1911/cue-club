// Deterministic maths for the simulation. +, −, ×, ÷ and √ are exact (IEEE 754) in every JS
// engine, but Math.sin, Math.cos, Math.hypot and friends are only "implementation-approximated":
// Chrome, Safari and Firefox may differ in the last bit, and a pool break is chaotic enough to
// turn one bit into a different pot. The server referees with the same code the browsers animate
// with, so anything in src/sim/ that feeds a ball's motion uses these instead.

/** sin(x) by Taylor series, after reducing x to [−π, π]. Exact to ~1e-16 and the same everywhere. */
export function dsin(x: number): number {
  const TWO_PI = 6.283185307179586;
  const PI = 3.141592653589793;
  x = x - TWO_PI * Math.floor((x + PI) / TWO_PI);
  let term = x;
  let sum = x;
  const x2 = x * x;
  for (let n = 1; n < 14; n++) {
    term = (-term * x2) / ((2 * n) * (2 * n + 1));
    sum += term;
  }
  return sum;
}

export function dcos(x: number): number {
  return dsin(x + 1.5707963267948966);
}

export function dhypot(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}
