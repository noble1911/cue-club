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
 * inner edge with the pocket openings) or bitten out of it (the bed). The result is star-shaped
 * from the centre, so sorting the boundary points by angle gives the polygon.
 */
function outline(A: number, B: number, circles: Circle[], mode: 'union' | 'subtract', perCircle = 40): THREE.Vector2[] {
  const inRect = (x: number, y: number) => Math.abs(x) <= A + 1e-9 && Math.abs(y) <= B + 1e-9;
  const inCircle = (x: number, y: number) => circles.some((c) => (x - c.x) ** 2 + (y - c.y) ** 2 < c.r * c.r - 1e-12);
  const pts: THREE.Vector2[] = [];
  // rectangle edges, sampled, kept where they're on the outline
  const edge = (x0: number, y0: number, x1: number, y1: number) => {
    const n = 120;
    for (let i = 0; i <= n; i++) {
      const x = x0 + ((x1 - x0) * i) / n;
      const y = y0 + ((y1 - y0) * i) / n;
      if (!inCircle(x, y)) pts.push(new THREE.Vector2(x, y));
    }
  };
  edge(-A, -B, A, -B);
  edge(A, -B, A, B);
  edge(A, B, -A, B);
  edge(-A, B, -A, -B);
  for (const c of circles) {
    for (let i = 0; i < perCircle * 4; i++) {
      const a = (i / (perCircle * 4)) * Math.PI * 2;
      const x = c.x + Math.cos(a) * c.r;
      const y = c.y + Math.sin(a) * c.r;
      const others = circles.filter((o) => o !== c);
      const insideOther = others.some((o) => (x - o.x) ** 2 + (y - o.y) ** 2 < o.r * o.r);
      if (insideOther) continue;
      if (mode === 'union' ? !inRect(x, y) : inRect(x, y)) pts.push(new THREE.Vector2(x, y));
    }
  }
  pts.sort((p, q) => Math.atan2(p.y, p.x) - Math.atan2(q.y, q.x));
  // drop near-duplicates
  return pts.filter((p, i) => i === 0 || p.distanceToSquared(pts[i - 1]) > 1e-10);
}

/** Lay a shape drawn in sim coordinates flat on the table: (x, y) → (x, 0, −y). */
function flat(geo: THREE.BufferGeometry): THREE.BufferGeometry {
  geo.rotateX(-Math.PI / 2);
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
  const bites: Circle[] = t.pockets.map((p) => ({ x: p.x, y: p.y, r: p.kind === 'corner' ? t.cornerMouth * 0.62 : t.middleMouth * 0.56 }));
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
  const cushionMat = keep(new THREE.MeshStandardMaterial({ color: new THREE.Color(t.cloth).multiplyScalar(0.92), map: clothTex, roughness: 0.9 }));
  const noseH = 1.3 * R;
  for (let i = 0; i < t.cushions.length; i += 3) {
    const main = t.cushions[i];
    const jA = t.cushions[i + 1];
    const jB = t.cushions[i + 2];
    const midX = (main.ax + main.bx) / 2;
    const midY = (main.ay + main.by) / 2;
    const horizontal = Math.abs(main.ay - main.by) < 1e-9;
    const nx = horizontal ? 0 : Math.sign(midX);
    const ny = horizontal ? Math.sign(midY) : 0;
    // where each jaw line meets the back of the cushion (the rail's inner edge)
    const back = (j: typeof jA) => {
      const dx = j.bx - j.ax;
      const dy = j.by - j.ay;
      const len = Math.hypot(dx, dy);
      const along = (dx * nx + dy * ny) / len;
      const k = cw / Math.max(0.2, along);
      return new THREE.Vector2(j.ax + (dx / len) * k, j.ay + (dy / len) * k);
    };
    const pts = [new THREE.Vector2(main.ax, main.ay), new THREE.Vector2(main.bx, main.by), back(jB), back(jA)];
    // the cushion's nose is rounded: build it as an extruded footprint with a small bevel
    const shape = new THREE.Shape(pts);
    const geo = keep(flat(new THREE.ExtrudeGeometry(shape, { depth: noseH, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.003, bevelSegments: 3 })));
    const mesh = new THREE.Mesh(geo, cushionMat);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // ---------------------------------------------------------------- rails (wood) with pocket openings
  const woodTex = keep(woodTexture('#6b3a1f', '#2a1208'));
  woodTex.repeat.set(4, 1);
  const woodMat = keep(new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.38, metalness: 0.05, color: '#ffffff' }));
  const railH = noseH + 0.006;
  const holes: Circle[] = t.pockets.map((p) => ({ x: p.x, y: p.y, r: p.kind === 'corner' ? t.cornerMouth * 0.82 : t.middleMouth * 0.68 }));
  const railShape = new THREE.Shape([new THREE.Vector2(-OA, -OB), new THREE.Vector2(OA, -OB), new THREE.Vector2(OA, OB), new THREE.Vector2(-OA, OB)]);
  railShape.holes.push(new THREE.Path(outline(A - 0.001, B - 0.001, holes, 'union')));
  // deep enough to be the table's sides too (down to the apron)
  const railDepth = railH + 0.17;
  const railGeo = keep(flat(new THREE.ExtrudeGeometry(railShape, { depth: railDepth, bevelEnabled: true, bevelThickness: 0.006, bevelSize: 0.006, bevelSegments: 3 })));
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
  for (const [i, p] of t.pockets.entries()) {
    const r = holes[i].r;
    const well = new THREE.Mesh(keep(new THREE.CylinderGeometry(r * 0.97, r * 0.8, 0.16, 32, 1, true)), wellMat);
    well.position.set(p.x, -0.08, -p.y);
    group.add(well);
    const floor = new THREE.Mesh(keep(new THREE.CircleGeometry(r * 0.8, 32)), wellMat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(p.x, -0.15, -p.y);
    group.add(floor);
    // a lip around the opening on the rail top (the half facing out of the table)
    const lip = new THREE.Mesh(keep(new THREE.TorusGeometry(r + 0.004, 0.009, 10, 40, Math.PI * (p.kind === 'corner' ? 1.25 : 1))), p.kind === 'corner' ? metalMat : lipMat);
    lip.rotation.x = -Math.PI / 2;
    const out = Math.atan2(p.y, p.x);
    lip.rotation.z = p.kind === 'corner' ? out - Math.PI * 0.625 : out - Math.PI / 2;
    lip.position.set(p.x, railH - 0.002, -p.y);
    lip.castShadow = true;
    group.add(lip);
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
