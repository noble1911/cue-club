// The room around the table: a snooker club, a pub or an American pool hall. Simple boxes and
// canvas textures, lit low so the table stays the brightest thing in view.

import * as THREE from 'three';
import type { VariantId } from '../sim/rules/types.ts';
import type { TableSpec } from '../sim/tables.ts';
import { woodTexture } from './textures.ts';

export type RoomTheme = 'club' | 'pub' | 'hall';

export function themeFor(variant: VariantId): RoomTheme {
  return variant === 'snooker' ? 'club' : variant === 'uk8' ? 'pub' : 'hall';
}

const FLOOR_Y = -0.86;
const HEIGHT = 3.1;

function canvasTex(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void, repeat?: [number, number]): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) {
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repeat[0], repeat[1]);
  }
  return t;
}

function speckle(g: CanvasRenderingContext2D, w: number, h: number, n: number, alpha: number): void {
  for (let i = 0; i < n; i++) {
    g.fillStyle = `rgba(${Math.random() < 0.5 ? '0,0,0' : '255,255,255'},${Math.random() * alpha})`;
    g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
  }
}

const brick = (rep: [number, number]) =>
  canvasTex(512, 512, (g) => {
    g.fillStyle = '#4a3a33';
    g.fillRect(0, 0, 512, 512);
    const bh = 32;
    const bw = 96;
    for (let row = 0; row < 512 / bh; row++) {
      for (let col = -1; col < 512 / bw + 1; col++) {
        const x = col * bw + (row % 2 ? bw / 2 : 0);
        const shade = 90 + Math.random() * 50;
        g.fillStyle = `rgb(${shade + 40},${shade * 0.55},${shade * 0.42})`;
        g.fillRect(x + 3, row * bh + 3, bw - 6, bh - 6);
      }
    }
    speckle(g, 512, 512, 6000, 0.25);
  }, rep);

const carpet = (rep: [number, number]) =>
  canvasTex(256, 256, (g) => {
    g.fillStyle = '#4a1418';
    g.fillRect(0, 0, 256, 256);
    g.strokeStyle = 'rgba(214,170,90,0.28)';
    g.lineWidth = 3;
    for (let i = -256; i < 512; i += 64) {
      g.beginPath();
      g.moveTo(i, 0);
      g.lineTo(i + 256, 256);
      g.moveTo(i + 256, 0);
      g.lineTo(i, 256);
      g.stroke();
    }
    speckle(g, 256, 256, 5000, 0.18);
  }, rep);

const planks = (base: string, rep: [number, number]) =>
  canvasTex(512, 512, (g) => {
    for (let i = 0; i < 8; i++) {
      const c = new THREE.Color(base).multiplyScalar(0.8 + Math.random() * 0.35);
      g.fillStyle = `#${c.getHexString()}`;
      g.fillRect(0, i * 64, 512, 64);
      g.fillStyle = 'rgba(0,0,0,0.5)';
      g.fillRect(0, i * 64, 512, 2);
      g.fillRect(((i * 197) % 400) + 40, i * 64, 2, 64);
      g.strokeStyle = 'rgba(0,0,0,0.12)';
      for (let k = 0; k < 6; k++) {
        g.beginPath();
        const y = i * 64 + 6 + Math.random() * 52;
        g.moveTo(0, y);
        g.bezierCurveTo(170, y + 4, 340, y - 4, 512, y + 2);
        g.stroke();
      }
    }
    speckle(g, 512, 512, 3000, 0.12);
  }, rep);

const plaster = (colour: string, rep: [number, number]) =>
  canvasTex(256, 256, (g) => {
    g.fillStyle = colour;
    g.fillRect(0, 0, 256, 256);
    speckle(g, 256, 256, 9000, 0.1);
  }, rep);

/** A sign: text on a canvas, optionally glowing like neon. */
function sign(text: string, opts: { w: number; h: number; colour: string; bg?: string; font: string; glow?: boolean }): THREE.Mesh {
  const px = 512;
  const tex = canvasTex(px, Math.round((px * opts.h) / opts.w), (g) => {
    const W = g.canvas.width;
    const H = g.canvas.height;
    if (opts.bg) {
      g.fillStyle = opts.bg;
      g.fillRect(0, 0, W, H);
    }
    g.font = opts.font;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    if (opts.glow) {
      g.shadowColor = opts.colour;
      g.shadowBlur = 28;
    }
    g.fillStyle = opts.colour;
    const lines = text.split('\n');
    lines.forEach((l, i) => g.fillText(l, W / 2, (H * (i + 1)) / (lines.length + 1)));
    if (opts.glow) g.fillText(text, W / 2, H / 2);
  });
  const mat = opts.glow
    ? new THREE.MeshBasicMaterial({ map: tex, transparent: true, toneMapped: false })
    : new THREE.MeshStandardMaterial({ map: tex, roughness: 0.8 });
  return new THREE.Mesh(new THREE.PlaneGeometry(opts.w, opts.h), mat);
}

