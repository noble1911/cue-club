// The 3D view: renderer, lights, the table, the balls, the cue, the aim guides and the cameras.
// It shows whatever it's told (balls, an aim, a shot to play back); it never decides anything.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { castBall, FRAME_DT, MAX_TIP_OFFSET, type Ball, type SimEvent, type SimResult } from '../sim/physics.ts';
import type { Rules } from '../sim/rules/types.ts';
import type { TableSpec } from '../sim/tables.ts';
import { ballTexture } from './textures.ts';
import { buildTable, type TableModel } from './table.ts';
import { buildRoom, themeFor, type RoomModel } from './room.ts';

/** aim: behind the cue ball · sight: down the cue, eye on the shot line · top: overhead · orbit: the menu. */
export type CameraMode = 'aim' | 'sight' | 'top' | 'orbit';

export interface AimView {
  dx: number;
  dy: number;
  power: number;
  side: number;
  height: number;
}

export type { GuideSetting as GuideLength } from '../net/protocol.ts';
import type { GuideSetting as GuideLength } from '../net/protocol.ts';

const UP = new THREE.Vector3(0, 1, 0);
const tmpV = new THREE.Vector3();
const tmpQ = new THREE.Quaternion();

/** sim (x, y) at height h → three.js */
export const v3 = (x: number, y: number, h = 0) => new THREE.Vector3(x, h, -y);

