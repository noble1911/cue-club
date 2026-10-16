// Sound, synthesised (no audio files). Each sound is modelled on what makes it: a phenolic ball
// rings at a few kilohertz for a few milliseconds (modal synthesis: a handful of damped
// sinusoids plus the contact crack); a cushion is a damped rubber thump; the cue tip a leather
// knock plus the cue ball's ring. The sounds are rendered once into buffers, then every impact
// replays one with loudness, brightness, pitch and stereo position from the physics (how hard,
// where on screen). On top: cloth rumble that follows the balls' speed, a room echo per room,
// pockets (a pool table's ball return, a snooker net), room ambience and snooker applause.

import type { SimEvent } from './sim/physics.ts';
import type { RoomTheme } from './render/room.ts';
import { store } from './ui/dom.ts';

type Pocket = 'net' | 'return';

/** Deterministic noise for the buffers (Math.random would do; this keeps them identical). */
function noiseGen(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) / 4294967296) * 2 - 1;
  };
}

interface Mode {
  f: number;
  /** Decay time constant, seconds. */
  tau: number;
  a: number;
}

class Sound {
  private ctx: AudioContext | null = null;
  private out: GainNode | null = null;
  private sfx: GainNode | null = null;
  private wet: GainNode | null = null;
  private amb: GainNode | null = null;
  private reverb: ConvolverNode | null = null;
  private rollGain: GainNode | null = null;
  private rollFilter: BiquadFilterNode | null = null;
  private buf: Record<string, AudioBuffer[]> = {};
  private theme: RoomTheme = 'club';
  private ambNodes: AudioNode[] = [];
  private ambTimer: ReturnType<typeof setTimeout> | null = null;
  private voices = 0;
  private lastClick = 0;

  muted = store.get('muted') === '1';
  volume = (() => {
    const v = Number(store.get('volume'));
    return Number.isFinite(v) && store.get('volume') !== null ? Math.min(1, Math.max(0, v)) : 0.8;
  })();
  ambience = store.get('ambience') !== '0';

  /** Browsers only allow audio after a user gesture: call from one. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch {
      return;
    }
    this.ctx = ctx;
    // master: volume → a limiter so a 16-ball break never clips
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
    this.out = ctx.createGain();
    this.out.connect(limiter).connect(ctx.destination);
    this.applyVolume();
    // effects bus, dry plus a send to the room's echo
    this.sfx = ctx.createGain();
    this.sfx.connect(this.out);
    this.reverb = ctx.createConvolver();
    this.wet = ctx.createGain();
    this.sfx.connect(this.reverb).connect(this.wet).connect(this.out);
    this.amb = ctx.createGain();
    this.amb.connect(this.out);
    this.build();
    this.startRolling();
    this.applyTheme();
  }

  // ---------------------------------------------------------------- settings

  setMuted(m: boolean): void {
    this.muted = m;
    store.set('muted', m ? '1' : '0');
    this.applyVolume();
  }

  setVolume(v: number): void {
    this.volume = Math.min(1, Math.max(0, v));
    store.set('volume', String(this.volume));
    this.applyVolume();
  }

  setAmbience(on: boolean): void {
    this.ambience = on;
    store.set('ambience', on ? '1' : '0');
    this.applyTheme();
  }

  /** The room (and so the echo, the pockets and the ambience). */
  setTheme(t: RoomTheme): void {
    if (t === this.theme && this.ctx) return;
    this.theme = t;
    this.applyTheme();
  }

  private applyVolume(): void {
    if (!this.out || !this.ctx) return;
    // perceived loudness is roughly logarithmic: square the slider
    this.out.gain.setTargetAtTime(this.muted ? 0 : this.volume * this.volume * 0.9, this.ctx.currentTime, 0.03);
  }

  private get pocketKind(): Pocket {
    return this.theme === 'club' ? 'net' : 'return';
  }

  // ---------------------------------------------------------------- buffers

  private render(seconds: number, fill: (t: number, i: number) => number, stereo = false): AudioBuffer {
    const ctx = this.ctx!;
    const n = Math.max(1, Math.floor(ctx.sampleRate * seconds));
    const b = ctx.createBuffer(stereo ? 2 : 1, n, ctx.sampleRate);
    for (let ch = 0; ch < b.numberOfChannels; ch++) {
      const d = b.getChannelData(ch);
      let peak = 0;
      for (let i = 0; i < n; i++) {
        d[i] = fill(i / ctx.sampleRate, i + ch * 7919);
        peak = Math.max(peak, Math.abs(d[i]));
      }
      if (peak > 0) for (let i = 0; i < n; i++) d[i] /= peak;
    }
    return b;
  }