function box(w: number, h: number, d: number, mat: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
  m.castShadow = false;
  m.receiveShadow = true;
  return m;
}

function cueRack(): THREE.Group {
  const g = new THREE.Group();
  const wood = new THREE.MeshStandardMaterial({ color: '#4b2a17', roughness: 0.5 });
  g.add(box(0.9, 0.08, 0.06, wood).translateY(1.25));
  g.add(box(0.9, 0.06, 0.08, wood).translateY(0.12));
  const shaft = new THREE.MeshStandardMaterial({ color: '#d9b98a', roughness: 0.4 });
  const butt = new THREE.MeshStandardMaterial({ color: '#2a1610', roughness: 0.4 });
  for (let i = 0; i < 6; i++) {
    const x = -0.36 + i * 0.145;
    const s = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.01, 0.9, 10), shaft);
    s.position.set(x, 0.95, 0.04);
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.015, 0.55, 10), butt);
    b.position.set(x, 0.24, 0.04);
    g.add(s, b);
  }
  return g;
}

function framedPicture(w: number, h: number, hue: number): THREE.Group {
  const g = new THREE.Group();
  g.add(box(w + 0.08, h + 0.08, 0.04, new THREE.MeshStandardMaterial({ color: '#7a5a24', roughness: 0.35, metalness: 0.6 })));
  const pic = canvasTex(256, Math.round((256 * h) / w), (c) => {
    const W = c.canvas.width;
    const H = c.canvas.height;
    const grad = c.createLinearGradient(0, 0, 0, H);
    grad.addColorStop(0, `hsl(${hue},35%,40%)`);
    grad.addColorStop(1, `hsl(${hue + 30},30%,18%)`);
    c.fillStyle = grad;
    c.fillRect(0, 0, W, H);
    c.fillStyle = 'rgba(255,240,210,0.25)';
    c.beginPath();
    c.ellipse(W * 0.5, H * 0.62, W * 0.32, H * 0.12, 0, 0, Math.PI * 2);
    c.fill();
    speckle(c, W, H, 2500, 0.2);
  });
  const p = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: pic, roughness: 0.9 }));
  p.position.z = 0.021;
  g.add(p);
  return g;
}

function sconce(colour: string, intensity: number): THREE.Group {
  const g = new THREE.Group();
  const shade = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.11, 0.16, 20, 1, true), new THREE.MeshStandardMaterial({ color: '#e8d2a0', emissive: colour, emissiveIntensity: 0.8, side: THREE.DoubleSide }));
  shade.position.z = 0.12;
  g.add(shade);
  const light = new THREE.PointLight(colour, intensity, 4.5, 1.8);
  light.position.z = 0.25;
  g.add(light);
  return g;
}

export interface RoomModel {
  group: THREE.Group;
  theme: RoomTheme;
  dispose(): void;
}

