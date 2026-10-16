// The table model, built from the same TableSpec the physics uses, so the cushions you see are
// the cushions the balls bounce off. Sim coordinates (x, y) map to three.js (x, height, −y).

import * as THREE from 'three';
import type { TableSpec } from '../sim/tables.ts';
import { clothTexture, woodTexture } from './textures.ts';

interface Circle {
  x: number;
  y: number;
  r: number;
}

/**
 * Outline of a rectangle (half sizes A × B) with circles either added to it (`union`, the rail's
 * inner edge with the pocket openings) or bitten out of it (the bed). Walks round the rectangle
 * anticlockwise and, wherever a circle crosses the edge, swaps that stretch for the circle's arc
 * (the outside arc for a union, the inside one for a bite). Each circle must cross the edge
 * exactly twice and the circles mustn't overlap: true of pockets.
 */
export function outline(A: number, B: number, circles: Circle[], mode: 'union' | 'subtract', perCircle = 40): THREE.Vector2[] {
  const P = 4 * A + 4 * B;
  const at = (s: number): THREE.Vector2 => {
    s = ((s % P) + P) % P;
    if (s < 2 * A) return new THREE.Vector2(-A + s, -B);
    s -= 2 * A;
    if (s < 2 * B) return new THREE.Vector2(A, -B + s);
    s -= 2 * B;
    if (s < 2 * A) return new THREE.Vector2(A - s, B);
    s -= 2 * A;
    return new THREE.Vector2(-A, B - s);
  };
  const corners = [0, 2 * A, 2 * A + 2 * B, 4 * A + 2 * B];
  const inside = (c: Circle, p: THREE.Vector2) => (p.x - c.x) ** 2 + (p.y - c.y) ** 2 < c.r * c.r;
  const owner = (p: THREE.Vector2) => circles.find((c) => inside(c, p)) ?? null;
  const inRect = (p: THREE.Vector2) => Math.abs(p.x) <= A + 1e-9 && Math.abs(p.y) <= B + 1e-9;
  /** The perimeter position between s0 (state a) and s1 where the state changes. */
  const edge = (s0: number, s1: number, c: Circle) => {
    const a0 = inside(c, at(s0));
    for (let i = 0; i < 40; i++) {
      const m = (s0 + s1) / 2;
      if (inside(c, at(m)) === a0) s0 = m;
      else s1 = m;
    }
    return (s0 + s1) / 2;
  };
  const N = 6000;
  const ds = P / N;
  let s0 = 0;
  while (owner(at(s0))) s0 += ds;
  const out: THREE.Vector2[] = [at(s0)];
  let cur: Circle | null = null;
  let entered = 0;
  for (let k = 1; k <= N; k++) {
    const prev = s0 + (k - 1) * ds;
    const s = s0 + k * ds;
    const c = owner(at(s));
    if (!cur) {
      // a rectangle corner passed on the way
      for (const cs of corners) {
        for (const base of [0, P]) {
          const cc = cs + base;
          if (cc > prev && cc <= s && !owner(at(cc))) out.push(at(cc));
        }
      }
      if (c) {
        cur = c;
        entered = edge(prev, s, c);
      }
    } else if (c !== cur) {
      const left = edge(prev, s, cur);
      const pIn = at(entered);
      const pOut = at(left);
      const a0 = Math.atan2(pIn.y - cur.y, pIn.x - cur.x);
      const a1 = Math.atan2(pOut.y - cur.y, pOut.x - cur.x);
      let ccw = a1 - a0;
      while (ccw <= 0) ccw += Math.PI * 2;
      const mid = (d: number) => new THREE.Vector2(cur!.x + Math.cos(a0 + d / 2) * cur!.r, cur!.y + Math.sin(a0 + d / 2) * cur!.r);
      const wantOutside = mode === 'union';
      const delta = inRect(mid(ccw)) !== wantOutside ? ccw : ccw - Math.PI * 2;
      const n = Math.max(6, Math.ceil((Math.abs(delta) / (Math.PI * 2)) * perCircle * 4));
      out.push(pIn);
      for (let i = 1; i < n; i++) {
        const ang = a0 + (delta * i) / n;
        out.push(new THREE.Vector2(cur.x + Math.cos(ang) * cur.r, cur.y + Math.sin(ang) * cur.r));
      }
      out.push(pOut);
      cur = c;
      if (c) entered = edge(prev, s, c);
    }
  }
  return out.filter((p, i) => i === 0 || p.distanceToSquared(out[i - 1]) > 1e-12);
}