  /** A sum of damped sinusoids plus an optional noise transient. */
  private modal(seconds: number, modes: Mode[], crack: number, crackTau: number, seed: number, lowpass = 0): AudioBuffer {
    const rnd = noiseGen(seed);
    let lp = 0;
    const phases = modes.map(() => (rnd() + 1) * Math.PI);
    return this.render(seconds, (t) => {
      let v = 0;
      for (let k = 0; k < modes.length; k++) {
        const m = modes[k];
        v += m.a * Math.exp(-t / m.tau) * Math.sin(2 * Math.PI * m.f * t + phases[k]);
      }
      let n = rnd() * crack * Math.exp(-t / crackTau);
      if (lowpass > 0) {
        lp += lowpass * (n - lp);
        n = lp;
      }
      // a 1 ms fade-in so nothing clicks digitally
      return (v + n) * Math.min(1, t / 0.001);
    });
  }

  private build(): void {
    const vary = (base: number, seed: number, spread = 0.04) => base * (1 + noiseGen(seed)() * spread);
    // Ball on ball: a phenolic resin ball's first few modes (~3–8 kHz), short, plus the crack.
    this.buf.click = Array.from({ length: 8 }, (_, i) =>
      this.modal(
        0.09,
        [
          { f: vary(3050, i * 3 + 1), tau: 0.016, a: 1 },
          { f: vary(4820, i * 3 + 2), tau: 0.009, a: 0.6 },
          { f: vary(7350, i * 3 + 3), tau: 0.005, a: 0.35 },
          { f: vary(1480, i * 3 + 4), tau: 0.006, a: 0.25 },
        ],
        0.9,
        0.0012,
        100 + i,
      ),
    );
    // Cushion: the rubber and wooden rail, a dull thump with a soft knock on top.
    this.buf.cushion = Array.from({ length: 4 }, (_, i) =>
      this.modal(
        0.22,
        [
          { f: vary(118, i + 20, 0.08), tau: 0.045, a: 1 },
          { f: vary(245, i + 30, 0.08), tau: 0.025, a: 0.55 },
          { f: vary(690, i + 40, 0.1), tau: 0.008, a: 0.25 },
        ],
        0.7,
        0.01,
        200 + i,
        0.08,
      ),
    );
    // Cue tip: leather on resin, a woody knock and the cue ball's own ring.
    this.buf.tip = Array.from({ length: 3 }, (_, i) =>
      this.modal(
        0.1,
        [
          { f: vary(880, i + 50, 0.06), tau: 0.012, a: 0.8 },
          { f: vary(2950, i + 60), tau: 0.012, a: 0.55 },
          { f: vary(4700, i + 70), tau: 0.006, a: 0.25 },
          { f: vary(420, i + 80, 0.06), tau: 0.02, a: 0.45 },
        ],
        0.8,
        0.0018,
        300 + i,
      ),
    );
    // Into the pocket: a ball dropping onto leather.
    this.buf.drop = Array.from({ length: 3 }, (_, i) =>
      this.modal(
        0.35,
        [
          { f: vary(86, i + 90, 0.1), tau: 0.07, a: 1 },
          { f: vary(190, i + 95, 0.1), tau: 0.04, a: 0.5 },
        ],
        0.8,
        0.02,
        400 + i,
        0.15,
      ),
    );
    // A snooker net settling, and a ball knocking along a return channel.
    this.buf.net = [this.render(0.5, (t, i) => noiseGen(500 + i)() * Math.exp(-t / 0.12) * 0.5 * Math.sin(Math.PI * Math.min(1, t / 0.02)))];
    this.buf.knock = Array.from({ length: 3 }, (_, i) =>
      this.modal(0.12, [
        { f: vary(320, i + 110, 0.1), tau: 0.02, a: 1 },
        { f: vary(1650, i + 120, 0.1), tau: 0.006, a: 0.4 },
      ], 0.4, 0.004, 600 + i, 0.2),
    );
    // Long noise for the cloth rumble and the ambience (stereo, loops).
    const rn = noiseGen(777);
    let b1 = 0;
    this.buf.noise = [
      this.render(
        2,
        () => {
          // pinkish: a leaky integrator over white noise
          b1 = 0.985 * b1 + 0.15 * rn();
          return b1;
        },
        true,
      ),
    ];
    // Applause: a few seconds of many hands, each clap a short burst of noise added straight
    // into the buffer (one pass per clap, not per sample)
    this.buf.applause = [this.applauseBuffer()];
  }

