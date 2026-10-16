// Sounds, synthesised with WebAudio (no files): the click of ball on ball, the thud of a
// cushion, a ball dropping into a pocket and the cue's tap. Loudness follows the impact speed.

import type { SimEvent } from './sim/physics.ts';

const KEY = 'cue-club.muted';

class Sound {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private noise: AudioBuffer | null = null;
  private lastClick = 0;
  muted = (() => {
    try {
      return localStorage.getItem(KEY) === '1';
    } catch {
      return false;
    }
  })();

  /** Browsers only allow audio after a user gesture: call from one. */
  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      this.ctx = new AudioContext();
    } catch {
      return;
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.7;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate * 0.5;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  setMuted(m: boolean): void {
    this.muted = m;
    try {
      localStorage.setItem(KEY, m ? '1' : '0');
    } catch {
      /* private mode */
    }
    if (this.master) this.master.gain.value = m ? 0 : 0.7;
  }

  private tone(freq: number, dur: number, vol: number, type: OscillatorType = 'sine', bend = 1): void {
    const ctx = this.ctx!;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, ctx.currentTime);
    o.frequency.exponentialRampToValueAtTime(freq * bend, ctx.currentTime + dur);
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    o.connect(g).connect(this.master!);
    o.start();
    o.stop(ctx.currentTime + dur + 0.02);
  }

  private burst(dur: number, vol: number, filter: BiquadFilterType, freq: number, q = 1): void {
    const ctx = this.ctx!;
    const s = ctx.createBufferSource();
    s.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = filter;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(vol, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + dur);
    s.connect(f).connect(g).connect(this.master!);
    s.start();
    s.stop(ctx.currentTime + dur + 0.02);
  }

  cue(power: number): void {
    if (!this.ctx || this.muted) return;
    this.burst(0.05, 0.25 + power * 0.5, 'bandpass', 1800, 2);
    this.tone(420, 0.06, 0.15 + power * 0.2, 'triangle', 0.6);
  }

  event(e: SimEvent): void {
    if (!this.ctx || this.muted) return;
    const v = Math.min(1, e.speed / 4);
    if (v < 0.01) return;
    if (e.type === 'ball') {
      // a big break is dozens of clicks at once: thin them out
      const now = this.ctx.currentTime;
      if (now - this.lastClick < 0.012) return;
      this.lastClick = now;
      this.tone(2600 + Math.random() * 900, 0.035, 0.12 + v * 0.55, 'sine', 0.85);
      this.burst(0.02, 0.1 + v * 0.35, 'highpass', 3000);
    } else if (e.type === 'cushion') {
      this.burst(0.09, 0.08 + v * 0.45, 'lowpass', 380, 0.8);
      this.tone(110, 0.08, 0.08 + v * 0.25, 'sine', 0.7);
    } else {
      this.burst(0.12, 0.15 + v * 0.3, 'lowpass', 700);
      this.tone(160, 0.22, 0.25, 'sine', 0.5);
      setTimeout(() => this.ctx && this.tone(240, 0.12, 0.12, 'triangle', 0.6), 110);
    }
  }
}

export const sound = new Sound();