/** Lay a shape drawn in sim coordinates flat on the table: (x, y) → (x, 0, −y). */
function flat(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/**
 * One cushion as a solid, from its footprint on the bed (sim coordinates, the nose a→b first).
 * Faces are built triangle by triangle, each turned to face the way it should (outwards for the
 * sides, up for the top, towards the bed for the nose), so none is ever inside out; the top is
 * triangulated with earcut because the ends curve round the pocket openings (concave).
 */
function cushionGeometry(foot: THREE.Vector2[], nx: number, ny: number, h: number): THREE.BufferGeometry {
  const ch = Math.min(0.006, h * 0.3); // chamfer along the nose
  // the footprint must run anticlockwise (seen from above) for the edge normals below
  let pts = foot.slice();
  let noseA = 0;
  if (THREE.ShapeUtils.isClockWise(pts)) {
    pts = pts.reverse();
    noseA = pts.length - 2; // a→b became b→a at the end: nose is pts[n-2]→pts[n-1]... recompute below
  }
  // find the nose edge again: the pair (a, b) = foot[0], foot[1]
  const ia = pts.indexOf(foot[0]);
  const ib = pts.indexOf(foot[1]);
  noseA = ia;
  const top = (i: number) => (i === ia || i === ib ? new THREE.Vector2(pts[i].x + nx * ch, pts[i].y + ny * ch) : pts[i]);
  const V = (p: THREE.Vector2, y: number) => new THREE.Vector3(p.x, y, -p.y);
  const pos: number[] = [];
  const tri = (p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3, out: THREE.Vector3) => {
    const n = new THREE.Vector3().subVectors(q, p).cross(new THREE.Vector3().subVectors(r, p));
    if (n.dot(out) < 0) [q, r] = [r, q];
    pos.push(p.x, p.y, p.z, q.x, q.y, q.z, r.x, r.y, r.z);
  };
  const quad = (p: THREE.Vector3, q: THREE.Vector3, r: THREE.Vector3, s: THREE.Vector3, out: THREE.Vector3) => {
    tri(p, q, r, out);
    tri(p, r, s, out);
  };
  const towardBed = new THREE.Vector3(-nx, 0, ny);
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const p = pts[i];
    const q = pts[j];
    const isNose = (i === ia && j === ib) || (i === ib && j === ia);
    if (isNose) {
      quad(V(p, 0), V(q, 0), V(q, h - ch), V(p, h - ch), towardBed);
      quad(V(p, h - ch), V(q, h - ch), V(top(j), h), V(top(i), h), new THREE.Vector3(-nx, 1, ny));
      continue;
    }
    // outward normal of an anticlockwise edge (sim) → three (x, 0, −y)
    const out = new THREE.Vector3(q.y - p.y, 0, q.x - p.x);
    quad(V(p, 0), V(q, 0), V(top(j), h), V(top(i), h), out);
    // where a side meets the chamfered nose, close the small gap
    if (i === ia || i === ib) tri(V(p, 0), V(p, h - ch), V(top(i), h), out);
    if (j === ia || j === ib) tri(V(q, 0), V(q, h - ch), V(top(j), h), out);
  }
  const contour = pts.map((_, i) => top(i));
  for (const [x, y, z] of THREE.ShapeUtils.triangulateShape(contour, [])) {
    tri(V(contour[x], h), V(contour[y], h), V(contour[z], h), new THREE.Vector3(0, 1, 0));
  }
  void noseA;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.computeVertexNormals();
  return geo;
}

export interface TableModel {
  group: THREE.Group;
  /** Height of the cloth surface (balls sit at ballRadius above it). */
  bedY: number;
  /** Outer half-sizes including rails (for camera framing). */
  outerA: number;
  outerB: number;
  dispose(): void;
}

