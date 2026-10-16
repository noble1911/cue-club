// Playing a match at the table: input (aim, power, spin, ball in hand), the turn loop for each
// kind of seat (a person here, the computer, or someone online), playing shots back, the HUD,
// and the end of frames and matches. The same screen serves every mode.

import { canPlace, checkShot, cleanShot, concede, nextFrame, rulesOf, say, takeShot, type Match } from '../sim/game.ts';
import { simulate, type Shot } from '../sim/physics.ts';
import type { AiLevel } from '../sim/ai.ts';
import type { Player } from '../sim/rules/types.ts';
import { pointsRemaining } from '../sim/rules/snooker.ts';
import { shotNumber, type Aim } from '../net/protocol.ts';
import { sound } from '../audio.ts';
import type { GuideLength, TableView } from '../render/view.ts';
import { think } from './ai-client.ts';
import { judgeMeter, judgeStroke, type Cueing, type StrokeSample } from './stroke.ts';
import { el, esc, store } from '../ui/dom.ts';
import { binds, controlsTable, hasMouse, keyLayout, layoutSwitch, normKey, setKeyLayout, type KeyLayout } from '../ui/controls.ts';

export type SeatKind = 'human' | 'ai' | 'remote';

export interface TableScreenOptions {
  view: TableView;
  root: HTMLElement;
  match: Match;
  seats: [SeatKind, SeatKind];
  aiLevel?: AiLevel;
  /** A label above the message, e.g. "Semi-final". */
  title?: string;
  /** Online: the room's aim guide, set by the host (the player can't change it). */
  guide?: GuideLength;
  /** How shots are struck: casual (pick a power), club (target + stroke), pro (stroke speed). */
  cueing?: Cueing;
  online?: {
    shot(shot: Shot, n: number): void;
    aim(aim: Aim): void;
    concede(): void;
  };
  /** Leave the table (to the menu, or back to the room). */
  onExit(): void;
  /** Local matches: play again with the same settings. */
  onRematch?(): void;
}

