// Cue Club: the menu, the online room (lobby and knockout bracket), and handing each match to
// the table screen. The 3D table behind the menu is the same view the game plays on.

import './style.css';
import { TableView } from './render/view.ts';
import { TableScreen, type SeatKind } from './play/table-screen.ts';
import { newMatch, VARIANTS, VARIANT_IDS, type Match } from './sim/game.ts';
import { Rng } from './sim/rng.ts';
import type { AiLevel } from './sim/ai.ts';
import type { VariantId } from './sim/rules/types.ts';
import { Connection } from './net/client.ts';
import { GUIDE_SETTINGS, MAX_PLAYERS, type GuideSetting, type RoomView, type ServerMsg } from './net/protocol.ts';
import { roundName } from './net/tournament.ts';
import { el, esc, session, store } from './ui/dom.ts';
import { CUEINGS, type Cueing } from './play/stroke.ts';
import { sound } from './audio.ts';

const stage = document.getElementById('stage')!;
const ui = document.getElementById('ui')!;
const view = new TableView(stage);

type Mode = 'ai' | 'local' | 'online';
const GUIDE_NAMES: Record<GuideSetting, string> = { full: 'Full', short: 'Short', off: 'Off' };
const prefs = {
  variant: (store.get('variant') as VariantId) ?? 'uk8',
  mode: (store.get('mode') as Mode) ?? 'ai',
  level: (store.get('level') as AiLevel) ?? 'medium',
  raceTo: Number(store.get('raceTo') ?? 1),
  name: store.get('name') ?? '',
  name2: store.get('name2') ?? '',
  cueing: (CUEINGS as string[]).includes(store.get('cueing') ?? '') ? (store.get('cueing') as Cueing) : 'casual',
};
const CUEING_NAMES: Record<Cueing, string> = { casual: 'Casual', club: 'Club', pro: 'Pro' };
const CUEING_BLURB: Record<Cueing, string> = {
  casual: 'Pick a power and the ball goes exactly where you aimed.',
  club: 'Pull back to your power, then push through straight: drift or snatch and it goes off line.',
  pro: 'No meter: the speed of your push is the power. Straightness counts.',
};
const save = () => {
  for (const [k, v] of Object.entries(prefs)) store.set(k, String(v));
};

let screen: TableScreen | null = null;
let panel: HTMLElement | null = null;

function showBackdrop(variant: VariantId): void {
  const rules = VARIANTS[variant];
  view.setVariant(rules);
  view.setBalls(rules.rack(new Rng(7)));
  view.aim = null;
  view.placing = null;
  view.mode = 'orbit';
}

function setPanel(p: HTMLElement | null): void {
  panel?.remove();
  panel = p;
  if (p) ui.appendChild(p);
}

// ------------------------------------------------------------------ home

const LEVELS: [AiLevel, string][] = [
  ['easy', 'Easy'],
  ['medium', 'Medium'],
  ['hard', 'Hard'],
  ['pro', 'Pro'],
];