function makeCue(): THREE.Group {
  // profile from the tip (y = 0) to the butt (y = 1.47), radius in metres
  const prof: [number, number][] = [
    [0, 0],
    [0.0056, 0],
    [0.0056, 0.008],
    [0.0058, 0.008],
    [0.0058, 0.026],
    [0.0062, 0.026],
    [0.0094, 0.7],
    [0.0108, 0.72],
    [0.0108, 0.74],
    [0.0112, 0.75],
    [0.0142, 1.3],
    [0.0146, 1.44],
    [0.0135, 1.47],
    [0, 1.47],
  ];
  const pts = prof.map(([r, y]) => new THREE.Vector2(r, y));
  const geo = new THREE.LatheGeometry(pts, 28);
  // colour by height: chalk tip, ferrule, maple shaft, ebony butt with a brass ring
  const colors = new Float32Array(geo.attributes.position.count * 3);
  const c = new THREE.Color();
  for (let i = 0; i < geo.attributes.position.count; i++) {
    const y = geo.attributes.position.getY(i);
    if (y < 0.009) c.set('#2f5fa8');
    else if (y < 0.027) c.set('#f2efe6');
    else if (y < 0.7) c.set('#e2c38f');
    else if (y < 0.75) c.set('#c9a44a');
    else if (y < 1.3) c.set('#2b1710');
    else c.set('#141414');
    colors.set([c.r, c.g, c.b], i * 3);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.35, metalness: 0.05 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.castShadow = true;
  // the group's +z is the direction the cue points (tip forward); the tip sits at the origin
  mesh.rotation.x = -Math.PI / 2;
  const g = new THREE.Group();
  g.add(mesh);
  return g;
}

interface PotAnim {
  id: number;
  t0: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
}

export class TableView {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(42, 1, 0.02, 60);
  private table: TableModel | null = null;
  private spec: TableSpec | null = null;
  private balls: THREE.Mesh[] = [];
  private shadows: THREE.Mesh[] = [];
  private shadowTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(0,0,0,0.9)');
    grad.addColorStop(0.3, 'rgba(0,0,0,0.7)');
    grad.addColorStop(0.6, 'rgba(0,0,0,0.25)');
    grad.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  private ballMats: THREE.Material[] = [];
  private ballGeo: THREE.SphereGeometry | null = null;
  private state: Ball[] = [];
  private cue = makeCue();
  private guide = new THREE.Group();
  private ghost: THREE.Mesh;
  private lineMat = new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55, depthWrite: false });
  private objLineMat = new THREE.MeshBasicMaterial({ color: '#ffe38a', transparent: true, opacity: 0.75, depthWrite: false });
  private ring: THREE.Mesh;
  private shadowMat: THREE.MeshBasicMaterial;
  private camPos = new THREE.Vector3(0, 4, 4);
  private camLook = new THREE.Vector3();
  private camUp = new THREE.Vector3(0, 1, 0);
  private lamps = new THREE.Group();
  private pots: PotAnim[] = [];
  private playing: { result: SimResult; t: number; frame: number; resolve: () => void; onEvent?: (e: SimEvent) => void; ev: number; speed: number } | null = null;
  private stroke: { t: number; resolve: () => void } | null = null;
  private orbitAngle = 0;
  private last = performance.now();

  mode: CameraMode = 'orbit';
  /** The aim to draw (cue and guides), or null to hide them. */
  aim: AimView | null = null;
  guideLength: GuideLength = 'full';
  /** Balls the shooter may hit first: the guide stops at others in red. */
  ballsOn: number[] = [];
  /** Cue ball being placed: where, and whether it's allowed there. */
  placing: { x: number; y: number; valid: boolean } | null = null;
  /** Camera pitch in aim mode, 0 (low) … 1 (high). */
  pitch = 0.35;
  /** Zoom in aim mode: distance multiplier. */
  zoom = 1;
  onRender: ((dt: number) => void) | null = null;

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.95;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.renderer.domElement.style.touchAction = 'none';

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.32;
    this.scene.background = new THREE.Color('#0c0a09');
    this.scene.fog = new THREE.Fog('#0c0a09', 9, 24);

    this.scene.add(new THREE.HemisphereLight('#fff4e0', '#1a120c', 0.35));
    this.scene.add(this.lamps);

    this.shadowMat = new THREE.MeshBasicMaterial({ map: this.shadowTex, transparent: true, depthWrite: false, opacity: 0.7 });
    this.cue.visible = false;
    this.scene.add(this.cue);
    this.ghost = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 16), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.22, depthWrite: false }));
    this.ring = new THREE.Mesh(new THREE.RingGeometry(0.92, 1, 40), new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }));
    this.ring.rotation.x = -Math.PI / 2;
    this.scene.add(this.guide);

    const resize = () => {
      const w = container.clientWidth || window.innerWidth;
      const h = container.clientHeight || window.innerHeight;
      this.renderer.setSize(w, h);
      this.camera.aspect = w / h;
      // phones held upright need a wider view to see past the cue ball
      this.camera.fov = w < h ? 62 : 42;
      this.camera.updateProjectionMatrix();
    };
    new ResizeObserver(resize).observe(container);
    resize();
    this.renderer.setAnimationLoop(() => this.tick());
  }

  get tableSpec(): TableSpec | null {
    return this.spec;
  }

  /** Build the table and balls for a variant. */
  setVariant(rules: Rules): void {
    if (this.table && this.spec === rules.table && this.balls.length === rules.looks.length) return;
    if (this.table) {
      this.scene.remove(this.table.group);
      this.table.dispose();
    }
    for (const b of this.balls) this.scene.remove(b);
    for (const sh of this.shadows) {
      this.scene.remove(sh);
      sh.geometry.dispose();
    }
    this.shadows = [];
    for (const m of this.ballMats) {
      (m as THREE.MeshPhysicalMaterial).map?.dispose();
      m.dispose();
    }
    this.ballGeo?.dispose();
    this.spec = rules.table;
    this.table = buildTable(rules.table);
    this.scene.add(this.table.group);
    const R = rules.table.ballRadius;
    this.ballGeo = new THREE.SphereGeometry(R, 40, 28);
    this.balls = [];
    this.ballMats = [];
    rules.looks.forEach((look, id) => {
      const mat = new THREE.MeshPhysicalMaterial({ map: ballTexture(look), roughness: 0.16, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.06 });
      const mesh = new THREE.Mesh(this.ballGeo!, mat);
      // no shadow-map shadow: lit from almost straight above it hides under the ball and only
      // a ring shows round the edge. The soft contact shadow below does the job instead.
      mesh.castShadow = false;
      // numbers face up to start with, each ball turned a different way
      mesh.quaternion.setFromEuler(new THREE.Euler(-Math.PI / 2, (id * 2.399) % (Math.PI * 2), 0, 'YXZ'));
      this.scene.add(mesh);
      this.balls.push(mesh);
      this.ballMats.push(mat);
      // a soft contact shadow that follows the ball (the lamps' shadows alone look like rings)
      const sh = new THREE.Mesh(new THREE.PlaneGeometry(R * 3.2, R * 3.2), this.shadowMat);
      sh.rotation.x = -Math.PI / 2;
      sh.renderOrder = 1;
      this.scene.add(sh);
      this.shadows.push(sh);
    });
    this.ghost.scale.setScalar(R);
    this.ring.scale.setScalar(R);
    this.buildLamps(rules.table);
    const theme = themeFor(rules.id);
    if (this.room?.theme !== theme) {
      if (this.room) {
        this.scene.remove(this.room.group);
        this.room.dispose();
      }
      this.room = buildRoom(theme, rules.table);
      this.scene.add(this.room.group);
    }
  }

  private room: RoomModel | null = null;

  private buildLamps(t: TableSpec): void {
    for (const c of [...this.lamps.children]) {
      this.lamps.remove(c);
      if (c instanceof THREE.SpotLight) c.dispose();
      c.traverse((o) => {
        if (o instanceof THREE.Mesh) {
          o.geometry.dispose();
          (o.material as THREE.Material).dispose();
        }
      });
    }
    this.fittings = [];
    const n: number = t.id === 'snooker' ? 3 : 2;
    const h = 1.15;
    const span = t.length * 0.62;
    for (let i = 0; i < n; i++) {
      const x = n === 1 ? 0 : -span / 2 + (span * i) / (n - 1);
      const spot = new THREE.SpotLight('#fff3dd', t.id === 'snooker' ? 7.5 : 6, 4, 0.95, 0.7, 1.6);
      spot.position.set(x, h, 0);
      spot.target.position.set(x, 0, 0);
      spot.castShadow = i !== 1 || n === 2;
      spot.shadow.mapSize.set(1024, 1024);
      spot.shadow.bias = -0.0002;
      spot.shadow.normalBias = 0.01;
      spot.shadow.camera.near = 0.3;
      spot.shadow.camera.far = 3;
      this.lamps.add(spot, spot.target);
      // the fitting (shade, glowing underside, cord): its own materials so each lamp can fade
      // on its own when it hangs in front of the table (see fadeLamps)
      const fit = new THREE.Group();
      fit.position.set(x, h, 0);
      const shade = new THREE.MeshStandardMaterial({ color: t.id === 'snooker' ? '#173d27' : '#3b1a12', roughness: 0.6, metalness: 0.3, side: THREE.DoubleSide, transparent: true });
      const glow = new THREE.MeshBasicMaterial({ color: '#fff6e2', transparent: true });
      const cordMat = new THREE.MeshBasicMaterial({ color: '#111', transparent: true });
      const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.24, 0.16, 32, 1, true), shade);
      cone.position.y = 0.06;
      const bulb = new THREE.Mesh(new THREE.CircleGeometry(0.2, 32), glow);
      bulb.rotation.x = Math.PI / 2;
      bulb.position.y = -0.015;
      const cord = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 1.5), cordMat);
      cord.position.y = 0.9;
      fit.add(cone, bulb, cord);
      this.lamps.add(fit);
      this.fittings.push({ group: fit, mats: [shade, glow, cordMat], opacity: 1 });
    }
  }

  private fittings: { group: THREE.Group; mats: THREE.Material[]; opacity: number }[] = [];

  /**
   * Fade any lamp whose shade covers part of the table on screen (the snooker lamps hang right
   * in the line of sight from the cue view and overhead). A lamp off to the side, or above the
   * far cushion, stays solid.
   */
  private fadeLamps(dt: number): void {
    const spec = this.spec;
    if (!spec || !this.table) return;
    const cam = this.camera;
    cam.updateMatrixWorld();
    const A = this.table.outerA;
    const B = this.table.outerB;
    const quad = [v3(-A, -B), v3(A, -B), v3(A, B), v3(-A, B)].map((p) => p.project(cam));
    // the table's outline on screen (corners behind the camera: treat the table as covering)
    const behind = quad.some((p) => p.z > 1);
    const inside = (x: number, y: number) => {
      if (behind) return true;
      let sign = 0;
      for (let i = 0; i < 4; i++) {
        const a = quad[i];
        const b = quad[(i + 1) % 4];
        const c = (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x);
        if (c !== 0) {
          if (sign && Math.sign(c) !== sign) return false;
          sign = Math.sign(c);
        }
      }
      return true;
    };
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    const k = 1 - Math.exp(-dt * 8);
    for (const f of this.fittings) {
      const c = f.group.position;
      let covers = false;
      // sample the shade's outline and centre
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [0.7, 0.7], [-0.7, 0.7], [0.7, -0.7], [-0.7, -0.7]]) {
        const p = c.clone().addScaledVector(right, dx * 0.24).addScaledVector(up, dy * 0.12);
        const s = p.project(cam);
        if (s.z < -1 || s.z > 1) continue;
        if (s.x < -1.05 || s.x > 1.05 || s.y < -1.05 || s.y > 1.05) continue;
        if (inside(s.x, s.y)) {
          covers = true;
          break;
        }
      }
      const target = covers ? 0 : 1;
      f.opacity += (target - f.opacity) * k;
      f.group.visible = f.opacity > 0.02;
      for (const m of f.mats) {
        m.opacity = f.opacity;
        m.depthWrite = f.opacity > 0.98;
      }
    }
  }


  /** Show the balls exactly as given (after a shot is judged, a respot, a new frame). */
  setBalls(balls: readonly Ball[]): void {
    this.state = balls.map((b) => ({ ...b }));
    this.pots = [];
    const R = this.spec!.ballRadius;
    for (const b of balls) {
      const m = this.balls[b.id];
      if (!m) continue;
      m.visible = b.on;
      m.position.copy(v3(b.x, b.y, R));
    }
  }

  get cueBall(): Ball | undefined {
    return this.state[0];
  }

  get ballState(): readonly Ball[] {
    return this.state;
  }

  /** Play a simulated shot back in real time (×speed). Resolves when everything has stopped. */
  play(result: SimResult, onEvent?: (e: SimEvent) => void): Promise<void> {
    return new Promise((resolve) => {
      this.playing = { result, t: 0, frame: 0, resolve, onEvent, ev: 0, speed: 1 };
    });
  }

  /** Speed up the shot being played (tap to fast-forward). */
  hurry(): void {
    if (this.playing) this.playing.speed = 4;
  }

  get isPlaying(): boolean {
    return !!this.playing || !!this.stroke;
  }

  /** Animate the cue striking (≈ 0.25 s). */
  strike(): Promise<void> {
    return new Promise((resolve) => {
      this.stroke = { t: 0, resolve };
    });
  }

  /** Screen point → table (sim) coordinates on the cloth plane at ball-centre height. */
  pick(clientX: number, clientY: number): { x: number; y: number } | null {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const plane = new THREE.Plane(UP, -(this.spec?.ballRadius ?? 0.026));
    const hit = new THREE.Vector3();
    if (!ray.ray.intersectPlane(plane, hit)) return null;
    return { x: hit.x, y: -hit.z };
  }

  /** Table point → screen pixels (for hit-testing the cue ball). */
  project(x: number, y: number): { x: number; y: number } {
    const p = v3(x, y, this.spec?.ballRadius ?? 0).project(this.camera);
    const rect = this.renderer.domElement.getBoundingClientRect();
    return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
  }

  // ---------------------------------------------------------------- per frame

  private tick(): void {
    const now = performance.now();
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.playing) this.advance(dt);
    this.animatePots(now);
    this.updateCue(dt);
    this.updateGuides();
    this.updateShadows();
    this.updateCamera(dt);
    this.onRender?.(dt);
    this.renderer.render(this.scene, this.camera);
  }

  private advance(dt: number): void {
    const p = this.playing!;
    const { frames, events } = p.result;
    const R = this.spec!.ballRadius;
    p.t += dt * p.speed;
    const target = Math.min(frames.length - 1, p.t / FRAME_DT);
    // roll the balls frame by frame (rotation from the recorded spin), position interpolated
    while (p.frame < Math.floor(target)) {
      const f = frames[p.frame];
      for (let i = 0; i < this.balls.length; i++) {
        const wx = f[i * 5 + 2];
        const wy = f[i * 5 + 3];
        const wz = f[i * 5 + 4];
        const w = Math.sqrt(wx * wx + wy * wy + wz * wz);
        if (w > 1e-6) {
          tmpV.set(wx / w, wz / w, -wy / w);
          tmpQ.setFromAxisAngle(tmpV, w * FRAME_DT);
          this.balls[i].quaternion.premultiply(tmpQ);
        }
      }
      p.frame++;
    }
    const a = frames[Math.floor(target)];
    const b = frames[Math.min(frames.length - 1, Math.floor(target) + 1)];
    const k = target - Math.floor(target);
    for (let i = 0; i < this.balls.length; i++) {
      if (this.pots.some((x) => x.id === i)) continue;
      const x = a[i * 5] + (b[i * 5] - a[i * 5]) * k;
      const y = a[i * 5 + 1] + (b[i * 5 + 1] - a[i * 5 + 1]) * k;
      this.balls[i].position.set(x, R, -y);
    }
    while (p.ev < events.length && events[p.ev].t <= p.t) {
      const e = events[p.ev++];
      p.onEvent?.(e);
      if (e.type === 'pot') {
        const pk = this.spec!.pockets[e.pocket];
        this.pots.push({ id: e.a, t0: performance.now(), from: this.balls[e.a].position.clone(), to: v3(pk.x, pk.y, -0.11) });
      }
    }
    if (target >= frames.length - 1 && p.ev >= events.length) {
      this.playing = null;
      p.resolve();
    }
  }

  private animatePots(now: number): void {
    for (const pa of this.pots) {
      const m = this.balls[pa.id];
      const k = Math.min(1, (now - pa.t0) / 380);
      m.position.lerpVectors(pa.from, pa.to, k);
      m.position.y = pa.from.y + (pa.to.y - pa.from.y) * k * k;
      if (k >= 1) m.visible = false;
    }
  }

  private updateShadows(): void {
    const R = this.spec?.ballRadius ?? 0.026;
    for (let i = 0; i < this.shadows.length; i++) {
      const b = this.balls[i];
      const sh = this.shadows[i];
      // fades as the ball drops into a pocket
      const h = b.position.y - R;
      sh.visible = b.visible && h > -R;
      // falls a little away from the nearest lamp, and stretches that way
      let lx = 0;
      let best = Infinity;
      for (const f of this.fittings) {
        const d = Math.abs(f.group.position.x - b.position.x);
        if (d < best) {
          best = d;
          lx = f.group.position.x;
        }
      }
      const away = new THREE.Vector2(b.position.x - lx, b.position.z);
      const dist = away.length();
      const off = Math.min(R * 0.45, dist * 0.18);
      if (dist > 1e-6) away.multiplyScalar(1 / dist);
      sh.position.set(b.position.x + away.x * off, 0.0008, b.position.z + away.y * off);
      sh.rotation.z = Math.atan2(-away.y, away.x);
      sh.scale.set(1 + off / R * 0.5, 1, 1);
    }
  }

  private updateCue(dt: number): void {
    const spec = this.spec;
    const cueBall = this.balls[0];
    if (!spec || !cueBall) return;
    const R = spec.ballRadius;
    const show = !!this.aim && cueBall.visible && !this.playing && (!this.placing || this.placing.valid);
    if (this.stroke) {
      this.stroke.t += dt;
      if (this.stroke.t > 0.22) {
        const s = this.stroke;
        this.stroke = null;
        s.resolve();
      }
    }
    if (this.playing && this.cue.visible) {
      // drift the cue back out of the way while the balls run
      this.cue.position.addScaledVector(this.cueDir(), -dt * 0.6);
      if (this.playing.t > 0.6) this.cue.visible = false;
      return;
    }
    this.cue.visible = show;
    if (!show || !this.aim) return;
    const a = this.aim;
    const d = this.cueDir();
    const right = new THREE.Vector3().crossVectors(d, UP).normalize();
    const centre = this.placing ? v3(this.placing.x, this.placing.y, R) : cueBall.position.clone();
    // pull back with power; during the stroke, thrust through the ball
    let back = 0.012 + a.power * 0.22;
    if (this.stroke) {
      const k = this.stroke.t / 0.22;
      back = k < 0.35 ? back + 0.04 * (k / 0.35) : (back + 0.04) * (1 - (k - 0.35) / 0.65) - 0.008;
    }
    const contact = centre
      .clone()
      .addScaledVector(right, a.side * MAX_TIP_OFFSET * R)
      .addScaledVector(UP, a.height * MAX_TIP_OFFSET * R)
      .addScaledVector(d, -Math.sqrt(Math.max(0, R * R - (a.side * MAX_TIP_OFFSET * R) ** 2 - (a.height * MAX_TIP_OFFSET * R) ** 2)));
    // raise the butt as much as it takes to clear the balls behind the cue ball and the rail
    const want = this.cueElevation(contact, d, back);
    this.cueElev += (want - this.cueElev) * (1 - Math.exp(-dt * 14));
    const elev = this.cueElev;
    const dirUp = d.clone().multiplyScalar(Math.cos(elev)).addScaledVector(UP, -Math.sin(elev));
    this.cue.position.copy(contact).addScaledVector(dirUp, -back);
    const m = new THREE.Matrix4().lookAt(new THREE.Vector3(), dirUp.clone().negate(), UP);
    this.cue.quaternion.setFromRotationMatrix(m);
  }

  private cueElev = 0.09;

  /**
   * The lowest cue angle that clears everything behind the cue ball: other balls near the cue's
   * line, and the cushion and rail. A real player jacks up the butt the same way.
   */
  private cueElevation(contact: THREE.Vector3, d: THREE.Vector3, back: number): number {
    const spec = this.spec!;
    const R = spec.ballRadius;
    let elev = 0.09;
    const tipR = 0.0058;
    const taper = (0.0146 - tipR) / 1.47;
    const margin = 0.004;
    // In the vertical plane of the cue, keep the cue's axis (a line rising from the contact
    // point) at least `rho` from a point `t` back and `h` up: the angle must be at least
    // atan2(h, t) + asin(rho / distance).
    const clear = (t: number, h: number, rho: number) => {
      if (t <= 0) return;
      const dist = Math.hypot(t, h);
      if (dist <= rho) return void (elev = Math.max(elev, 1.25));
      elev = Math.max(elev, Math.atan2(h, t) + Math.asin(rho / dist));
    };
    const cueR = (t: number) => tipR + Math.max(0, t - back) * taper;
    for (let i = 1; i < this.balls.length; i++) {
      const m = this.balls[i];
      if (!m.visible) continue;
      const ox = m.position.x - contact.x;
      const oz = m.position.z - contact.z;
      const t = -(ox * d.x + oz * d.z); // distance behind the contact point
      if (t <= 0 || t > 1.6) continue;
      const lat = Math.abs(ox * d.z - oz * d.x);
      const reach = R + cueR(t) + margin;
      if (lat >= reach) continue;
      clear(t, m.position.y - contact.y, Math.sqrt(reach * reach - lat * lat));
    }
    // the cushion nose and the rail's outer edge, where the line backwards leaves the bed
    const L = spec.length / 2;
    const W = spec.width / 2;
    const bx = -d.x;
    const bz = -d.z;
    let tEdge = Infinity;
    if (bx > 1e-6) tEdge = Math.min(tEdge, (L - contact.x) / bx);
    if (bx < -1e-6) tEdge = Math.min(tEdge, (-L - contact.x) / bx);
    if (bz > 1e-6) tEdge = Math.min(tEdge, (W - contact.z) / bz);
    if (bz < -1e-6) tEdge = Math.min(tEdge, (-W - contact.z) / bz);
    if (tEdge < Infinity) {
      const railTop = 1.3 * R + 0.006 - contact.y;
      const out = (spec.cushionWidth + spec.railWidth) / Math.max(0.3, Math.max(Math.abs(bx), Math.abs(bz)));
      clear(tEdge, railTop, cueR(tEdge) + margin);
      clear(tEdge + out, railTop, cueR(tEdge + out) + margin);
    }
    return Math.min(1.25, elev);
  }

  private cueDir(): THREE.Vector3 {
    const a = this.aim ?? { dx: 1, dy: 0 };
    return new THREE.Vector3(a.dx, 0, -a.dy).normalize();
  }

  private updateGuides(): void {
    for (const c of [...this.guide.children]) {
      this.guide.remove(c);
      if (c instanceof THREE.Mesh && c.geometry !== this.ghost.geometry && c.geometry !== this.ring.geometry) c.geometry.dispose();
    }
    const spec = this.spec;
    if (!spec || !this.aim || this.playing || this.stroke || this.guideLength === 'off' || !this.balls[0]?.visible) return;
    if (this.placing && !this.placing.valid) return;
    const R = spec.ballRadius;
    const cb = this.placing ?? this.state[0];
    if (!cb) return;
    const balls = this.state.map((b) => (b.id === 0 ? { ...b, x: cb.x, y: cb.y } : b));
    const { dx, dy } = this.aim;
    const l = Math.hypot(dx, dy) || 1;
    const ux = dx / l;
    const uy = dy / l;
    const hit = castBall(spec, balls, 0, cb.x, cb.y, ux, uy);
    const maxLen = this.guideLength === 'short' ? spec.length * 0.22 : Infinity;
    const len = Math.min(hit.dist, maxLen);
    const h = R * 0.15;
    this.guide.add(this.strip(cb.x, cb.y, cb.x + ux * len, cb.y + uy * len, R * 0.12, h, this.lineMat));
    if (len < hit.dist) return;
    const gx = cb.x + ux * hit.dist;
    const gy = cb.y + uy * hit.dist;
    const ghost = new THREE.Mesh(this.ghost.geometry, this.ghost.material);
    ghost.scale.setScalar(R);
    ghost.position.copy(v3(gx, gy, R));
    const ring = new THREE.Mesh(this.ring.geometry, this.ring.material);
    ring.scale.setScalar(R);
    ring.rotation.x = -Math.PI / 2;
    ring.position.copy(v3(gx, gy, 0.0015));
    this.guide.add(ghost, ring);
    if (hit.ball > 0) {
      const legal = this.ballsOn.length === 0 || this.ballsOn.includes(hit.ball);
      (this.ring.material as THREE.MeshBasicMaterial).color.set(legal ? '#ffffff' : '#ff4d4d');
      // object ball goes along the line of centres; the cue ball off along the tangent
      const nx = -hit.nx;
      const ny = -hit.ny;
      const ob = this.state[hit.ball];
      const objLen = this.guideLength === 'short' ? 0.12 : 0.35;
      this.guide.add(this.strip(ob.x, ob.y, ob.x + nx * objLen, ob.y + ny * objLen, R * 0.14, h, this.objLineMat));
      const dot = ux * nx + uy * ny;
      let tx = ux - dot * nx;
      let ty = uy - dot * ny;
      const tl = Math.hypot(tx, ty);
      if (tl > 0.05) {
        tx /= tl;
        ty /= tl;
        this.guide.add(this.strip(gx, gy, gx + tx * objLen * 0.6 * tl, gy + ty * objLen * 0.6 * tl, R * 0.08, h, this.lineMat));
      }
    } else {
      (this.ring.material as THREE.MeshBasicMaterial).color.set('#ffffff');
    }
  }

  private strip(x0: number, y0: number, x1: number, y1: number, w: number, h: number, mat: THREE.Material): THREE.Mesh {
    const len = Math.hypot(x1 - x0, y1 - y0);
    const geo = new THREE.PlaneGeometry(len, w);
    geo.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(geo, mat);
    m.position.copy(v3((x0 + x1) / 2, (y0 + y1) / 2, h));
    m.rotation.y = Math.atan2(y1 - y0, x1 - x0);
    m.renderOrder = 2;
    return m;
  }

  private desiredCamera(): { pos: THREE.Vector3; look: THREE.Vector3; up: THREE.Vector3 } {
    const spec = this.spec;
    const up = new THREE.Vector3(0, 1, 0);
    if (!spec || !this.table) return { pos: new THREE.Vector3(0, 3, 3), look: new THREE.Vector3(), up };
    const OA = this.table.outerA;
    const OB = this.table.outerB;
    const tan = Math.tan((this.camera.fov * Math.PI) / 360);
    const aspect = this.camera.aspect;
    if (this.mode === 'top' || (this.mode !== 'orbit' && this.playing && this.topDuringShot)) {
      const portrait = aspect < 1;
      const long = OA * 1.06;
      const short = OB * 1.12;
      const h = portrait ? Math.max(long / tan, short / (tan * aspect)) : Math.max(short / tan, long / (tan * aspect));
      return { pos: new THREE.Vector3(0, h, 0.0001), look: new THREE.Vector3(0, 0, 0), up: portrait ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, -1) };
    }
    if (this.mode === 'orbit') {
      const r = spec.length * 0.95;
      return {
        pos: new THREE.Vector3(Math.cos(this.orbitAngle) * r, spec.length * 0.42, Math.sin(this.orbitAngle) * r * 0.75),
        look: new THREE.Vector3(0, -0.05, 0),
        up,
      };
    }
    // aim / sight: behind the cue ball, looking along the shot
    const cb = this.placing ? v3(this.placing.x, this.placing.y, spec.ballRadius) : (this.balls[0]?.position.clone() ?? new THREE.Vector3());
    const d = this.cueDir();
    if (this.playing) {
      // an overview from behind the shot while the balls run
      const back = spec.length * 0.55;
      const pos = cb.clone().multiplyScalar(0.4).addScaledVector(d, -back);
      pos.y = spec.length * 0.48;
      return { pos, look: cb.clone().multiplyScalar(0.35).addScaledVector(d, spec.length * 0.15), up };
    }
    if (this.mode === 'sight') {
      // the eye just above the cue's own line, looking down it through the cue ball
      const back = 0.42;
      const eye = cb.clone().addScaledVector(d, -back * Math.cos(this.cueElev));
      eye.y = cb.y + back * Math.sin(this.cueElev) + 0.035;
      return { pos: eye, look: cb.clone().addScaledVector(d, 1.6).setY(spec.ballRadius * 0.5), up };
    }
    const scale = (spec.id === 'snooker' ? 1.15 : 0.9) * this.zoom;
    const dist = (0.55 + this.pitch * 0.5) * scale;
    const height = (0.12 + this.pitch * 0.75) * scale;
    return { pos: cb.clone().addScaledVector(d, -dist).setY(spec.ballRadius + height), look: cb.clone().addScaledVector(d, 0.35 * scale), up };
  }

  /** In aim mode, jump to the overhead view while the balls run (instead of the chase view). */
  topDuringShot = false;

  private updateCamera(dt: number): void {
    if (this.mode === 'orbit') this.orbitAngle += dt * 0.06;

    const want = this.desiredCamera();
    const k = 1 - Math.exp(-dt * ((this.mode === 'aim' || this.mode === 'sight') && !this.playing ? 9 : 3.2));
    this.camPos.lerp(want.pos, k);
    this.camLook.lerp(want.look, k);
    this.camUp.lerp(want.up, k).normalize();
    this.camera.position.copy(this.camPos);
    this.camera.up.copy(this.camUp);
    this.camera.lookAt(this.camLook);
    this.fadeLamps(dt);
  }

  /** Snap the camera to where it wants to be (no glide). */
  snapCamera(): void {
    const want = this.desiredCamera();
    this.camPos.copy(want.pos);
    this.camLook.copy(want.look);
    this.camUp.copy(want.up);
  }
}