const TAU = Math.PI * 2;
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const frameDelay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function animate(ms: number, step: (k: number) => void): Promise<void> {
  return new Promise((res) => {
    const t0 = performance.now();
    const f = () => {
      const k = Math.min(1, (performance.now() - t0) / ms);
      step(k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
      if (k < 1) requestAnimationFrame(f);
      else res();
    };
    requestAnimationFrame(f);
  });
}

export class TableScreen {
  match: Match;
  private view: TableView;
  private o: TableScreenOptions;
  private dom: HTMLElement;
  private aim = { dx: 1, dy: 0, power: 0, side: 0, height: 0 };
  /** Club cueing: the power the player is going for (arrow keys, or how far they pulled back). */
  private target = 0.4;
  /** Keyboard club/pro: the sweeping meter, started by the first Space. */
  private meter: { t0: number } | null = null;
  private place: { x: number; y: number } | null = null;
  private busy = false;
  private waitingForServer = false;
  private disposed = false;
  private queue: Promise<void> = Promise.resolve();
  private keys = new Set<string>();
  private lastSentAim = '';
  private lastSentAt = 0;
  private remoteAim: Aim | null = null;
  private cleanup: (() => void)[] = [];
  private $: Record<string, HTMLElement> = {};

  constructor(o: TableScreenOptions) {
    this.o = o;
    this.view = o.view;
    this.match = o.match;
    this.dom = el(`
      <div class="table-screen">
        <div class="hud">
          <div class="pcard" data-p="0"><div class="pname"></div><div class="pframes"></div><div class="pdetail"></div></div>
          <div class="hud-mid"><div class="htitle"></div><div class="hmsg"></div><div class="hon"></div></div>
          <div class="pcard" data-p="1"><div class="pname"></div><div class="pframes"></div><div class="pdetail"></div></div>
        </div>
        <div class="fine" title="Fine aim: drag up or down"><div class="fine-track"><div class="fine-grip"></div></div><span>Fine</span></div>
        <div class="spin" title="Where the cue strikes the cue ball (W A S D)"><div class="spin-face"><div class="spin-dot"></div></div><span>Spin</span></div>
        <div class="power" title="Drag down to pull the cue back, let go to shoot (↑ ↓ then Space)">
          <div class="power-track"><div class="power-fill"></div><div class="power-target"></div></div><span class="power-pct">Power</span>
        </div>
        <div class="tools">
 <button class="t-help" title="Controls (H)">? Controls</button>
          <button class="t-zoom" title="Hold to zoom in on the contact point (hold Z)">🔍 Zoom</button>
          <button class="t-cam" title="Camera (V)">⤢ View</button>
          <button class="t-guide" title="Aim guide">◎ Guide</button>
          <button class="t-menu" title="Menu (Esc)">☰</button>
        </div>
        <div class="hint"></div>
        <div class="banner hidden"></div>
        <div class="controls-panel hidden"></div>
        <div class="pause hidden">
          <div class="panel">
            <h2>Paused</h2>
            <button class="p-resume primary">Resume</button>
            <button class="p-help">Controls</button>
            <button class="p-sound"></button>
            <button class="p-concede">Concede frame</button>
            <button class="p-quit">Leave table</button>
          </div>
        </div>
      </div>`);
    for (const k of ['hmsg', 'hon', 'htitle', 'hint', 'banner', 'pause', 'controls-panel', 'spin-dot', 'power-fill', 'power-pct', 'power-target', 'fine', 'fine-grip', 'power', 'spin', 'p-sound', 'p-concede', 't-guide', 't-cam']) {
      this.$[k] = this.dom.querySelector('.' + k)!;
    }
    o.root.appendChild(this.dom);
    this.view.guideLength = o.guide ?? (store.get('guide') as GuideLength) ?? 'full';
    const cam = store.get('camera');
    this.view.mode = cam === 'top' || cam === 'sight' ? cam : 'aim';
    this.view.setVariant(rulesOf(this.match));
    this.view.setBalls(this.match.frame.balls);
    this.view.snapCamera();
    this.bindInput();
    this.view.onRender = (dt) => this.onFrame(dt);
    this.refreshTools();
    this.beginTurn();
  }

  // ---------------------------------------------------------------- state

  private get rules() {
    return rulesOf(this.match);
  }
  private get turn(): Player {
    return this.match.frame.turn;
  }
  private get myTurn(): boolean {
    return this.o.seats[this.turn] === 'human' && !this.busy && !this.match.frame.over && this.match.winner === null;
  }
  private get names(): [string, string] {
    return this.match.setup.names;
  }
  private say(t: string): string {
    return say(t, this.names);
  }

  /** Online: the server's word on the match (start, next frame, a concession, a reconnect). */
  setMatch(m: Match): void {
    this.enqueue(async () => {
      this.match = m;
      this.view.setVariant(rulesOf(m));
      this.view.setBalls(m.frame.balls);
      this.waitingForServer = false;
      this.beginTurn();
    });
  }

  /** Online: a shot the server has refereed (ours or the other player's). */
  applyShot(shot: Shot, after: Match): void {
    this.enqueue(() => this.playShot(shot, after));
  }

  /** Online: the other player is lining up. */
  remoteAiming(aim: Aim): void {
    this.remoteAim = aim;
  }

  private enqueue(job: () => Promise<void> | void): void {
    this.queue = this.queue.then(async () => {
      if (!this.disposed) await job();
    }).catch((e) => console.error(e));
  }

  // ---------------------------------------------------------------- turns

  private beginTurn(): void {
    const f = this.match.frame;
    this.refreshHud();
    this.view.ballsOn = this.rules.ballsOn(f);
    if (f.over || this.match.winner !== null) {
      this.view.aim = null;
      this.view.placing = null;
      this.showBanner();
      return;
    }
    this.hideBanner();
    this.remoteAim = null;
    // where the cue ball is (or goes, when it's in hand)
    if (f.inHand) {
      const cb = f.balls[0];
      this.place = canPlace(this.match, cb.x, cb.y) ? { x: cb.x, y: cb.y } : this.defaultPlace();
    } else this.place = null;
    this.aim.power = 0;
    this.aim.side = 0;
    this.aim.height = 0;
    this.meter = null;
    this.pointAtNearest();
    this.syncView();
    const seat = this.o.seats[this.turn];
    if (seat === 'ai') void this.runAi();
    this.refreshHint();
  }

  private defaultPlace(): { x: number; y: number } {
    const t = this.rules.table;
    const tries = this.match.frame.inHand === 'd' ? [[t.baulkX - 0.02, -t.dRadius * 0.4], [t.baulkX - 0.05, t.dRadius * 0.4], [t.baulkX - 0.1, 0]] : [[t.baulkX - 0.12, 0], [t.baulkX - 0.12, 0.1], [t.baulkX - 0.2, -0.1], [-0.3, 0.2]];
    for (const [x, y] of tries) if (canPlace(this.match, x, y)) return { x, y };
    for (let i = 0; i < 400; i++) {
      const x = (Math.random() - 0.5) * t.length * 0.9;
      const y = (Math.random() - 0.5) * t.width * 0.9;
      if (canPlace(this.match, x, y)) return { x, y };
    }
    return { x: t.baulkX - 0.1, y: 0 };
  }

  private cuePos(): { x: number; y: number } {
    return this.place ?? this.match.frame.balls[0];
  }

  private pointAtNearest(): void {
    const c = this.cuePos();
    const on = this.view.ballsOn.length ? this.view.ballsOn : this.match.frame.balls.filter((b) => b.on && b.id !== 0).map((b) => b.id);
    let best: { x: number; y: number } | null = null;
    let bd = Infinity;
    for (const id of on) {
      const b = this.match.frame.balls[id];
      if (!b?.on) continue;
      const d = (b.x - c.x) ** 2 + (b.y - c.y) ** 2;
      if (d < bd) {
        bd = d;
        best = b;
      }
    }
    if (best) this.setAimAngle(Math.atan2(best.y - c.y, best.x - c.x));
  }

  private setAimAngle(a: number): void {
    this.aim.dx = Math.cos(a);
    this.aim.dy = Math.sin(a);
  }

  private get aimAngle(): number {
    return Math.atan2(this.aim.dy, this.aim.dx);
  }

  private syncView(): void {
    const f = this.match.frame;
    this.view.aim = { ...this.aim };
    this.view.placing = f.inHand && this.place ? { ...this.place, valid: canPlace(this.match, this.place.x, this.place.y) } : null;
    if (this.view.placing) {
      // show the cue ball where it's being placed
      const balls = this.view.ballState.map((b) => (b.id === 0 ? { ...b, x: this.place!.x, y: this.place!.y, on: true } : b));
      this.view.setBalls(balls);
    }
    this.$['spin-dot'].style.transform = `translate(${this.aim.side * 34}px, ${-this.aim.height * 34}px)`;
    this.$['power-fill'].style.height = `${this.aim.power * 100}%`;
    const mode = this.cueing;
    this.$['power-target'].style.display = mode === 'club' ? 'block' : 'none';
    this.$['power-target'].style.top = `${this.target * 100}%`;
    this.$['power-pct'].textContent =
      mode === 'pro' ? 'Stroke' : mode === 'club' ? `${Math.round(this.target * 100)}%` : this.aim.power > 0 ? `${Math.round(this.aim.power * 100)}%` : 'Power';
  }

  // ---------------------------------------------------------------- shots

  private shotFromAim(): Shot {
    const s: Shot = { dx: this.aim.dx, dy: this.aim.dy, power: this.aim.power, side: this.aim.side, height: this.aim.height };
    if (this.match.frame.inHand && this.place) s.place = { ...this.place };
    return cleanShot(s);
  }

  private shoot(): void {
    if (!this.myTurn || this.waitingForServer) return;
    if (this.aim.power < 0.01) return this.flash('Pull the power bar down to shoot');
    const shot = this.shotFromAim();
    const problem = checkShot(this.match, shot);
    if (problem) return this.flash(problem.charAt(0).toUpperCase() + problem.slice(1));
    sound.unlock();
    if (this.o.online) {
      this.waitingForServer = true;
      this.o.online.shot(shot, shotNumber(this.match));
      this.refreshHint();
      return;
    }
    this.enqueue(() => this.playShot(shot));
  }

  /** Play a shot: the stroke, the balls running, then the judged result. */
  private async playShot(shot: Shot, after?: Match): Promise<void> {
    this.busy = true;
    this.waitingForServer = false;
    this.refreshHint();
    const before = this.match;
    this.aim = { dx: shot.dx, dy: shot.dy, power: shot.power, side: shot.side, height: shot.height };
    if (shot.place) this.place = { ...shot.place };
    this.syncView();
    this.view.placing = null;
    await this.view.strike();
    sound.cue(shot.power);
    let result;
    let next: Match;
    if (after) {
      // online: animate the server's shot from our copy of the match; land on its state
      result = simulate(rulesOf(before).table, before.frame.balls, shot, { record: true });
      next = after;
    } else {
      const out = takeShot(before, shot, true);
      result = out.result;
      next = out.match;
    }
    await this.view.play(result, (e) => sound.event(e));
    this.view.aim = null;
    if (this.disposed) return;
    this.match = next;
    this.view.setBalls(next.frame.balls);
    this.busy = false;
    this.beginTurn();
  }

  private async runAi(): Promise<void> {
    const m = this.match;
    const level = this.o.aiLevel ?? 'medium';
    this.refreshHint();
    const started = performance.now();
    const shot = await think(m, level, (m.setup.seed ^ Math.imul(m.frameNo, 7919) ^ Math.imul(m.frame.shots + 1, 104729)) >>> 0);
    await frameDelay(Math.max(0, 700 - (performance.now() - started)));
    if (this.disposed || this.match !== m) return;
    // let it be seen lining up: place the cue ball, turn the cue, pull it back
    if (shot.place && this.place) {
      const from = { ...this.place };
      await animate(450, (k) => {
        this.place = { x: from.x + (shot.place!.x - from.x) * k, y: from.y + (shot.place!.y - from.y) * k };
        this.syncView();
      });
    }
    const a0 = this.aimAngle;
    let da = Math.atan2(shot.dy, shot.dx) - a0;
    da = ((((da + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
    await animate(500 + Math.abs(da) * 250, (k) => {
      this.setAimAngle(a0 + da * k);
      this.aim.side = shot.side * k;
      this.aim.height = shot.height * k;
      this.syncView();
    });
    await animate(380, (k) => {
      this.aim.power = shot.power * k;
      this.syncView();
    });
    await frameDelay(150);
    if (this.disposed || this.match !== m) return;
    this.enqueue(() => this.playShot(shot));
  }

  // ---------------------------------------------------------------- per frame

  private onFrame(dt: number): void {
    if (this.disposed) return;
    if (this.myTurn) {
      const fine = (this.keys.has('Shift') ? 0.08 : 1) * (this.view.mode === 'sight' ? 0.35 : 1);
      const b = binds();
      let turn = 0;
      if (this.keys.has(b.aimLeft)) turn += 1;
      if (this.keys.has(b.aimRight)) turn -= 1;
      if (turn) {
        // in the aim view, left turns the cue left (anticlockwise seen from above)
        this.setAimAngle(this.aimAngle + turn * dt * 0.6 * fine);
        this.syncView();
      }
      if ((this.keys.has(b.powerUp) || this.keys.has(b.powerDown)) && !this.meter) {
        const d = (this.keys.has(b.powerUp) ? 1 : -1) * dt * 0.5 * fine;
        if (this.cueing === 'club') this.target = clamp(this.target + d, 0.02, 1);
        else if (this.cueing === 'casual') this.aim.power = clamp(this.aim.power + d, 0, 1);
        this.syncView();
      }
      if (this.meter) {
        this.aim.power = this.meterValue();
        this.syncView();
      }
      if (this.o.online) this.sendAim();
    } else if (this.remoteAim && !this.busy && this.o.seats[this.turn] === 'remote') {
      // ease towards what the other player is doing
      const r = this.remoteAim;
      const k = 1 - Math.exp(-dt * 12);
      let da = Math.atan2(r.dy, r.dx) - this.aimAngle;
      da = ((((da + Math.PI) % TAU) + TAU) % TAU) - Math.PI;
      this.setAimAngle(this.aimAngle + da * k);
      this.aim.power += (r.power - this.aim.power) * k;
      this.aim.side += (r.side - this.aim.side) * k;
      this.aim.height += (r.height - this.aim.height) * k;
      if (r.place && this.match.frame.inHand) this.place = { ...r.place };
      this.syncView();
    }
  }

  private sendAim(): void {
    const now = performance.now();
    if (now - this.lastSentAt < 70) return;
    const a: Aim = { ...this.aim, ...(this.place && this.match.frame.inHand ? { place: this.place } : {}) };
    const key = JSON.stringify(a);
    if (key === this.lastSentAim) return;
    this.lastSentAim = key;
    this.lastSentAt = now;
    this.o.online!.aim(a);
  }

  // ---------------------------------------------------------------- input

  /** A stroke in progress: from the power bar (touch) or the left mouse button (anywhere). */
  private stroking: null | { x: number; y: number; px: number; dead: number; back: number; forward: StrokeSample[] | null } = null;

  /** Start a stroke at (x, y); `px` is how far a full pull back moves the pointer. */
  private strokeBegin(x: number, y: number, px: number, dead: number): void {
    this.stroking = { x, y, px, dead, back: 0, forward: null };
    this.meter = null;
    this.aim.power = 0;
    this.syncView();
  }

  /** Pull back (pointer moving down/towards you) and, in club/pro, the push through. */
  private strokeMove(x: number, y: number): void {
    const st = this.stroking;
    if (!st) return;
    const p = clamp((y - st.y) / st.px, 0, 1);
    this.aim.power = p;
    if (this.cueing === 'casual') return this.syncView();
    if (!st.forward) {
      if (p >= st.back) {
        st.back = p;
        if (this.cueing === 'club') this.target = p;
      } else if (st.back - p > 0.03 && st.back > Math.max(0.04, st.dead)) {
        st.forward = [{ t: performance.now(), x: x - st.x, pull: st.back }];
      }
    }
    if (st.forward) {
      st.forward.push({ t: performance.now(), x: x - st.x, pull: p });
      if (p <= 0.015) {
        this.stroking = null;
        return this.strike(judgeStroke(this.cueing as 'club' | 'pro', st.forward, st.px));
      }
    }
    this.syncView();
  }

  /** Button or finger lifted. */
  private strokeEnd(): void {
    const st = this.stroking;
    if (!st) return;
    this.stroking = null;
    if (this.cueing === 'casual') {
      if (this.aim.power >= Math.max(0.015, st.dead)) this.shoot();
      else {
        this.aim.power = 0;
        this.syncView();
      }
      return;
    }
    // let go mid-push: struck where it got to, if it was really going forward
    if (st.forward && st.forward.length > 2 && st.back - st.forward[st.forward.length - 1].pull > st.back * 0.5) {
      return this.strike(judgeStroke(this.cueing as 'club' | 'pro', st.forward, st.px));
    }
    this.aim.power = 0;
    this.syncView();
    if (st.back > Math.max(0.04, st.dead)) this.flash('Push the cue forward through the ball to play the shot');
  }

  private bindInput(): void {
    const canvas = this.view.renderer.domElement;
    let drag: null | { kind: 'aim' | 'place' | 'stroke'; x: number; y: number; angle: number; pitch: number } = null;
    const onDown = (e: PointerEvent) => {
      sound.unlock();
      if (this.view.isPlaying) return this.view.hurry();
      if (!this.myTurn || this.waitingForServer) return;
      const mouse = e.pointerType === 'mouse';
      if (mouse && e.button !== 0 && e.button !== 2) return;
      canvas.setPointerCapture(e.pointerId);
      if (this.match.frame.inHand && this.place && (!mouse || e.button === 0)) {
        const p = this.view.project(this.place.x, this.place.y);
        const near = Math.hypot(p.x - e.clientX, p.y - e.clientY) < 34;
        if (near) {
          drag = { kind: 'place', x: e.clientX, y: e.clientY, angle: 0, pitch: 0 };
          return;
        }
      }
      // a mouse strikes with the left button (pull back, push forward) and aims with the right;
      // a finger aims on the table and strikes on the power bar
      if (mouse && e.button === 0) {
        if (this.match.frame.inHand && this.place && !canPlace(this.match, this.place.x, this.place.y)) return this.flash('Place the cue ball first');
        drag = { kind: 'stroke', x: e.clientX, y: e.clientY, angle: 0, pitch: 0 };
        // a full pull back is ~a third of the screen height; ignore twitches under 12 px
        const px = Math.max(220, window.innerHeight * 0.32);
        this.strokeBegin(e.clientX, e.clientY, px, 12 / px);
        return;
      }
      drag = { kind: 'aim', x: e.clientX, y: e.clientY, angle: this.aimAngle, pitch: this.view.pitch };
      if (this.view.mode === 'top') this.aimAtPointer(e);
    };
    const onMove = (e: PointerEvent) => {
      if (!drag || !this.myTurn) return;
      if (drag.kind === 'stroke') return this.strokeMove(e.clientX, e.clientY);
      if (drag.kind === 'place') {
        const p = this.view.pick(e.clientX, e.clientY);
        if (p) {
          this.place = p;
          this.syncView();
        }
        return;
      }
      if (this.view.mode === 'top') return this.aimAtPointer(e);
      // down the cue you're making the finest adjustments
      const fine = (e.shiftKey ? 0.12 : 1) * (this.view.mode === 'sight' ? 0.3 : 1);
      this.setAimAngle(drag.angle - (e.clientX - drag.x) * 0.0045 * fine);
      if (this.view.mode === 'aim') this.view.pitch = clamp(drag.pitch + (e.clientY - drag.y) * 0.004, 0, 1);
      this.syncView();
    };
    const onUp = () => {
      if (drag?.kind === 'stroke') {
        drag = null;
        return this.strokeEnd();
      }
      if (drag?.kind === 'place' && this.place && !canPlace(this.match, this.place.x, this.place.y)) this.flash('The cue ball can’t go there');
      drag = null;
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (this.view.mode === 'aim') this.view.zoom = clamp(this.view.zoom * (1 + Math.sign(e.deltaY) * 0.08), 0.5, 2.2);
    };
    const noMenu = (e: Event) => e.preventDefault();
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('contextmenu', noMenu);
    this.cleanup.push(() => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerup', onUp);
      canvas.removeEventListener('pointercancel', onUp);
      canvas.removeEventListener('wheel', onWheel);
      canvas.removeEventListener('contextmenu', noMenu);
    });

    // the power bar: the same stroke, for fingers (or a mouse that prefers it)
    const power = this.$['power'];
    power.addEventListener('pointerdown', (e) => {
      sound.unlock();
      if (!this.myTurn || this.waitingForServer) return;
      power.setPointerCapture(e.pointerId);
      this.strokeBegin(e.clientX, e.clientY, power.querySelector('.power-track')!.getBoundingClientRect().height * 0.9, 0);
    });
    power.addEventListener('pointermove', (e) => this.strokeMove(e.clientX, e.clientY));
    power.addEventListener('pointerup', () => this.strokeEnd());
    power.addEventListener('pointercancel', () => this.strokeEnd());

    // fine aim: a wheel nudging the cue by fractions of a degree
    const fine = this.$['fine'];
    let fineFrom: { y: number; angle: number } | null = null;
    fine.addEventListener('pointerdown', (e) => {
      if (!this.myTurn || this.waitingForServer) return;
      fine.setPointerCapture(e.pointerId);
      fineFrom = { y: e.clientY, angle: this.aimAngle };
    });
    fine.addEventListener('pointermove', (e) => {
      if (!fineFrom || !this.myTurn) return;
      const dy = e.clientY - fineFrom.y;
      this.setAimAngle(fineFrom.angle - dy * 0.00013);
      this.$['fine-grip'].style.backgroundPositionY = `${dy}px`;
      this.syncView();
    });
    const fineEnd = () => (fineFrom = null);
    fine.addEventListener('pointerup', fineEnd);
    fine.addEventListener('pointercancel', fineEnd);

    // spin
    const spin = this.$['spin'].querySelector('.spin-face') as HTMLElement;
    let spinning = false;
    const setSpin = (e: PointerEvent) => {
      const r = spin.getBoundingClientRect();
      let x = ((e.clientX - r.left) / r.width) * 2 - 1;
      let y = -(((e.clientY - r.top) / r.height) * 2 - 1);
      const l = Math.hypot(x, y);
      if (l > 0.85) {
        x *= 0.85 / l;
        y *= 0.85 / l;
      }
      this.aim.side = x / 0.85;
      this.aim.height = y / 0.85;
      this.syncView();
    };
    spin.addEventListener('pointerdown', (e) => {
      if (!this.myTurn) return;
      spinning = true;
      spin.setPointerCapture(e.pointerId);
      setSpin(e);
    });
    spin.addEventListener('pointermove', (e) => spinning && this.myTurn && setSpin(e));
    spin.addEventListener('pointerup', () => (spinning = false));
    spin.addEventListener('dblclick', () => {
      if (!this.myTurn) return;
      this.aim.side = 0;
      this.aim.height = 0;
      this.syncView();
    });

    // keys
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      const key = normKey(e.key);
      if (e.type === 'keyup') {
        if (key === 'z') this.view.zoomHold = false;
        return void this.keys.delete(key);
      }
      this.keys.add(key);
      if (key === 'z') this.view.zoomHold = true;
      if (key === 'Escape') {
        if (!this.$['controls-panel'].classList.contains('hidden')) return this.toggleControls(false);
        this.togglePause();
      }
      if (key === 'v') this.toggleCamera();
      if (key === 'h' || key === '?') this.toggleControls();
      if (!this.myTurn) {
        if (e.key === ' ' && this.view.isPlaying) this.view.hurry();
        return;
      }
      const step = e.shiftKey ? 0.02 : 0.1;
      if (e.key === ' ') {
        e.preventDefault();
        if (e.repeat) return;
        if (this.cueing === 'casual') return this.shoot();
        // club/pro: the first press starts the meter sweeping, the second strikes
        if (!this.meter) {
          this.meter = { t0: performance.now() };
          return;
        }
        const at = this.meterValue();
        this.meter = null;
        return this.strike(judgeMeter(this.cueing as 'club' | 'pro', this.target, at));
      }
      if (key.startsWith('Arrow')) e.preventDefault();
      const b = binds();
      if ([b.spinUp, b.spinDown, b.spinLeft, b.spinRight].includes(key)) {
        if (key === b.spinUp) this.aim.height = clamp(this.aim.height + step, -1, 1);
        if (key === b.spinDown) this.aim.height = clamp(this.aim.height - step, -1, 1);
        if (key === b.spinLeft) this.aim.side = clamp(this.aim.side - step, -1, 1);
        if (key === b.spinRight) this.aim.side = clamp(this.aim.side + step, -1, 1);
        this.syncView();
      }
    };
    const blur = () => {
      this.keys.clear();
      this.view.zoomHold = false;
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', blur);
    this.cleanup.push(() => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', blur);
    });

    // buttons
    const zoom = this.dom.querySelector('.t-zoom') as HTMLElement;
    zoom.addEventListener('pointerdown', (e) => {
      zoom.setPointerCapture(e.pointerId);
      this.view.zoomHold = true;
    });
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) zoom.addEventListener(t, () => (this.view.zoomHold = false));
    this.dom.querySelector('.t-cam')!.addEventListener('click', () => this.toggleCamera());
    this.dom.querySelector('.t-guide')!.addEventListener('click', () => {
      if (this.o.guide) return this.flash('The host sets the aim guide for this room');
      const order: GuideLength[] = ['full', 'short', 'off'];
      this.view.guideLength = order[(order.indexOf(this.view.guideLength) + 1) % 3];
      store.set('guide', this.view.guideLength);
      this.refreshTools();
    });
    this.dom.querySelector('.t-menu')!.addEventListener('click', () => this.togglePause());
    this.dom.querySelector('.t-help')!.addEventListener('click', () => this.toggleControls());
    this.dom.querySelector('.p-help')!.addEventListener('click', () => {
      this.togglePause(false);
      this.toggleControls(true);
    });
    this.$['controls-panel'].addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      if (t === this.$['controls-panel'] || t.closest('.ctl-close')) return this.toggleControls(false);
      const layout = t.closest<HTMLElement>('[data-layout]')?.dataset.layout as KeyLayout | undefined;
      if (layout) {
        setKeyLayout(layout);
        this.keys.clear();
        this.renderControls();
      }
    });
    // the first game on this device: show the controls once
    if (!store.get('seenControls') && this.o.seats.includes('human')) {
      store.set('seenControls', '1');
      this.toggleControls(true);
    }
    this.dom.querySelector('.p-resume')!.addEventListener('click', () => this.togglePause(false));
    this.$['p-sound'].addEventListener('click', () => {
      sound.setMuted(!sound.muted);
      this.refreshTools();
    });
    this.$['p-concede'].addEventListener('click', () => {
      this.togglePause(false);
      this.concede();
    });
    this.dom.querySelector('.p-quit')!.addEventListener('click', () => this.o.onExit());
  }

  private get cueing(): Cueing {
    return this.o.cueing ?? 'casual';
  }

  /** The keyboard meter: up and down the bar, 1.4 s each way. */
  private meterValue(): number {
    const t = (performance.now() - (this.meter?.t0 ?? 0)) / 1400;
    const k = t % 2;
    return k < 1 ? k : 2 - k;
  }

  /** A judged stroke: turn the cue by the error, set the power, and play it. */
  private strike(r: { power: number; aimError: number; verdict: string; clean: boolean }): void {
    if (!this.myTurn) return;
    this.setAimAngle(this.aimAngle + r.aimError);
    this.aim.power = r.power;
    this.syncView();
    this.shoot();
    this.flash(r.verdict);
  }

  private aimAtPointer(e: PointerEvent): void {
    const p = this.view.pick(e.clientX, e.clientY);
    if (!p) return;
    const c = this.cuePos();
    if (Math.hypot(p.x - c.x, p.y - c.y) < 0.01) return;
    this.setAimAngle(Math.atan2(p.y - c.y, p.x - c.x));
    this.syncView();
  }

  private renderControls(): void {
    const mouse = hasMouse();
    this.$['controls-panel'].innerHTML = `<div class="panel ctl-panel">
      <h2>Controls</h2>
      <p class="muted">${this.cueing === 'casual' ? 'Casual' : this.cueing === 'club' ? 'Club' : 'Pro'} cueing · ${mouse ? 'mouse &amp; keyboard' : 'touch'}</p>
      ${controlsTable(this.cueing, mouse)}
      ${mouse ? layoutSwitch(keyLayout()) : ''}
      <button class="ctl-close primary">Got it</button>
    </div>`;
  }

  private toggleControls(show?: boolean): void {
    const p = this.$['controls-panel'];
    const on = show ?? p.classList.contains('hidden');
    if (on) this.renderControls();
    p.classList.toggle('hidden', !on);
  }

  private toggleCamera(): void {
    this.view.mode = this.view.mode === 'aim' ? 'sight' : this.view.mode === 'sight' ? 'top' : 'aim';
    store.set('camera', this.view.mode);
    this.refreshTools();
    this.refreshHint();
  }

  private togglePause(show?: boolean): void {
    const p = this.$['pause'];
    const on = show ?? p.classList.contains('hidden');
    p.classList.toggle('hidden', !on);
    this.refreshTools();
  }

  private concede(): void {
    const f = this.match.frame;
    if (f.over || this.match.winner !== null) return;
    if (this.o.online) return this.o.online.concede();
    // vs the computer it's the person; pass & play, whoever is at the table
    const who: Player = this.o.seats[0] === 'ai' ? 1 : this.o.seats[1] === 'ai' ? 0 : this.turn;
    this.enqueue(() => {
      this.match = concede(this.match, who);
      this.beginTurn();
    });
  }

  // ---------------------------------------------------------------- HUD

  private refreshTools(): void {
    this.$['t-guide'].textContent = `◎ Guide: ${this.view.guideLength}${this.o.guide ? ' 🔒' : ''}`;
    this.$['t-guide'].title = this.o.guide ? 'Set by the room host' : 'Aim guide';
    this.$['t-cam'].textContent = this.view.mode === 'top' ? '⤢ Overhead' : this.view.mode === 'sight' ? '⤢ Sight' : '⤢ Cue view';
    this.$['p-sound'].textContent = sound.muted ? 'Sound: off' : 'Sound: on';
    const canConcede = this.o.seats.includes('human') && !this.match.frame.over;
    this.$['p-concede'].classList.toggle('hidden', !canConcede);
  }

  private refreshHud(): void {
    const m = this.match;
    const f = m.frame;
    const rules = this.rules;
    this.dom.querySelectorAll<HTMLElement>('.pcard').forEach((card) => {
      const p = Number(card.dataset.p) as Player;
      card.classList.toggle('active', f.turn === p && !f.over);
      card.querySelector('.pname')!.textContent = this.names[p];
      card.querySelector('.pframes')!.textContent = m.setup.raceTo > 1 ? `${m.wins[p]}` : '';
      card.querySelector('.pframes')!.classList.toggle('hidden', m.setup.raceTo <= 1);
      const detail = card.querySelector('.pdetail') as HTMLElement;
      if (rules.id === 'snooker') {
        detail.innerHTML = `<b class="pts">${f.points[p]}</b>${f.turn === p && f.brk > 0 ? `<span class="brk">Break ${f.brk}</span>` : ''}`;
      } else detail.innerHTML = this.chips(p) + `<span class="grp">${esc(rules.onText(f, p))}</span>`;
    });
    this.$['htitle'].textContent = this.o.title ?? (m.setup.raceTo > 1 ? `Frame ${m.frameNo} · first to ${m.setup.raceTo}` : rules.name);
    this.$['hmsg'].textContent = this.say(f.message);
    this.$['hmsg'].classList.toggle('foul', f.foul);
    const on = rules.id === 'snooker' ? `${rules.onText(f, f.turn)} · ${pointsRemaining(f)} remaining` : rules.id === 'nine' ? rules.onText(f, f.turn) : '';
    this.$['hon'].textContent = f.over ? '' : on;
  }

  /** Little balls showing what each pool player still has to pot. */
  private chips(p: Player): string {
    const f = this.match.frame;
    const rule = f.rule as { groups?: [string, string] | null };
    if (!rule.groups) return '';
    const g = rule.groups[p];
    const looks = this.rules.looks;
    const ids = f.balls.filter((b) => b.on && b.id !== 0 && b.id !== 8).map((b) => b.id).filter((id) => {
      if (this.rules.id === 'uk8') return (id <= 7 ? 'red' : 'yellow') === g;
      return (id < 8 ? 'solids' : 'stripes') === g;
    });
    return `<span class="chips">${ids.map((id) => `<i style="--c:${looks[id].color}" class="${looks[id].stripe ? 'st' : ''}">${looks[id].number ?? ''}</i>`).join('')}</span>`;
  }

  private refreshHint(): void {
    const f = this.match.frame;
    const seat = this.o.seats[this.turn];
    let h = '';
    if (this.busy) h = 'Tap to speed up';
    else if (this.waitingForServer) h = 'Sending…';
    else if (f.over) h = '';
    else if (seat === 'ai') h = `${esc(this.names[this.turn])} is thinking…`;
    else if (seat === 'remote') h = `${esc(this.names[this.turn])} is lining up…`;
    else {
      const mouse = matchMedia('(pointer: fine)').matches;
      const drag = mouse ? 'Right-drag' : 'Drag';
      const aim = this.view.mode === 'top' ? `${drag} on the table to aim` : this.view.mode === 'sight' ? `Looking down the cue: ${drag.toLowerCase()} left/right to fine-tune` : `${drag} left/right to aim${mouse ? '' : ', up/down to tilt'}`;
      const pull = mouse ? 'hold the left button and pull the mouse back' : 'pull the power bar down';
      const strike =
        this.cueing === 'club'
          ? `${pull} to your power, then push forward smoothly and straight`
          : this.cueing === 'pro'
            ? `${pull}, then push forward: the faster the push, the harder the hit`
            : `${pull} and let go to shoot`;
      h = (f.inHand ? 'Ball in hand: drag the cue ball to place it · ' : '') + `${aim} · ${strike}`;
    }
    this.$['hint'].textContent = h;
    this.dom.classList.toggle('my-turn', this.myTurn);
  }

  private flash(text: string): void {
    const m = this.$['hmsg'];
    m.textContent = text;
    m.classList.add('flash');
    setTimeout(() => {
      m.classList.remove('flash');
      if (!this.disposed) m.textContent = this.say(this.match.frame.message);
    }, 1800);
  }

  private showBanner(): void {
    const m = this.match;
    const f = m.frame;
    const over = f.over!;
    const winner = m.winner !== null ? m.winner : over.winner;
    const score = this.rules.id === 'snooker' ? `<div class="big">${f.points[0]} – ${f.points[1]}</div>` : '';
    const frames = m.setup.raceTo > 1 ? `<div class="frames">Frames ${m.wins[0]} – ${m.wins[1]}</div>` : '';
    const title = m.winner !== null ? `${esc(this.names[winner])} wins${m.setup.raceTo > 1 ? ' the match' : ''}!` : `${esc(this.names[over.winner])} takes the frame`;
    let buttons = '';
    if (this.o.online) {
      buttons = m.winner === null ? '<p class="muted">Next frame in a moment…</p>' : '<button class="b-exit primary">Continue</button>';
    } else if (m.winner === null) buttons = '<button class="b-next primary">Next frame</button><button class="b-exit">Menu</button>';
    else buttons = '<button class="b-again primary">Play again</button><button class="b-exit">Menu</button>';
    const b = this.$['banner'];
    b.innerHTML = `<div class="panel"><h2>${title}</h2><p>${esc(this.say(over.reason))}</p>${score}${frames}<div class="row">${buttons}</div></div>`;
    b.classList.remove('hidden');
    b.querySelector('.b-next')?.addEventListener('click', () => {
      this.enqueue(() => {
        this.match = nextFrame(this.match);
        this.view.setBalls(this.match.frame.balls);
        this.beginTurn();
      });
    });
    b.querySelector('.b-again')?.addEventListener('click', () => this.o.onRematch?.());
    b.querySelector('.b-exit')?.addEventListener('click', () => this.o.onExit());
    this.refreshHint();
  }

  private hideBanner(): void {
    this.$['banner'].classList.add('hidden');
  }

  dispose(): void {
    this.disposed = true;
    this.view.zoomHold = false;
    for (const c of this.cleanup) c();
    this.view.onRender = null;
    this.view.aim = null;
    this.view.placing = null;
    this.dom.remove();
  }
}