function home(): void {
  online?.close();
  online = null;
  document.querySelector('.room-badge')?.remove();
  screen?.dispose();
  screen = null;
  showBackdrop(prefs.variant);
  const roomFromUrl = new URLSearchParams(location.search).get('room');
  if (roomFromUrl) prefs.mode = 'online';
  const p = el(`
    <div class="menu">
      <header>
        <h1>Cue <span>Club</span></h1>
        <p class="sub">Pool &amp; snooker · one table, four games</p>
      </header>
      <section class="games">
        ${VARIANT_IDS.map((v) => `<button class="game" data-v="${v}"><b>${VARIANTS[v].name}</b><small>${esc(VARIANTS[v].blurb)}</small></button>`).join('')}
      </section>
      <nav class="modes">
        <button data-m="ai">1 Player</button>
        <button data-m="local">2 Players</button>
        <button data-m="online">Online</button>
      </nav>
      <section class="mode-body"></section>
      <details class="how">
        <summary>How to play</summary>
        <ul>
          <li><b>Aim:</b> drag left/right on the table (up/down tilts the view). In the overhead view, drag to point the cue. Arrow keys work too; hold Shift for fine aim.</li>
          <li><b>Shoot:</b> drag the power bar down to pull the cue back and let go. Or ↑/↓ to set power, Space to shoot.</li>
          <li><b>Spin:</b> click the cue ball (bottom left) where you want to hit it: low for screw, high for follow, sides for side. W A S D too.</li>
          <li><b>Ball in hand:</b> drag the cue ball to place it, then aim.</li>
          <li><b>V</b> (or the View button) switches camera: behind the cue, <b>sight</b> (looking down the cue, the way you'd aim without a guide), and overhead. Tap during a shot to speed it up.</li>
        </ul>
      </details>
    </div>`);
  const body = p.querySelector('.mode-body') as HTMLElement;
  const games = p.querySelectorAll<HTMLButtonElement>('.game');
  const modes = p.querySelectorAll<HTMLButtonElement>('.modes button');
  const render = () => {
    games.forEach((b) => b.classList.toggle('on', b.dataset.v === prefs.variant));
    modes.forEach((b) => b.classList.toggle('on', b.dataset.m === prefs.mode));
    const cueing = `<label>Cueing <span class="seg cue">${CUEINGS.map((c) => `<button data-c="${c}" class="${prefs.cueing === c ? 'on' : ''}">${CUEING_NAMES[c]}</button>`).join('')}</span><small class="muted">${CUEING_BLURB[prefs.cueing]}</small></label>`;
    const race = `<label>Frames <span class="seg race">${[1, 2, 3, 5].map((n) => `<button data-r="${n}" class="${prefs.raceTo === n ? 'on' : ''}">${n === 1 ? 'Single' : `First to ${n}`}</button>`).join('')}</span></label>`;
    if (prefs.mode === 'ai') {
      body.innerHTML = `
        <label>Your name <input class="n1" maxlength="18" placeholder="You" value="${esc(prefs.name)}"></label>
        <label>Computer <span class="seg lvl">${LEVELS.map(([k, n]) => `<button data-l="${k}" class="${prefs.level === k ? 'on' : ''}">${n}</button>`).join('')}</span></label>
        ${cueing}
        ${race}
        <button class="go primary">Play</button>`;
    } else if (prefs.mode === 'local') {
      body.innerHTML = `
        <label>Player 1 <input class="n1" maxlength="18" placeholder="Player 1" value="${esc(prefs.name)}"></label>
        <label>Player 2 <input class="n2" maxlength="18" placeholder="Player 2" value="${esc(prefs.name2)}"></label>
        ${cueing}
        ${race}
        <button class="go primary">Play</button>`;
    } else {
      body.innerHTML = `
        <label>Your name <input class="n1" maxlength="18" placeholder="Your name" value="${esc(prefs.name)}"></label>
        <div class="online-row">
          <button class="create primary">Create a room</button>
          <span class="or">or</span>
          <input class="code" maxlength="4" placeholder="CODE" value="${esc(roomFromUrl ?? '')}" autocapitalize="characters">
          <button class="join">Join</button>
        </div>
        <p class="muted">Two players play a match. Three to ${MAX_PLAYERS} play a knockout tournament: the room picks the game.</p>
        <p class="err"></p>`;
    }
    body.querySelectorAll<HTMLButtonElement>('.race button').forEach((b) =>
      b.addEventListener('click', () => {
        prefs.raceTo = Number(b.dataset.r);
        save();
        render();
      }),
    );
    body.querySelectorAll<HTMLButtonElement>('.cue button').forEach((b) =>
      b.addEventListener('click', () => {
        prefs.cueing = b.dataset.c as Cueing;
        save();
        render();
      }),
    );
    body.querySelectorAll<HTMLButtonElement>('.lvl button').forEach((b) =>
      b.addEventListener('click', () => {
        prefs.level = b.dataset.l as AiLevel;
        save();
        render();
      }),
    );
    const n1 = body.querySelector<HTMLInputElement>('.n1');
    const n2 = body.querySelector<HTMLInputElement>('.n2');
    n1?.addEventListener('input', () => ((prefs.name = n1.value.trim()), save()));
    n2?.addEventListener('input', () => ((prefs.name2 = n2.value.trim()), save()));
    body.querySelector('.go')?.addEventListener('click', () => {
      sound.unlock();
      if (prefs.mode === 'ai') playLocal(['human', 'ai'], [prefs.name || 'You', `Computer (${LEVELS.find((l) => l[0] === prefs.level)![1]})`]);
      else playLocal(['human', 'human'], [prefs.name || 'Player 1', prefs.name2 || 'Player 2']);
    });
    const code = body.querySelector<HTMLInputElement>('.code');
    const err = body.querySelector('.err') as HTMLElement | null;
    body.querySelector('.create')?.addEventListener('click', () => {
      sound.unlock();
      goOnline(err!, { create: true });
    });
    body.querySelector('.join')?.addEventListener('click', () => {
      sound.unlock();
      const c = code!.value.trim().toUpperCase();
      if (c.length !== 4) return void (err!.textContent = 'Room codes are four letters');
      goOnline(err!, { code: c });
    });
    code?.addEventListener('keydown', (e) => e.key === 'Enter' && body.querySelector<HTMLButtonElement>('.join')!.click());
  };
  games.forEach((b) =>
    b.addEventListener('click', () => {
      prefs.variant = b.dataset.v as VariantId;
      save();
      showBackdrop(prefs.variant);
      render();
    }),
  );
  modes.forEach((b) =>
    b.addEventListener('click', () => {
      prefs.mode = b.dataset.m as Mode;
      save();
      render();
    }),
  );
  render();
  setPanel(p);
}

