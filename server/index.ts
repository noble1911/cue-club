// Cue Club server: serves the built game (dist/) and runs online rooms.
//
//   PORT=3000 node server/index.ts         (npm run server / npm start; Node ≥ 24 runs TypeScript)
//
// The server is the referee. It imports the same simulation and rules as the browsers
// (src/sim/), checks that a shot comes from the player whose turn it is, plays it, and broadcasts
// the shot with the match after it. Rooms hold up to 8 players: two play a match, three or more a
// knockout (src/net/tournament.ts), with every table broadcast to everyone so anyone can watch.
//
// Served under a path by the games gateway (games.noblehaus.uk/cue-club/, prefix stripped), so
// everything here is relative: the page at /, the socket at /ws.

import { createServer, type Server } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { checkShot, cleanShot, concede, newMatch, nextFrame, takeShot, VARIANT_IDS, type Match } from '../src/sim/game.ts';
import { Rng } from '../src/sim/rng.ts';
import { GUIDE_SETTINGS, MAX_PLAYERS, shotNumber, type ClientMsg, type RoomSettings, type RoomView, type ServerMsg } from '../src/net/protocol.ts';
import { CUEINGS } from '../src/play/stroke.ts';
import { champion, makeBracket, playable, recordWinner, type Bracket } from '../src/net/tournament.ts';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', process.env.DIST ?? 'dist');
/** A player who drops out of a match has this long to come back before they forfeit it. */
const GRACE_MS = Number(process.env.GRACE_MS ?? 60_000);
/** Pause after a frame ends before the next one is racked (the browsers show the result). */
const FRAME_PAUSE_MS = Number(process.env.FRAME_PAUSE_MS ?? 6_000);
const ROOM_TTL_MS = 20 * 60_000;
/** Public-server limits: rooms in all, sockets per client address, messages per socket. */
const MAX_ROOMS = Number(process.env.MAX_ROOMS ?? 300);
const MAX_SOCKETS_PER_IP = Number(process.env.MAX_SOCKETS_PER_IP ?? 40);
const MSG_BURST = 60;
const MSG_PER_SEC = 30;
/** Aim updates relayed at most this often per player (the client sends ~14 a second). */
const AIM_MIN_MS = 40;

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.glb': 'model/gltf-binary',
};

interface Member {
  id: string;
  name: string;
  token: string;
  ws: WebSocket | null;
  goneAt: number;
  lastAim: number;
  /** Left for good (or timed out): forfeits whatever they're in. */
  dropped: boolean;
}

interface LiveMatch {
  id: string;
  seats: [string, string];
  match: Match;
  timer: NodeJS.Timeout | null;
}

interface Room {
  code: string;
  host: string;
  settings: RoomSettings;
  members: Member[];
  phase: 'lobby' | 'playing' | 'done';
  bracket: Bracket | null;
  live: Map<string, LiveMatch>;
  emptySince: number;
}

const rooms = new Map<string, Room>();
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function newCode(): string {
  for (;;) {
    let c = '';
    for (const b of randomBytes(4)) c += CODE_CHARS[b % CODE_CHARS.length];
    if (!rooms.has(c)) return c;
  }
}

const id = () => randomBytes(6).toString('hex');
const send = (ws: WebSocket | null, msg: ServerMsg) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
};
const broadcast = (room: Room, msg: ServerMsg) => {
  const s = JSON.stringify(msg);
  for (const m of room.members) if (m.ws && m.ws.readyState === 1) m.ws.send(s);
};

