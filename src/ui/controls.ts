// The controls: which keys do what (arrows or WASD for aiming, the player's choice), and the
// list of controls shown in the game and on the menu, written for the device in hand (mouse or
// touch) and the cueing level being played.

import type { Cueing } from '../play/stroke.ts';
import { esc, store } from './dom.ts';

export type KeyLayout = 'arrows' | 'wasd';

export interface Binds {
  aimLeft: string;
  aimRight: string;
  powerUp: string;
  powerDown: string;
  spinUp: string;
  spinDown: string;
  spinLeft: string;
  spinRight: string;
}

export function keyLayout(): KeyLayout {
  return store.get('keys') === 'wasd' ? 'wasd' : 'arrows';
}

export function setKeyLayout(l: KeyLayout): void {
  store.set('keys', l);
}

const ARROWS = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' };
const WASD = { up: 'w', down: 's', left: 'a', right: 'd' };

/** Arrows layout: arrows aim and set power, WASD spin. WASD layout: the other way round. */
export function binds(l: KeyLayout = keyLayout()): Binds {
  const move = l === 'wasd' ? WASD : ARROWS;
  const spin = l === 'wasd' ? ARROWS : WASD;
  return {
    aimLeft: move.left,
    aimRight: move.right,
    powerUp: move.up,
    powerDown: move.down,
    spinUp: spin.up,
    spinDown: spin.down,
    spinLeft: spin.left,
    spinRight: spin.right,
  };
}

/** e.key, with letters lower-cased (Shift+A is still A). */
export function normKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

const LABEL: Record<string, string> = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', ' ': 'Space', Escape: 'Esc', Shift: 'Shift' };
const k = (key: string) => `<kbd>${esc(LABEL[key] ?? key.toUpperCase())}</kbd>`;

export function hasMouse(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(pointer: fine)').matches;
}

/** Rows of [what, how] for the controls list. */
export function controlRows(cueing: Cueing, mouse = hasMouse(), l: KeyLayout = keyLayout()): [string, string][] {
  const b = binds(l);
  const rows: [string, string][] = [];
  if (mouse) {
    rows.push(['Aim', `Right-drag on the table (up/down tilts the view) · ${k(b.aimLeft)} ${k(b.aimRight)} · hold ${k('Shift')} for fine`]);
    if (cueing === 'casual') rows.push(['Shoot', `Hold the left button, pull the mouse back, let go · or ${k(b.powerUp)} ${k(b.powerDown)} for power, ${k(' ')} to shoot`]);
    else if (cueing === 'club')
      rows.push(['Shoot', `Hold the left button, pull back to your power, push forward straight through the ball · or ${k(b.powerUp)} ${k(b.powerDown)} to set the mark, ${k(' ')} to start the meter, ${k(' ')} again on the mark`]);
    else rows.push(['Shoot', `Hold the left button, pull back, push forward: the faster the push, the harder the hit · or ${k(' ')} to start the meter, ${k(' ')} again to strike`]);
  } else {
    rows.push(['Aim', 'Drag on the table (up/down tilts the view) · the <b>Fine</b> wheel on the left nudges it']);
    if (cueing === 'casual') rows.push(['Shoot', 'Pull the power bar down and let go']);
    else if (cueing === 'club') rows.push(['Shoot', 'Pull the power bar down to your power, then push it back up smoothly and straight']);
    else rows.push(['Shoot', 'Pull the power bar down, then push it up: the faster the push, the harder the hit']);
  }
  rows.push(['Spin', `Tap the cue ball (bottom left) where to strike it${mouse ? ` · ${k(b.spinUp)} ${k(b.spinLeft)} ${k(b.spinDown)} ${k(b.spinRight)}` : ''}`]);
  rows.push(['Zoom', mouse ? `Hold ${k('z')} to zoom in on the contact point · mouse wheel: cue view closer or further` : 'Hold the 🔍 Zoom button']);
  rows.push(['Camera', `${mouse ? `${k('v')} or the` : 'The'} View button: behind the cue → sight (down the cue) → overhead`]);
  rows.push(['Ball in hand', mouse ? 'Left-drag the cue ball to place it' : 'Drag the cue ball to place it']);
  rows.push(['During a shot', mouse ? `Click or ${k(' ')} to speed it up` : 'Tap to speed it up']);
  if (mouse) rows.push(['Menu / help', `${k('Escape')} menu · ${k('h')} this list`]);
  return rows;
}

export function controlsTable(cueing: Cueing, mouse = hasMouse(), l: KeyLayout = keyLayout()): string {
  return `<table class="ctl">${controlRows(cueing, mouse, l)
    .map(([what, how]) => `<tr><th>${what}</th><td>${how}</td></tr>`)
    .join('')}</table>`;
}

/** The Arrows / WASD switch (keyboard players only). */
export function layoutSwitch(l: KeyLayout = keyLayout()): string {
  return `<div class="layout-switch">Aim &amp; power keys <span class="seg">${(['arrows', 'wasd'] as const)
    .map((x) => `<button data-layout="${x}" class="${x === l ? 'on' : ''}">${x === 'arrows' ? 'Arrows (spin on WASD)' : 'WASD (spin on arrows)'}</button>`)
    .join('')}</span></div>`;
}