  private applauseBuffer(): AudioBuffer {
    const ctx = this.ctx!;
    const sr = ctx.sampleRate;
    const len = 3.3;
    const b = ctx.createBuffer(2, Math.floor(sr * len), sr);
    const cr = noiseGen(888);
    const an = noiseGen(999);
    const clapLen = Math.floor(sr * 0.02);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let t = 0.02 * ch; t < 3.1; t += 0.003 + Math.abs(cr()) * 0.011) {
        const env = Math.min(1, t / 0.4) * Math.min(1, (3.1 - t) / 1.3);
        const amp = env * (0.4 + 0.6 * Math.abs(cr()));
        const start = Math.floor(t * sr);
        // each clap: a bright burst, a little lowpassed so it isn't hiss
        let lp = 0;
        for (let i = 0; i < clapLen && start + i < d.length; i++) {
          lp += 0.55 * (an() - lp);
          d[start + i] += amp * lp * Math.exp(-i / (sr * 0.0035));
        }
      }
      let peak = 0;
      for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
      if (peak > 0) for (let i = 0; i < d.length; i++) d[i] /= peak;
    }
    return b;
  }

  // ---------------------------------------------------------------- playback

  private voice(buffer: AudioBuffer, gain: number, opts: { rate?: number; pan?: number; lowpass?: number; when?: number; dest?: AudioNode } = {}): void {
    const ctx = this.ctx;
    if (!ctx || this.muted || gain <= 0.001) return;
    if (this.voices > 28) return; // a big break: enough is enough
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = opts.rate ?? 1;
    let node: AudioNode = src;
    if (opts.lowpass) {
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = opts.lowpass;
      node = node.connect(f);
    }
    const g = ctx.createGain();
    g.gain.value = gain;
    node = node.connect(g);
    if (opts.pan !== undefined && ctx.createStereoPanner) {
      const p = ctx.createStereoPanner();
      p.pan.value = Math.max(-0.85, Math.min(0.85, opts.pan));
      node = node.connect(p);
    }
    node.connect(opts.dest ?? this.sfx!);
    this.voices++;
    src.onended = () => this.voices--;
    src.start(ctx.currentTime + (opts.when ?? 0));
  }

  private pick(name: string): AudioBuffer {
    const list = this.buf[name];
    return list[Math.floor(Math.random() * list.length)];
  }

  /** The cue strikes the cue ball. */
  cue(power: number, pan = 0): void {
    if (!this.ctx) return;
    const p = Math.max(0, Math.min(1, power));
    this.voice(this.pick('tip'), 0.18 + p * 0.7, { pan, lowpass: 2500 + p * 9000, rate: 0.96 + Math.random() * 0.08 });
  }

  /** Something happened on the table; `pan` −1 (left) … 1 (right) from where it is on screen. */
  event(e: SimEvent, pan = 0): void {
    if (!this.ctx) return;
    const v = Math.min(1, e.speed / 5);
    if (v < 0.004) return;
    if (e.type === 'ball') {
      const now = this.ctx.currentTime;
      if (now - this.lastClick < 0.004) return;
      this.lastClick = now;
      // harder → louder and brighter (more of the high modes get through)
      this.voice(this.pick('click'), 0.08 + Math.pow(v, 0.7) * 0.9, { pan, lowpass: 1800 + v * 12000, rate: 0.95 + Math.random() * 0.1 });
    } else if (e.type === 'cushion') {
      this.voice(this.pick('cushion'), 0.06 + Math.pow(v, 0.8) * 0.7, { pan, lowpass: 600 + v * 3000, rate: 0.92 + Math.random() * 0.16 });
    } else {
      this.pocket(v, pan);
    }
  }

  private pocket(v: number, pan: number): void {
    this.voice(this.pick('drop'), 0.35 + v * 0.45, { pan, lowpass: 1600 });
    if (this.pocketKind === 'net') {
      this.voice(this.buf.net[0], 0.18, { pan, lowpass: 3500, when: 0.03 });
      return;
    }
    // a pool table's ball return: knocks down the channel, then into the tray with the others
    let t = 0.18;
    for (let k = 0; k < 5; k++) {
      t += 0.12 + k * 0.05;
      this.voice(this.pick('knock'), 0.16 * (1 - k * 0.12), { pan: pan * (1 - k * 0.2), lowpass: 2200, when: t, rate: 0.9 + Math.random() * 0.2 });
    }
    this.voice(this.pick('click'), 0.28, { pan: pan * 0.3, lowpass: 5000, when: t + 0.35, rate: 0.8 });
  }

  /** How much is rolling (sum of ball speeds, m/s): drives the cloth rumble. */
  setRolling(level: number): void {
    if (!this.ctx || !this.rollGain || !this.rollFilter) return;
    const v = Math.min(1, level / 6);
    this.rollGain.gain.setTargetAtTime(this.muted ? 0 : Math.pow(v, 0.8) * 0.22, this.ctx.currentTime, 0.05);
    this.rollFilter.frequency.setTargetAtTime(180 + v * 520, this.ctx.currentTime, 0.08);
  }

  /** Polite applause (snooker), 0…1. */
  applause(intensity = 0.6): void {
    if (!this.ctx) return;
    this.voice(this.buf.applause[0], 0.15 + intensity * 0.35, { lowpass: 6500, dest: this.amb ?? undefined });
  }

  private startRolling(): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.buf.noise[0];
    src.loop = true;
    this.rollFilter = ctx.createBiquadFilter();
    this.rollFilter.type = 'bandpass';
    this.rollFilter.Q.value = 0.8;
    this.rollGain = ctx.createGain();
    this.rollGain.gain.value = 0;
    src.connect(this.rollFilter).connect(this.rollGain).connect(this.sfx!);
    src.start();
  }

  // ---------------------------------------------------------------- the room

  private applyTheme(): void {
    const ctx = this.ctx;
    if (!ctx || !this.reverb || !this.wet || !this.amb) return;
    // the echo: a stereo impulse of decaying noise, longer for bigger, harder rooms
    const decay = this.theme === 'club' ? 0.55 : this.theme === 'pub' ? 0.85 : 1.3;
    const rn = noiseGen(this.theme.length * 31);
    this.reverb.buffer = this.render(decay * 2.2, (t) => rn() * Math.exp(-t / (decay / 3)) * (t < 0.008 ? t / 0.008 : 1), true);
    this.wet.gain.value = this.theme === 'club' ? 0.12 : this.theme === 'pub' ? 0.2 : 0.26;
    this.stopAmbience();
    if (this.ambience) this.startAmbience();
  }

  private stopAmbience(): void {
    for (const n of this.ambNodes) {
      try {
        (n as AudioScheduledSourceNode).stop?.();
      } catch {
        /* not started */
      }
      n.disconnect();
    }
    this.ambNodes = [];
    if (this.ambTimer) clearTimeout(this.ambTimer);
    this.ambTimer = null;
  }

  private loopNoise(gain: number, type: BiquadFilterType, freq: number, q = 0.7): GainNode {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.buf.noise[0];
    src.loop = true;
    src.loopStart = Math.random();
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(this.amb!);
    src.start(0, Math.random() * 1.5);
    this.ambNodes.push(src, f, g);
    return g;
  }

  private startAmbience(): void {
    const ctx = this.ctx!;
    // room tone everywhere: a low, quiet air
    this.loopNoise(0.05, 'lowpass', 160);
    if (this.theme === 'pub') {
      // a murmur of voices: a few bands of noise breathing in and out at speech rates
      for (const [f, g] of [
        [420, 0.035],
        [780, 0.025],
        [1250, 0.014],
      ] as const) {
        const band = this.loopNoise(g, 'bandpass', f, 1.4);
        const lfo = ctx.createOscillator();
        const depth = ctx.createGain();
        lfo.frequency.value = 0.6 + Math.random() * 1.6;
        depth.gain.value = g * 0.7;
        lfo.connect(depth).connect(band.gain);
        lfo.start();
        this.ambNodes.push(lfo, depth);
      }
    }
    if (this.theme === 'hall') {
      // the neon's hum
      for (const [f, g] of [
        [100, 0.012],
        [200, 0.005],
      ] as const) {
        const o = ctx.createOscillator();
        o.frequency.value = f;
        const og = ctx.createGain();
        og.gain.value = g;
        o.connect(og).connect(this.amb!);
        o.start();
        this.ambNodes.push(o, og);
      }
      this.loopNoise(0.012, 'bandpass', 650, 1.2);
    }
    // now and then: a shot at another table, or (in the pub) a glass
    const tick = () => {
      if (!this.ctx || !this.ambience) return;
      const pan = Math.random() * 1.6 - 0.8;
      if (this.theme === 'pub' && Math.random() < 0.45) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = 2600 + Math.random() * 2400;
        g.gain.setValueAtTime(0.03, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.35);
        const p = ctx.createStereoPanner();
        p.pan.value = pan;
        o.connect(g).connect(p).connect(this.amb!);
        o.start();
        o.stop(ctx.currentTime + 0.4);
      } else {
        // a distant break-off or pot: two or three far-away clicks
        const n = 1 + Math.floor(Math.random() * 3);
        for (let k = 0; k < n; k++) this.voice(this.pick('click'), 0.035 + Math.random() * 0.03, { pan, lowpass: 2600, when: k * (0.05 + Math.random() * 0.25), dest: this.amb!, rate: 0.9 });
      }
      this.ambTimer = setTimeout(tick, 3500 + Math.random() * 9000);
    };
    this.ambTimer = setTimeout(tick, 2000 + Math.random() * 4000);
  }
}

export const sound = new Sound();