function cleanName(n: unknown): string {
  const s = String(n ?? '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 18);
  return s || 'Player';
}

function cleanSettings(s: any): RoomSettings {
  const variant = VARIANT_IDS.includes(s?.variant) ? s.variant : 'uk8';
  const raceTo = Math.min(5, Math.max(1, Math.floor(Number(s?.raceTo) || 1)));
  const guide = GUIDE_SETTINGS.includes(s?.guide) ? s.guide : 'full';
  const cueing = CUEINGS.includes(s?.cueing) ? s.cueing : 'casual';
  return { variant, raceTo, guide, cueing };
}

function view(room: Room): RoomView {
  return {
    code: room.code,
    host: room.host,
    settings: room.settings,
    members: room.members.filter((m) => !m.dropped || room.phase !== 'lobby').map((m) => ({ id: m.id, name: m.name, connected: !!m.ws && !m.dropped })),
    phase: room.phase,
    bracket: room.bracket,
    champion: room.bracket ? champion(room.bracket) : null,
  };
}

const pushRoom = (room: Room) => broadcast(room, { t: 'room', room: view(room) });
const nameOf = (room: Room, pid: string) => room.members.find((m) => m.id === pid)?.name ?? '?';
const sendMatch = (room: Room, lm: LiveMatch, to?: WebSocket | null) => {
  const msg: ServerMsg = { t: 'match', mid: lm.id, seats: lm.seats, match: lm.match };
  if (to !== undefined) send(to, msg);
  else broadcast(room, msg);
};

// ------------------------------------------------------------------ matches & the bracket

/** Start every match whose players are known; walk over anyone who has left. */
function startReady(room: Room): void {
  const b = room.bracket!;
  for (;;) {
    let changed = false;
    for (const bm of playable(b)) {
      if (room.live.has(bm.id)) continue;
      const [a, c] = bm.seats as [string, string];
      const aGone = room.members.find((m) => m.id === a)?.dropped;
      const cGone = room.members.find((m) => m.id === c)?.dropped;
      if (aGone || cGone) {
        recordWinner(b, bm.id, aGone && !cGone ? c : a);
        changed = true;
        continue;
      }
      const seed = randomBytes(4).readUInt32LE(0);
      const lm: LiveMatch = {
        id: bm.id,
        seats: [a, c],
        match: newMatch({ variant: room.settings.variant, raceTo: room.settings.raceTo, names: [nameOf(room, a), nameOf(room, c)], seed }),
        timer: null,
      };
      room.live.set(bm.id, lm);
      sendMatch(room, lm);
    }
    if (!changed) break;
  }
  if (champion(b)) room.phase = 'done';
  pushRoom(room);
}

function finishMatch(room: Room, lm: LiveMatch): void {
  if (lm.timer) clearTimeout(lm.timer);
  lm.timer = null;
  const w = lm.match.winner;
  if (w === null) return;
  recordWinner(room.bracket!, lm.id, lm.seats[w]);
  startReady(room);
}

/** After a shot (or a concession): rack the next frame after a pause, or close the match. */
function afterChange(room: Room, lm: LiveMatch): void {
  if (lm.match.winner !== null) return finishMatch(room, lm);
  if (lm.match.frame.over && !lm.timer) {
    lm.timer = setTimeout(() => {
      lm.timer = null;
      if (!room.live.has(lm.id)) return;
      lm.match = nextFrame(lm.match);
      sendMatch(room, lm);
    }, FRAME_PAUSE_MS);
  }
}

function forfeit(room: Room, pid: string): void {
  for (const lm of room.live.values()) {
    if (lm.match.winner !== null) continue;
    const seat = lm.seats.indexOf(pid);
    if (seat < 0) continue;
    lm.match = concede(lm.match, seat as 0 | 1, true);
    sendMatch(room, lm);
    finishMatch(room, lm);
  }
  if (room.bracket) startReady(room);
}

// ------------------------------------------------------------------ messages

interface Conn {
  room: Room | null;
  member: Member | null;
}

function handle(ws: WebSocket, c: Conn, msg: ClientMsg): void {
  const err = (text: string) => send(ws, { t: 'error', msg: text });
  switch (msg.t) {
    case 'ping':
      return send(ws, { t: 'pong' });
    case 'create': {
      if (rooms.size >= MAX_ROOMS) return err('The club is full right now: try again in a few minutes');
      // a new room means leaving any other one for good (no ghost seat left holding it open)
      leave(c, true);
      const member: Member = { id: id(), name: cleanName(msg.name), token: id() + id(), ws, goneAt: 0, dropped: false, lastAim: 0 };
      const room: Room = { code: newCode(), host: member.id, settings: cleanSettings(msg.settings), members: [member], phase: 'lobby', bracket: null, live: new Map(), emptySince: 0 };
      rooms.set(room.code, room);
      c.room = room;
      c.member = member;
      send(ws, { t: 'welcome', you: member.id, token: member.token, code: room.code });
      return pushRoom(room);
    }
    case 'join': {
      const room = rooms.get(String(msg.code ?? '').toUpperCase().trim());
      if (!room) return err('No room with that code');
      // coming back to a seat (reload, lost connection)
      const back = msg.token ? room.members.find((m) => m.token === msg.token && !m.dropped) : undefined;
      if (back) {
        // the seat moves to this socket; the old one is told why, so it doesn't fight back
        if (back.ws && back.ws !== ws) back.ws.close(4000, 'replaced');
        if (c.member !== back) leave(c, true);
        back.ws = ws;
        back.goneAt = 0;
        c.room = room;
        c.member = back;
        claimHost(room, back);
        send(ws, { t: 'welcome', you: back.id, token: back.token, code: room.code });
        pushRoom(room);
        for (const lm of room.live.values()) sendMatch(room, lm, ws);
        return;
      }
      if (room.phase !== 'lobby') return err('That room has already started');
      if (room.members.filter((m) => !m.dropped).length >= MAX_PLAYERS) return err('That room is full');
      leave(c, true);
      const member: Member = { id: id(), name: cleanName(msg.name), token: id() + id(), ws, goneAt: 0, dropped: false, lastAim: 0 };
      room.members.push(member);
      c.room = room;
      c.member = member;
      claimHost(room, member);
      send(ws, { t: 'welcome', you: member.id, token: member.token, code: room.code });
      return pushRoom(room);
    }
    case 'settings': {
      const { room, member } = c;
      if (!room || !member || room.host !== member.id || room.phase !== 'lobby') return;
      room.settings = cleanSettings(msg.settings);
      return pushRoom(room);
    }
    case 'start': {
      const { room, member } = c;
      if (!room || !member || room.host !== member.id || room.phase !== 'lobby') return;
      const players = room.members.filter((m) => !m.dropped);
      if (players.length < 2) return err('Waiting for at least one more player');
      room.members = players;
      room.bracket = makeBracket(players.map((m) => m.id), new Rng(randomBytes(4).readUInt32LE(0)));
      room.phase = 'playing';
      return startReady(room);
    }
    case 'again': {
      const { room, member } = c;
      if (!room || !member || room.host !== member.id || room.phase === 'lobby') return;
      for (const lm of room.live.values()) if (lm.timer) clearTimeout(lm.timer);
      room.live.clear();
      room.bracket = null;
      room.phase = 'lobby';
      room.members = room.members.filter((m) => !m.dropped);
      return pushRoom(room);
    }
    case 'aim': {
      const { room, member } = c;
      const lm = room?.live.get(msg.mid);
      if (!room || !member || !lm || lm.seats[lm.match.frame.turn] !== member.id) return;
      const now = Date.now();
      if (now - member.lastAim < AIM_MIN_MS) return;
      member.lastAim = now;
      const a = msg.aim;
      if (!a || ![a.dx, a.dy, a.power, a.side, a.height].every(Number.isFinite)) return;
      const aim = { dx: a.dx, dy: a.dy, power: a.power, side: a.side, height: a.height, ...(a.place && Number.isFinite(a.place.x) && Number.isFinite(a.place.y) ? { place: { x: a.place.x, y: a.place.y } } : {}) };
      const s = JSON.stringify({ t: 'aim', mid: lm.id, aim } satisfies ServerMsg);
      for (const m of room.members) if (m !== member && m.ws && m.ws.readyState === 1) m.ws.send(s);
      return;
    }
    case 'shot': {
      const { room, member } = c;
      const lm = room?.live.get(msg.mid);
      if (!room || !member || !lm) return err('No such match');
      // out of step (a repeat, a frame that just ended, someone else's turn): send the truth back
      // so the client stops waiting on an answer that will never come
      if (lm.match.winner !== null || lm.match.frame.over || msg.n !== shotNumber(lm.match)) return sendMatch(room, lm, ws);
      if (lm.seats[lm.match.frame.turn] !== member.id) {
        sendMatch(room, lm, ws);
        return err('Not your turn');
      }
      const raw = msg.shot;
      if (!raw || typeof raw !== 'object') return err('Bad shot');
      const problem = checkShot(lm.match, raw);
      if (problem) return err(problem);
      const shot = cleanShot(raw);
      lm.match = takeShot(lm.match, shot).match;
      broadcast(room, { t: 'shot', mid: lm.id, shot, match: lm.match });
      return afterChange(room, lm);
    }
    case 'concede': {
      const { room, member } = c;
      const lm = room?.live.get(msg.mid);
      if (!room || !member || !lm || lm.match.winner !== null) return;
      const seat = lm.seats.indexOf(member.id);
      if (seat < 0 || lm.match.frame.over) return;
      lm.match = concede(lm.match, seat as 0 | 1);
      sendMatch(room, lm);
      return afterChange(room, lm);
    }
    case 'leave':
      return leave(c, true);
  }
}

/** The connection goes away; `forGood` when the player chose to leave. */
function leave(c: Conn, forGood = false): void {
  const { room, member } = c;
  c.room = null;
  c.member = null;
  if (!room || !member) return;
  member.ws = null;
  member.goneAt = Date.now();
  if (forGood) drop(room, member);
  else pushRoom(room);
}

/** A room whose host has gone (left, or timed out while alone) passes to whoever turns up. */
function claimHost(room: Room, member: Member): void {
  const host = room.members.find((m) => m.id === room.host);
  if (!host || host.dropped) room.host = member.id;
}

/** The member is gone for good: out of the lobby, or forfeiting what they're playing. */
function drop(room: Room, member: Member): void {
  member.dropped = true;
  member.ws = null;
  if (room.phase === 'lobby') room.members = room.members.filter((m) => m !== member);
  if (room.host === member.id) {
    const next = room.members.find((m) => !m.dropped && m.ws) ?? room.members.find((m) => !m.dropped);
    if (next) room.host = next.id;
  }
  if (room.phase === 'playing') forfeit(room, member.id);
  pushRoom(room);
}

// ------------------------------------------------------------------ housekeeping

function sweep(): void {
  const now = Date.now();
  for (const room of rooms.values()) {
    for (const m of room.members.slice()) {
      if (!m.ws && !m.dropped && m.goneAt && now - m.goneAt > GRACE_MS) drop(room, m);
    }
    const anyone = room.members.some((m) => m.ws);
    if (anyone) room.emptySince = 0;
    else if (!room.emptySince) room.emptySince = now;
    else if (now - room.emptySince > ROOM_TTL_MS) {
      for (const lm of room.live.values()) if (lm.timer) clearTimeout(lm.timer);
      rooms.delete(room.code);
    }
  }
}

// ------------------------------------------------------------------ http + ws

async function serveFile(rawUrl: string, res: import('node:http').ServerResponse): Promise<void> {
  let url: URL;
  let p: string;
  try {
    url = new URL(rawUrl, 'http://x');
    p = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain' });
    return void res.end('bad request');
  }
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return void res.end(`ok ${rooms.size} rooms`);
  }
  if (p.endsWith('/')) p += 'index.html';
  const file = join(ROOT, normalize(p));
  // inside dist/ itself (a bare prefix check would also let in a sibling like dist-old/)
  if (!file.startsWith(ROOT + sep)) {
    res.writeHead(403);
    return void res.end();
  }
  try {
    if (!(await stat(file)).isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return void res.end('not found');
  }
  const ext = extname(file);
  const body = await readFile(file);
  res.writeHead(200, {
    'Content-Type': TYPES[ext] ?? 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : p.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'public, max-age=3600',
  });
  res.end(body);
}

export function startServer(port: number): Promise<Server> {
  const http = createServer((req, res) => {
    // Anything thrown while handling a request answers that request, never takes the server down
    // (a bad URL used to: decodeURIComponent threw outside any catch).
    serveFile(req.url ?? '/', res).catch((e) => {
      console.error('request failed', req.url, e);
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 16 * 1024 });
  // A socket error (an oversized or malformed frame, a reset) with no listener is thrown, and a
  // throw there exits the process: every room gone. Listen, log, and let the socket close.
  wss.on('error', (e) => console.error('websocket server error', e));
  const perIp = new Map<string, number>();
  wss.on('connection', (ws, req) => {
    ws.on('error', (e) => console.warn('socket error', e.message));
    // behind Cloudflare and the gateway every socket comes from the gateway: use the client's
    // address as forwarded
    const ip = String(req.headers['cf-connecting-ip'] ?? String(req.headers['x-forwarded-for'] ?? '').split(',')[0] ?? '').trim() || req.socket.remoteAddress || '?';
    const count = (perIp.get(ip) ?? 0) + 1;
    perIp.set(ip, count);
    ws.on('close', () => {
      const n = (perIp.get(ip) ?? 1) - 1;
      if (n <= 0) perIp.delete(ip);
      else perIp.set(ip, n);
    });
    if (count > MAX_SOCKETS_PER_IP) return ws.close(1013, 'too many connections');
    // a message budget per socket: bursts are fine, floods are dropped (and a flooder cut off)
    let tokens = MSG_BURST;
    let refilled = Date.now();
    let dropped = 0;
    const c: Conn = { room: null, member: null };
    let alive = true;
    ws.on('pong', () => (alive = true));
    const beat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 20_000);
    ws.on('message', (data) => {
      const now = Date.now();
      tokens = Math.min(MSG_BURST, tokens + ((now - refilled) / 1000) * MSG_PER_SEC);
      refilled = now;
      if (tokens < 1) {
        if (++dropped > 300) ws.close(1008, 'too many messages');
        return;
      }
      tokens -= 1;
      let msg: ClientMsg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      try {
        handle(ws, c, msg);
      } catch (e) {
        console.error('message failed', msg?.t, e);
      }
    });
    ws.on('close', () => {
      clearInterval(beat);
      if (c.member?.ws === ws) leave(c);
    });
  });
  const timer = setInterval(sweep, 5_000);
  http.on('close', () => {
    clearInterval(timer);
    wss.close();
  });
  return new Promise((res) => http.listen(port, () => res(http)));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  // last resort: log and carry on rather than drop every room over one bad input
  process.on('uncaughtException', (e) => console.error('uncaught', e));
  process.on('unhandledRejection', (e) => console.error('unhandled rejection', e));
  const port = Number(process.env.PORT ?? 3000);
  startServer(port).then(() => console.log(`cue-club on :${port}`));
}