// ------------------------------------------------------------------ local play

function playLocal(seats: [SeatKind, SeatKind], names: [string, string]): void {
  setPanel(null);
  screen?.dispose();
  const match = newMatch({ variant: prefs.variant, raceTo: prefs.raceTo, names, seed: (Math.random() * 2 ** 32) >>> 0 });
  screen = new TableScreen({
    view,
    root: ui,
    match,
    seats,
    aiLevel: prefs.level,
    cueing: prefs.cueing,
    onExit: () => home(),
    onRematch: () => playLocal(seats, names),
  });
}

// ------------------------------------------------------------------ online

interface OnlineState {
  conn: Connection;
  you: string;
  room: RoomView | null;
  matches: Map<string, { seats: [string, string]; match: Match }>;
  /** The match on screen, if any. */
  showing: string | null;
  /** Matches the player has finished looking at (don't reopen them). */
  seen: Set<string>;
  close(): void;
}
let online: OnlineState | null = null;

function goOnline(err: HTMLElement, how: { create?: boolean; code?: string; resume?: boolean }): void {
  const name = prefs.name || 'Player';
  err.textContent = '';
  const state: OnlineState = {
    conn: null as unknown as Connection,
    you: '',
    room: null,
    matches: new Map(),
    showing: null,
    seen: new Set(),
    close() {
      this.conn.send({ t: 'leave' });
      this.conn.close();
    },
  };
  online = state;
  let status: 'connecting' | 'open' | 'lost' = 'connecting';
  state.conn = new Connection(
    (m) => onServer(state, m, err),
    (s) => {
      status = s;
      document.body.classList.toggle('offline', s === 'lost');
    },
  );
  if (how.resume) {
    // the Connection rejoins with the saved seat token by itself
    (state as any).name = state.conn.seat?.name ?? name;
    return;
  }
  // a fresh create/join replaces any old seat in this tab
  state.conn.remember(null);
  const guide = (GUIDE_SETTINGS as string[]).includes(store.get('guide') ?? '') ? (store.get('guide') as GuideSetting) : 'full';
  if (how.create) state.conn.send({ t: 'create', name, settings: { variant: prefs.variant, raceTo: prefs.raceTo, guide, cueing: prefs.cueing } });
  else state.conn.send({ t: 'join', code: how.code!, name });
  (state as any).name = name;
  void status;
}

function onServer(s: OnlineState, m: ServerMsg, err: HTMLElement): void {
  if (online !== s) return;
  switch (m.t) {
    case 'welcome':
      s.you = m.you;
      s.conn.remember({ code: m.code, token: m.token, name: (s as any).name ?? prefs.name });
      history.replaceState(null, '', `?room=${m.code}`);
      return;
    case 'error':
      if (!s.room) {
        err.textContent = m.msg;
        s.conn.close();
        online = null;
      } else toast(m.msg);
      return;
    case 'room':
      s.room = m.room;
      if (!screen) lobby(s);
      else refreshRoomBadge(s);
      return;
    case 'match': {
      const known = s.matches.get(m.mid);
      s.matches.set(m.mid, { seats: m.seats, match: m.match });
      if (s.showing === m.mid && screen) screen.setMatch(m.match);
      else if (!known && m.seats.includes(s.you) && m.match.winner === null && !showingMine(s)) watch(s, m.mid);
      else if (!screen) lobby(s);
      return;
    }
    case 'shot': {
      const lm = s.matches.get(m.mid);
      if (lm) lm.match = m.match;
      if (s.showing === m.mid && screen) screen.applyShot(m.shot, m.match);
      return;
    }
    case 'aim':
      if (s.showing === m.mid && screen) screen.remoteAiming(m.aim);
      return;
  }
}

/** On one of our own matches (finished or not: we leave it with Continue, not automatically). */
function showingMine(s: OnlineState): boolean {
  const lm = s.showing ? s.matches.get(s.showing) : undefined;
  return !!lm && lm.seats.includes(s.you);
}