export function buildRoom(theme: RoomTheme, t: TableSpec): RoomModel {
  const group = new THREE.Group();
  const X = t.length / 2 + 3.2;
  const Z = t.width / 2 + 3;
  const wallH = HEIGHT;
  const midY = FLOOR_Y + wallH / 2;

  const floorTex = theme === 'club' ? carpet([X, Z]) : planks(theme === 'pub' ? '#6a4026' : '#3b2b22', [X / 1.5, Z / 1.5]);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(2 * X, 2 * Z), new THREE.MeshStandardMaterial({ map: floorTex, roughness: theme === 'club' ? 1 : 0.55 }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = FLOOR_Y;
  floor.receiveShadow = true;
  group.add(floor);
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(2 * X, 2 * Z), new THREE.MeshStandardMaterial({ color: '#141210', roughness: 1 }));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = FLOOR_Y + wallH;
  group.add(ceiling);

  // walls: +x, −x (ends), +z, −z (sides), each facing in
  const wallMat = (len: number) =>
    new THREE.MeshStandardMaterial({
      map: theme === 'pub' ? brick([len / 1.2, wallH / 1.2]) : theme === 'club' ? plaster('#1d3a2a', [len, wallH]) : plaster('#1b1b22', [len, wallH]),
      roughness: 0.95,
    });
  const walls: { pos: THREE.Vector3; rotY: number; len: number }[] = [
    { pos: new THREE.Vector3(X, midY, 0), rotY: -Math.PI / 2, len: 2 * Z },
    { pos: new THREE.Vector3(-X, midY, 0), rotY: Math.PI / 2, len: 2 * Z },
    { pos: new THREE.Vector3(0, midY, Z), rotY: Math.PI, len: 2 * X },
    { pos: new THREE.Vector3(0, midY, -Z), rotY: 0, len: 2 * X },
  ];
  for (const w of walls) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w.len, wallH), wallMat(w.len));
    m.position.copy(w.pos);
    m.rotation.y = w.rotY;
    m.receiveShadow = true;
    group.add(m);
    if (theme !== 'pub') {
      // wood panelling on the lower wall, with a dado rail
      const wood = new THREE.MeshStandardMaterial({ map: woodTexture(theme === 'club' ? '#5a3219' : '#2c1d16', '#1c0d06', 9), roughness: 0.5 });
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(w.len, 1.05), wood);
      panel.position.copy(w.pos).setY(FLOOR_Y + 0.525);
      panel.rotation.y = w.rotY;
      panel.translateZ(0.01);
      group.add(panel);
      const rail = box(w.len, 0.05, 0.04, new THREE.MeshStandardMaterial({ color: theme === 'club' ? '#b08a3e' : '#3a2a20', roughness: 0.4, metalness: theme === 'club' ? 0.6 : 0 }));
      rail.position.copy(w.pos).setY(FLOOR_Y + 1.06);
      rail.rotation.y = w.rotY;
      rail.translateZ(0.02);
      group.add(rail);
    }
  }

  // things on a wall: (wall index, along, height, object)
  const onWall = (wall: number, along: number, y: number, obj: THREE.Object3D, out = 0.02) => {
    const w = walls[wall];
    obj.position.copy(w.pos).setY(FLOOR_Y + y);
    obj.rotation.y = w.rotY;
    obj.translateX(along);
    obj.translateZ(out);
    group.add(obj);
  };

  if (theme === 'club') {
    const board = new THREE.Group();
    board.add(box(1.5, 0.75, 0.05, new THREE.MeshStandardMaterial({ color: '#3a2111', roughness: 0.4 })));
    const face = sign('SNOOKER\n0  ·  0', { w: 1.36, h: 0.62, colour: '#f2e2b8', bg: '#16301f', font: 'bold 70px Georgia' });
    face.position.z = 0.03;
    board.add(face);
    onWall(2, -1.2, 1.75, board, 0.03);
    onWall(2, 1.4, 0.15, cueRack(), 0.03);
    onWall(3, -1.6, 1.8, framedPicture(0.8, 0.6, 110));
    onWall(3, 0.6, 1.8, framedPicture(0.6, 0.8, 30));
    onWall(0, 0, 1.8, framedPicture(1.0, 0.7, 200));
    for (const [wall, along] of [[2, -2.6], [2, 0.3], [3, -0.5], [3, 2.0]] as const) onWall(wall, along, 1.95, sconce('#ffcf8a', 1.6), 0.02);
    // leather armchairs along one side
    const leather = new THREE.MeshStandardMaterial({ color: '#4a1c14', roughness: 0.55 });
    for (const along of [-1.4, -0.4, 0.6]) {
      const chair = new THREE.Group();
      chair.add(box(0.75, 0.42, 0.7, leather).translateY(0.21));
      chair.add(box(0.75, 0.55, 0.16, leather).translateY(0.62).translateZ(-0.27));
      chair.add(box(0.14, 0.3, 0.7, leather).translateY(0.55).translateX(0.31));
      chair.add(box(0.14, 0.3, 0.7, leather).translateY(0.55).translateX(-0.31));
      onWall(3, along, 0, chair, 0.45);
    }
  } else if (theme === 'pub') {
    // the bar along one side
    const top = new THREE.MeshStandardMaterial({ map: woodTexture('#5b2f15', '#241006', 5), roughness: 0.35 });
    const front = new THREE.MeshStandardMaterial({ map: woodTexture('#3d2010', '#1a0904', 6), roughness: 0.6 });
    const bar = new THREE.Group();
    bar.add(box(3.6, 1.0, 0.55, front).translateY(0.5));
    bar.add(box(3.8, 0.06, 0.7, top).translateY(1.03));
    onWall(3, -0.6, 0, bar, 1.25);
    const shelf = new THREE.Group();
    shelf.add(box(3.2, 0.04, 0.22, top).translateY(1.5));
    shelf.add(box(3.2, 0.04, 0.22, top).translateY(1.9));
    const glassCols = ['#2f6b3a', '#8a5a1a', '#b9c2c8', '#5a1a24', '#c8a040', '#2a4a7a'];
    for (let i = 0; i < 22; i++) {
      const b = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.04, 0.26, 12), new THREE.MeshStandardMaterial({ color: glassCols[i % glassCols.length], roughness: 0.1, metalness: 0.1, transparent: true, opacity: 0.85 }));
      b.position.set(-1.5 + (i % 11) * 0.29, i < 11 ? 1.65 : 2.05, 0.06);
      shelf.add(b);
    }
    onWall(3, -0.6, 0, shelf, 0.12);
    for (const along of [-1.8, -0.9, 0, 0.9]) {
      const stool = new THREE.Group();
      stool.add(new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.19, 0.06, 20), new THREE.MeshStandardMaterial({ color: '#5a1c16', roughness: 0.5 })).translateY(0.75));
      stool.add(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.05, 0.75, 10), new THREE.MeshStandardMaterial({ color: '#888', metalness: 0.8, roughness: 0.3 })).translateY(0.37));
      onWall(3, along, 0, stool, 1.85);
    }
    // dartboard
    const dart = canvasTex(256, 256, (g) => {
      g.fillStyle = '#111';
      g.fillRect(0, 0, 256, 256);
      for (let i = 0; i < 20; i++) {
        const a0 = (i / 20) * Math.PI * 2 - Math.PI / 20;
        for (const [r0, r1, odd] of [[100, 118, true], [30, 100, false], [60, 70, true]] as const) {
          g.fillStyle = odd ? (i % 2 ? '#1d7a3a' : '#b51e1e') : i % 2 ? '#e8dcb5' : '#151515';
          g.beginPath();
          g.arc(128, 128, r1, a0, a0 + Math.PI / 10);
          g.arc(128, 128, r0, a0 + Math.PI / 10, a0, true);
          g.fill();
        }
      }
      g.fillStyle = '#1d7a3a';
      g.beginPath();
      g.arc(128, 128, 12, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#b51e1e';
      g.beginPath();
      g.arc(128, 128, 5, 0, Math.PI * 2);
      g.fill();
    });
    const board = new THREE.Mesh(new THREE.CircleGeometry(0.24, 40), new THREE.MeshStandardMaterial({ map: dart, roughness: 0.9 }));
    onWall(0, 0.6, 1.73, board, 0.03);
    const cab = box(0.62, 0.62, 0.04, new THREE.MeshStandardMaterial({ color: '#3a1d0e' }));
    onWall(0, 0.6, 1.73, cab, 0.01);
    onWall(2, -1.6, 1.6, sign('POOL\n£1 a game', { w: 0.9, h: 0.6, colour: '#f4f0e0', bg: '#1d2420', font: '64px Georgia' }), 0.03);
    // a window onto the night street
    onWall(2, 1.2, 1.55, sign('', { w: 1.3, h: 0.9, colour: '#000', bg: '#0f1b2c', font: '10px serif' }), 0.02);
    onWall(1, 0, 0.15, cueRack(), 0.03);
    for (const [wall, along] of [[2, 0], [2, -2.8], [0, -1.3]] as const) onWall(wall, along, 2.1, sconce('#ffb86b', 1.4), 0.02);
  } else {
    // pool hall: neon, a jukebox, racks
    onWall(3, -0.4, 2.0, sign('POOL', { w: 2.2, h: 0.75, colour: '#ff4fa3', font: 'bold 150px "Arial Rounded MT Bold", Arial, sans-serif', glow: true }), 0.03);
    onWall(2, 1.0, 2.0, sign('8 BALL · 9 BALL', { w: 2.6, h: 0.5, colour: '#4fd8ff', font: 'bold 64px Arial, sans-serif', glow: true }), 0.03);
    onWall(0, 0, 1.9, sign('★', { w: 0.8, h: 0.8, colour: '#ffd34f', font: '300px Arial', glow: true }), 0.03);
    const juke = new THREE.Group();
    juke.add(box(0.8, 1.4, 0.5, new THREE.MeshStandardMaterial({ color: '#5a1e10', roughness: 0.3, metalness: 0.3 })).translateY(0.7));
    const glow = sign('♪', { w: 0.6, h: 0.7, colour: '#ffb347', bg: '#2a0e2e', font: '200px Arial', glow: false });
    (glow.material as THREE.MeshStandardMaterial).emissive = new THREE.Color('#ff8a30');
    (glow.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.5;
    glow.position.set(0, 0.85, 0.26);
    juke.add(glow);
    onWall(1, 1.0, 0, juke, 0.3);
    onWall(2, -1.6, 0.15, cueRack(), 0.03);
    onWall(1, -1.0, 0.15, cueRack(), 0.03);
    const neonA = new THREE.PointLight('#ff4fa3', 1.2, 4, 1.8);
    onWall(3, -0.4, 2.0, neonA, 0.4);
    const neonB = new THREE.PointLight('#4fd8ff', 1.0, 4, 1.8);
    onWall(2, 1.0, 2.0, neonB, 0.4);
  }

  return {
    group,
    theme,
    dispose() {
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          const mats = Array.isArray(o.material) ? o.material : [o.material];
          for (const m of mats) {
            (m as THREE.MeshStandardMaterial).map?.dispose();
            m.dispose();
          }
        }
        if (o instanceof THREE.Light) o.dispose();
      });
    },
  };
}