export function buildTable(t: TableSpec): TableModel {
  const group = new THREE.Group();
  const R = t.ballRadius;
  const L = t.length / 2;
  const W = t.width / 2;
  const cw = t.cushionWidth;
  const rw = t.railWidth;
  const A = L + cw;
  const B = W + cw;
  const OA = A + rw;
  const OB = B + rw;
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T) => (disposables.push(x), x);

  // ---------------------------------------------------------------- cloth
  const clothTex = keep(clothTexture(t, cw));
  const clothMat = keep(new THREE.MeshStandardMaterial({ map: clothTex, roughness: 0.92, metalness: 0 }));
  // the cloth stops exactly where a ball drops (the physics pocket circles)
  const bites: Circle[] = t.pockets.map((p) => ({ x: p.x, y: p.y, r: p.r }));
  const bed = new THREE.Shape(outline(A, B, bites, 'subtract'));
  const bedGeo = keep(new THREE.ShapeGeometry(bed, 1));
  // UVs over the whole cloth rectangle
  const pos = bedGeo.attributes.position;
  const uv = new Float32Array(pos.count * 2);
  for (let i = 0; i < pos.count; i++) {
    uv[i * 2] = (pos.getX(i) + A) / (2 * A);
    uv[i * 2 + 1] = (pos.getY(i) + B) / (2 * B);
  }
  bedGeo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  flat(bedGeo);
  const bedMesh = new THREE.Mesh(bedGeo, clothMat);
  bedMesh.receiveShadow = true;
  group.add(bedMesh);

  // slate edge under the cloth, so the pocket bites have depth
  const slate = new THREE.Mesh(
    keep(flat(new THREE.ExtrudeGeometry(new THREE.Shape(outline(A, B, bites, 'subtract', 24)), { depth: 0.035, bevelEnabled: false }))),
    keep(new THREE.MeshStandardMaterial({ color: new THREE.Color(t.cloth).multiplyScalar(0.55), roughness: 1 })),
  );
  slate.position.y = -0.0355;
  slate.receiveShadow = true;
  group.add(slate);

  // ---------------------------------------------------------------- cushions (from the physics segments)
  // Each run is the main cushion plus its two jaws. The cushion's ends follow the jaw lines out to
  // the back of the cushion (the rail's inner edge): exactly what the balls bounce off.
  interface Run {
    a: THREE.Vector2;
    b: THREE.Vector2;
    ka: THREE.Vector2;
    kb: THREE.Vector2;
    nx: number;
    ny: number;
  }
  const runs: Run[] = [];
  for (let i = 0; i < t.cushions.length; i += 3) {
    const main = t.cushions[i];
    const midX = (main.ax + main.bx) / 2;
    const midY = (main.ay + main.by) / 2;
    const horizontal = Math.abs(main.ay - main.by) < 1e-9;
    const nx = horizontal ? 0 : Math.sign(midX);
    const ny = horizontal ? Math.sign(midY) : 0;
    const back = (j: (typeof t.cushions)[number]) => {
      const dx = j.bx - j.ax;
      const dy = j.by - j.ay;
      const len = Math.hypot(dx, dy);
      const along = (dx * nx + dy * ny) / len;
      const k = cw / Math.max(0.2, along);
      return new THREE.Vector2(j.ax + (dx / len) * k, j.ay + (dy / len) * k);
    };
    // pair each jaw with the tip it starts from (the end rails list their jaws the other way round)
    const j1 = t.cushions[i + 1];
    const j2 = t.cushions[i + 2];
    const startsAtA = (j: typeof j1) => Math.abs(j.ax - main.ax) < 1e-9 && Math.abs(j.ay - main.ay) < 1e-9;
    const [ja, jb] = startsAtA(j1) ? [j1, j2] : [j2, j1];
    runs.push({ a: new THREE.Vector2(main.ax, main.ay), b: new THREE.Vector2(main.bx, main.by), ka: back(ja), kb: back(jb), nx, ny });
  }
  // The opening cut in the rail round each pocket: a circle through the two jaw ends that meet
  // there, bulging out into the rail, so cushion, jaw and rail meet with no gap and no overhang.
  const holes: Circle[] = t.pockets.map((p) => {
    const ends: THREE.Vector2[] = [];
    for (const r of runs) {
      for (const [tip, k] of [
        [r.a, r.ka],
        [r.b, r.kb],
      ] as const) {
        const nearest = t.pockets.reduce((best, q) => (Math.hypot(q.x - tip.x, q.y - tip.y) < Math.hypot(best.x - tip.x, best.y - tip.y) ? q : best));
        if (nearest === p) ends.push(k);
      }
    }
    const [k1, k2] = ends;
    const mx = (k1.x + k2.x) / 2;
    const my = (k1.y + k2.y) / 2;
    const h = Math.hypot(k2.x - k1.x, k2.y - k1.y) / 2;
    // out of the table, square to the chord
    let ux = -(k2.y - k1.y);
    let uy = k2.x - k1.x;
    if (ux * mx + uy * my < 0) [ux, uy] = [-ux, -uy];
    const ul = Math.hypot(ux, uy);
    const r = h * 1.08;
    const d = Math.sqrt(r * r - h * h);
    return { x: mx + (ux / ul) * d, y: my + (uy / ul) * d, r };
  });

  const cushionMat = keep(new THREE.MeshStandardMaterial({ color: new THREE.Color(t.cloth).multiplyScalar(0.8), roughness: 0.9 }));
  const noseH = 1.3 * R;
  for (const r of runs) {
    const mesh = new THREE.Mesh(keep(cushionGeometry([r.a, r.b, r.kb, r.ka], r.nx, r.ny, noseH)), cushionMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // ---------------------------------------------------------------- rails (wood) with pocket openings
  const woodTex = keep(woodTexture('#6b3a1f', '#2a1208'));
  woodTex.repeat.set(4, 1);
  const woodMat = keep(new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.38, metalness: 0.05, color: '#ffffff' }));
  const railH = noseH + 0.006;
  const railShape = new THREE.Shape([new THREE.Vector2(-OA, -OB), new THREE.Vector2(OA, -OB), new THREE.Vector2(OA, OB), new THREE.Vector2(-OA, OB)]);
  railShape.holes.push(new THREE.Path(outline(A - 0.001, B - 0.001, holes, 'union')));
  // deep enough to be the table's sides too (down to the apron)
  const railDepth = railH + 0.17;
  // no bevel: it folds over where the curved pocket openings meet the straight inner edge
  const railGeo = keep(flat(new THREE.ExtrudeGeometry(railShape, { depth: railDepth, bevelEnabled: false, curveSegments: 24 })));
  // planar UVs for the grain
  const rp = railGeo.attributes.position;
  const ruv = new Float32Array(rp.count * 2);
  for (let i = 0; i < rp.count; i++) {
    ruv[i * 2] = rp.getX(i) / (2 * OA);
    ruv[i * 2 + 1] = (rp.getZ(i) + rp.getY(i)) * 1.5;
  }
  railGeo.setAttribute('uv', new THREE.BufferAttribute(ruv, 2));
  const rail = new THREE.Mesh(railGeo, woodMat);
  rail.position.y = -0.17;
  rail.castShadow = true;
  rail.receiveShadow = true;
  group.add(rail);

  // ---------------------------------------------------------------- pockets: dark wells and leather lips
  const wellMat = keep(new THREE.MeshStandardMaterial({ color: '#050505', roughness: 1, side: THREE.DoubleSide }));
  const lipMat = keep(new THREE.MeshStandardMaterial({ color: '#141414', roughness: 0.45, metalness: 0.2 }));
  const metalMat = keep(new THREE.MeshStandardMaterial({ color: t.id === 'snooker' ? '#b8913f' : '#9aa0a6', roughness: 0.25, metalness: 0.9 }));
  for (const [i, pk] of t.pockets.entries()) {
    const p = holes[i];
    const r = p.r;
    const well = new THREE.Mesh(keep(new THREE.CylinderGeometry(r * 0.985, r * 0.8, 0.16, 40, 1, true)), wellMat);
    well.position.set(p.x, -0.08, -p.y);
    // darkness under the drop, where it reaches past the opening (in front of middle pockets)
    const under = new THREE.Mesh(keep(new THREE.CircleGeometry(pk.r * 1.04, 40)), wellMat);
    under.rotation.x = -Math.PI / 2;
    under.position.set(pk.x, -0.04, -pk.y);
    group.add(under);
    // black leather lining the opening where it's cut into the rail (only that arc: towards the
    // bed the opening is open, or it would stand in front of the pocket like a bucket)
    let start = -1;
    let len = 0;
    const N = 180;
    const inRail = (k: number) => {
      const a = (k / N) * Math.PI * 2;
      const x = p.x + Math.cos(a) * r;
      const y = p.y + Math.sin(a) * r;
      return Math.abs(x) > A - 0.002 || Math.abs(y) > B - 0.002;
    };
    for (let k = 0; k < N; k++) {
      if (inRail(k) && !inRail((k + N - 1) % N)) start = k;
    }
    if (start >= 0) {
      while (len < N && inRail((start + len) % N)) len++;
      const phi = (start / N) * Math.PI * 2;
      const liner = new THREE.Mesh(keep(new THREE.CylinderGeometry(r * 0.99, r * 0.99, railH, 40, 1, true, phi + Math.PI / 2, (len / N) * Math.PI * 2)), wellMat);
      liner.position.set(p.x, railH / 2, -p.y);
      group.add(liner);
      // a flat rim on the rail round the same arc (brass/chrome on corners, rubber on middles)
      const rim = new THREE.Mesh(keep(new THREE.RingGeometry(r * 0.99, r + 0.011, 40, 1, phi, (len / N) * Math.PI * 2)), pk.kind === 'corner' ? metalMat : lipMat);
      rim.rotation.x = -Math.PI / 2;
      rim.position.set(p.x, railH + 0.0008, -p.y);
      group.add(rim);
    }
    group.add(well);
    const floor = new THREE.Mesh(keep(new THREE.CircleGeometry(r * 0.8, 32)), wellMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(p.x, -0.15, -p.y);
    group.add(floor);
  }

  // ---------------------------------------------------------------- sights (diamonds) on the rail
  const sightMat = keep(new THREE.MeshStandardMaterial({ color: '#f1ead2', roughness: 0.3, metalness: 0.2 }));
  const sightGeo = keep(new THREE.CircleGeometry(0.0055, 4));
  const sightAt = (x: number, y: number) => {
    const m = new THREE.Mesh(sightGeo, sightMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, railH + 0.0071, -y);
    group.add(m);
  };
  if (t.id !== 'snooker') {
    for (let k = 1; k < 8; k++) if (k !== 4) for (const sy of [1, -1]) sightAt(-L + (k * t.length) / 8, sy * (B + rw / 2));
    for (let k = 1; k < 4; k++) for (const sx of [1, -1]) sightAt(sx * (A + rw / 2), -W + (k * t.width) / 4);
  }

  // ---------------------------------------------------------------- body and legs
  const bodyMat = keep(new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.5, color: '#c9b39f' }));
  // the body below the rails, kept under the pocket wells
  const apron = new THREE.Mesh(keep(new THREE.BoxGeometry(2 * OA - 0.04, 0.1, 2 * OB - 0.04)), bodyMat);
  apron.position.y = -0.22;
  apron.castShadow = true;
  group.add(apron);
  const legH = 0.62;
  const legGeo = keep(t.id === 'snooker' ? new THREE.CylinderGeometry(0.08, 0.065, legH, 20) : new THREE.BoxGeometry(0.14, legH, 0.14));
  const legXs = t.id === 'snooker' ? [-1, -1 / 3, 1 / 3, 1] : [-1, 1];
  for (const fx of legXs)
    for (const sy of [1, -1]) {
      const leg = new THREE.Mesh(legGeo, bodyMat);
      leg.position.set(fx * (OA - 0.2), -0.23 - legH / 2, sy * (OB - 0.18));
      leg.castShadow = true;
      group.add(leg);
    }

  return {
    group,
    bedY: 0,
    outerA: OA,
    outerB: OB,
    dispose() {
      for (const d of disposables) d.dispose();
    },
  };
}