function watch(s: OnlineState, mid: string): void {
  const lm = s.matches.get(mid);
  if (!lm || !s.room) return;
  setPanel(null);
  screen?.dispose();
  s.showing = mid;
  const mine = lm.seats.indexOf(s.you);
  const seats: [SeatKind, SeatKind] = [mine === 0 ? 'human' : 'remote', mine === 1 ? 'human' : 'remote'];
  const b = s.room.bracket;
  const round = b ? b.rounds.findIndex((r) => r.some((x) => x.id === mid)) : 0;
  const title = b && b.rounds.length > 1 ? `${roundName(b, round)}${mine < 0 ? ' · watching' : ''}` : mine < 0 ? 'Watching' : undefined;
  screen = new TableScreen({
    view,
    root: ui,
    match: lm.match,
    seats,
    title,
    guide: s.room.settings.guide,
    cueing: s.room.settings.cueing,
    online: {
      shot: (shot, n) => s.conn.send({ t: 'shot', mid, n, shot }),
      aim: (aim) => s.conn.send({ t: 'aim', mid, aim }),
      concede: () => s.conn.send({ t: 'concede', mid }),
    },
    onExit: () => {
      s.seen.add(mid);
      s.showing = null;
      screen?.dispose();
      screen = null;
      lobby(s);
    },
  });
  refreshRoomBadge(s);
}

/** The lobby before the start, the bracket after it. */
function lobby(s: OnlineState): void {
  const r = s.room;
  if (!r) return;
  document.querySelector('.room-badge')?.remove();
  showBackdrop(r.settings.variant);
  // a match of ours waiting to be played: go straight to it
  for (const [mid, lm] of s.matches) {
    if (lm.seats.includes(s.you) && lm.match.winner === null && !s.seen.has(mid)) return watch(s, mid);
  }
  const host = r.host === s.you;
  const name = (id: string | null, bye = false) => (id ? esc(r.members.find((m) => m.id === id)?.name ?? '?') : bye ? '<i>bye</i>' : '<i>to be decided</i>');
  const link = `${location.origin}${location.pathname}?room=${r.code}`;
  const members = r.members
    .map((m) => `<li class="${m.connected ? '' : 'away'}">${esc(m.name)}${m.id === r.host ? ' <span class="tag">host</span>' : ''}${m.id === s.you ? ' <span class="tag you">you</span>' : ''}</li>`)
    .join('');
  let body = '';
  if (r.phase === 'lobby') {
    const n = r.members.length;
    const settings = host
      ? `<label>Game <select class="s-var">${VARIANT_IDS.map((v) => `<option value="${v}" ${v === r.settings.variant ? 'selected' : ''}>${VARIANTS[v].name}</option>`).join('')}</select></label>
         <label>Frames <select class="s-race">${[1, 2, 3, 5].map((k) => `<option value="${k}" ${k === r.settings.raceTo ? 'selected' : ''}>${k === 1 ? 'Single frame' : `First to ${k}`}</option>`).join('')}</select></label>
         <label>Aim guide for everyone <select class="s-guide">${GUIDE_SETTINGS.map((g) => `<option value="${g}" ${g === r.settings.guide ? 'selected' : ''}>${GUIDE_NAMES[g]}</option>`).join('')}</select></label>
         <label>Cueing for everyone <select class="s-cue">${CUEINGS.map((c) => `<option value="${c}" ${c === r.settings.cueing ? 'selected' : ''}>${CUEING_NAMES[c]}: ${CUEING_BLURB[c]}</option>`).join('')}</select></label>`
      : `<p>${VARIANTS[r.settings.variant].name} · ${r.settings.raceTo === 1 ? 'single frame' : `first to ${r.settings.raceTo} frames`} · aim guide: ${GUIDE_NAMES[r.settings.guide].toLowerCase()} · cueing: ${CUEING_NAMES[r.settings.cueing].toLowerCase()}</p>`;
    body = `
      <div class="code-big">${r.code}</div>
      <p class="muted">Share the code, or the link: <button class="copy linkish">${esc(link)}</button></p>
      <h3>Players (${n}/${MAX_PLAYERS})</h3><ul class="members">${members}</ul>
      ${settings}
      ${host ? `<button class="start primary" ${n < 2 ? 'disabled' : ''}>${n < 2 ? 'Waiting for players…' : n === 2 ? 'Start the match' : `Start the tournament (${n} players)`}</button>` : '<p class="muted">Waiting for the host to start…</p>'}`;
  } else {
    const b = r.bracket!;
    const live = (id: string) => s.matches.get(id);
    const cols = b.rounds
      .map(
        (round, ri) => `<div class="round"><h4>${roundName(b, ri)}</h4><div class="round-matches">${round
          .map((bm) => {
            const lm = live(bm.id);
            const score = lm && r.settings.raceTo > 1 ? lm.match.wins : null;
            const going = lm && lm.match.winner === null;
            const seat = (i: 0 | 1) => `<div class="seat ${bm.winner && bm.winner === bm.seats[i] ? 'won' : ''} ${bm.seats[i] === s.you ? 'me' : ''}">${name(bm.seats[i], bm.bye)}${score ? `<b>${score[i]}</b>` : ''}</div>`;
            return `<div class="bm ${going ? 'live' : ''} ${bm.bye ? 'bye' : ''}">${seat(0)}${seat(1)}${going ? `<button class="watch" data-mid="${bm.id}">${lm!.seats.includes(s.you) ? 'Play' : 'Watch'}</button>` : ''}</div>`;
          })
          .join('')}</div></div>`,
      )
      .join('');
    const champ = r.champion ? `<div class="champ">🏆 ${name(r.champion)} ${b.rounds.length > 1 ? 'wins the tournament' : 'wins'}!</div>` : '';
    body = `
      <p class="muted">Room ${r.code} · ${VARIANTS[r.settings.variant].name}${r.settings.raceTo > 1 ? ` · first to ${r.settings.raceTo}` : ''} · aim guide: ${GUIDE_NAMES[r.settings.guide].toLowerCase()}</p>
      ${champ}
      <div class="bracket">${cols}</div>
      ${r.phase === 'done' && host ? '<button class="again primary">New tournament with this room</button>' : ''}`;
  }
  const p = el(`<div class="menu lobby"><header><h1>Cue <span>Club</span></h1></header>${body}<button class="leave">Leave room</button></div>`);
  p.querySelector('.s-var')?.addEventListener('change', (e) => s.conn.send({ t: 'settings', settings: { ...r.settings, variant: (e.target as HTMLSelectElement).value as VariantId } }));
  p.querySelector('.s-race')?.addEventListener('change', (e) => s.conn.send({ t: 'settings', settings: { ...r.settings, raceTo: Number((e.target as HTMLSelectElement).value) } }));
  p.querySelector('.s-cue')?.addEventListener('change', (e) => s.conn.send({ t: 'settings', settings: { ...r.settings, cueing: (e.target as HTMLSelectElement).value as Cueing } }));
  p.querySelector('.s-guide')?.addEventListener('change', (e) => s.conn.send({ t: 'settings', settings: { ...r.settings, guide: (e.target as HTMLSelectElement).value as GuideSetting } }));
  p.querySelector('.start')?.addEventListener('click', () => s.conn.send({ t: 'start' }));
  p.querySelector('.again')?.addEventListener('click', () => {
    s.matches.clear();
    s.seen.clear();
    s.conn.send({ t: 'again' });
  });
  p.querySelector('.copy')?.addEventListener('click', () => {
    void navigator.clipboard?.writeText(link).then(() => toast('Link copied'));
  });
  p.querySelectorAll<HTMLButtonElement>('.watch').forEach((b) => b.addEventListener('click', () => watch(s, b.dataset.mid!)));
  p.querySelector('.leave')!.addEventListener('click', () => {
    s.close();
    online = null;
    history.replaceState(null, '', location.pathname);
    home();
  });
  setPanel(p);
}

