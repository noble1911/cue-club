// Every texture is drawn on a canvas at start-up: cloth (with the table's markings), wood, and
// the balls. No image files to load, and each table gets its own markings.

import * as THREE from 'three';
import type { BallLook } from '../sim/rules/types.ts';
import type { TableSpec } from '../sim/tables.ts';

function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}

function noise(ctx: CanvasRenderingContext2D, w: number, h: number, amount: number, seed = 1): void {
  const img = ctx.getImageData(0, 0, w, h);
  let s = seed;
  for (let i = 0; i < img.data.length; i += 4) {
    s = (s * 16807) % 2147483647;
    const n = ((s / 2147483647) - 0.5) * amount;
    img.data[i] += n;
    img.data[i + 1] += n;
    img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);
}

/**
 * The bed cloth, covering the bed plus the cushion width all round (`ext` × 2 on each axis), so
 * the texture lines up with the cloth shape's UVs (u along x, v along y).
 */
export function clothTexture(t: TableSpec, ext: number): THREE.Texture {
  const L = t.length + 2 * ext;
  const W = t.width + 2 * ext;
  const ppm = 700; // pixels per metre (capped below for the big table)
  const w = Math.min(4096, Math.round(L * ppm));
  const h = Math.round((w * W) / L);
  const [c, ctx] = canvas(w, h);
  ctx.fillStyle = t.cloth;
  ctx.fillRect(0, 0, w, h);
  noise(ctx, w, h, 14);
  // a soft lighter pool of light in the middle
  const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w * 0.6);
  g.addColorStop(0, 'rgba(255,255,255,0.05)');
  g.addColorStop(1, 'rgba(0,0,0,0.12)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  // markings, in table coordinates: x → right, y → up the canvas (v = 0 at the bottom: flipY)
  const px = (x: number) => ((x + L / 2) / L) * w;
  const py = (y: number) => h - ((y + W / 2) / W) * h;
  const s = w / L;
  ctx.strokeStyle = 'rgba(240,240,225,0.55)';
  ctx.fillStyle = 'rgba(240,240,225,0.7)';
  ctx.lineWidth = Math.max(1.5, 0.0025 * s);
  const spot = (x: number, y: number, r = 0.004) => {
    ctx.beginPath();
    ctx.arc(px(x), py(y), r * s, 0, Math.PI * 2);
    ctx.fill();
  };
  if (t.id === 'snooker') {
    ctx.beginPath();
    ctx.moveTo(px(t.baulkX), py(-t.width / 2));
    ctx.lineTo(px(t.baulkX), py(t.width / 2));
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(px(t.baulkX), py(0), t.dRadius * s, Math.PI / 2, (Math.PI * 3) / 2);
    ctx.stroke();
    for (const [x, y] of [
      [t.baulkX, -t.dRadius],
      [t.baulkX, t.dRadius],
      [t.baulkX, 0],
      [0, 0],
      [t.length / 4, 0],
      [t.length / 2 - 0.324, 0],
    ])
      spot(x, y, 0.0035);
  } else {
    if (t.id === 'pool-uk') {
      ctx.beginPath();
      ctx.moveTo(px(t.baulkX), py(-t.width / 2));
      ctx.lineTo(px(t.baulkX), py(t.width / 2));
      ctx.stroke();
    }
    spot(t.footSpot.x, t.footSpot.y, 0.006);
    if (t.id === 'pool-us') spot(t.baulkX, 0, 0.004);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** Wood grain running along u. */
export function woodTexture(base: string, dark: string, seed = 3): THREE.Texture {
  const [c, ctx] = canvas(1024, 256);
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 1024, 256);
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 140; i++) {
    const y = rnd() * 256;
    ctx.strokeStyle = dark;
    ctx.globalAlpha = 0.06 + rnd() * 0.18;
    ctx.lineWidth = 0.5 + rnd() * 2.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let x = 0; x <= 1024; x += 32) ctx.lineTo(x, y + Math.sin(x / (60 + rnd() * 90) + i) * (2 + rnd() * 5));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  noise(ctx, 1024, 256, 10, seed);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = 8;
  return tex;
}

/**
 * A ball's skin, equirectangular (2:1) for three's SphereGeometry: u around the equator, v pole to
 * pole. Near the equator a circle of radius r pixels on the canvas is a circle on the ball.
 */
export function ballTexture(look: BallLook, isCue: boolean): THREE.Texture {
  const W = 512;
  const H = 256;
  const [c, ctx] = canvas(W, H);
  const white = '#f6f2e6';
  if (look.stripe) {
    ctx.fillStyle = white;
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = look.color;
    ctx.fillRect(0, H * 0.29, W, H * 0.42);
  } else {
    ctx.fillStyle = look.color;
    ctx.fillRect(0, 0, W, H);
  }
  if (look.number !== undefined) {
    for (const u of [0.25, 0.75]) {
      ctx.fillStyle = white;
      ctx.beginPath();
      ctx.ellipse(u * W, H / 2, 30, 30, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#151515';
      ctx.font = `bold ${look.number > 9 ? 30 : 36}px Georgia, 'Times New Roman', serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(look.number), u * W, H / 2 + 2);
      if (look.number === 6 || look.number === 9) ctx.fillRect(u * W - 8, H / 2 + 17, 16, 2.5);
    }
  }
  if (isCue) {
    // red spots, so you can see the cue ball spin
    ctx.fillStyle = '#c0182a';
    for (const [u, v] of [
      [0, 0.5],
      [0.25, 0.5],
      [0.5, 0.5],
      [0.75, 0.5],
      [0.5, 0.06],
      [0.5, 0.94],
    ]) {
      ctx.beginPath();
      ctx.ellipse(u * W, v * H, v === 0.5 ? 9 : W / 2, 9, 0, 0, Math.PI * 2);
      ctx.fill();
      if (u === 0) {
        ctx.beginPath();
        ctx.ellipse(W, v * H, 9, 9, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
  noise(ctx, W, H, 5);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