/** In a match, a small corner button back to the room (for tournaments: the bracket). */
function refreshRoomBadge(s: OnlineState): void {
  document.querySelector('.room-badge')?.remove();
  if (!screen || !s.room) return;
  const b = el(`<button class="room-badge">Room ${s.room.code}${s.room.bracket && s.room.bracket.rounds.length > 1 ? ' · bracket' : ''}</button>`);
  b.addEventListener('click', () => {
    if (s.showing) s.seen.add(s.showing);
    s.showing = null;
    screen?.dispose();
    screen = null;
    b.remove();
    lobby(s);
  });
  ui.appendChild(b);
}

function toast(text: string): void {
  const t = el(`<div class="toast">${esc(text)}</div>`);
  ui.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

// back in a room after a reload (same tab): rejoin our seat
const resumeSeat = (() => {
  try {
    return JSON.parse(session.get('seat') ?? 'null') as { code: string } | null;
  } catch {
    return null;
  }
})();
home();
if (resumeSeat && new URLSearchParams(location.search).get('room') === resumeSeat.code) {
  goOnline(document.querySelector('.menu .err') ?? el('<p></p>'), { resume: true });
}

// for browser tests: what's on the table
(window as any).__cue = { match: () => screen?.match ?? null, room: () => online?.room ?? null, view };
