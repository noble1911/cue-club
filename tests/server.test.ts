import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { Server } from 'node:http';
import { startServer } from '../server/index.ts';
import { shotNumber, type ClientMsg, type ServerMsg } from '../src/net/protocol.ts';
import { canPlace, type Match } from '../src/sim/game.ts';

let server: Server;
let url: string;
beforeAll(async () => {
  process.env.FRAME_PAUSE_MS = '50';
  server = await startServer(0);
  url = `ws://127.0.0.1:${(server.address() as any).port}/ws`;
});
afterAll(() => new Promise<void>((r) => {
  server.closeAllConnections();
  server.close(() => r());
}));

class Client {
  ws: WebSocket;
  inbox: ServerMsg[] = [];
  waiters: { pred: (m: ServerMsg) => boolean; res: (m: ServerMsg) => void }[] = [];
  you = '';
  constructor() {
    this.ws = new WebSocket(url);
    this.ws.on('message', (d) => {
      const m = JSON.parse(String(d)) as ServerMsg;
      if (m.t === 'welcome') this.you = m.you;
      const w = this.waiters.find((x) => x.pred(m));
      if (w) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.res(m);
      } else this.inbox.push(m);
    });
  }
  open() {
    return new Promise((r) => this.ws.once('open', r));
  }
  send(m: ClientMsg) {
    this.ws.send(JSON.stringify(m));
  }
  wait<T extends ServerMsg['t']>(t: T, pred: (m: Extract<ServerMsg, { t: T }>) => boolean = () => true): Promise<Extract<ServerMsg, { t: T }>> {
    const i = this.inbox.findIndex((m) => m.t === t && pred(m as any));
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0] as any);
    return new Promise((res) => this.waiters.push({ pred: (m) => m.t === t && pred(m as any), res: res as any }));
  }
}

async function room(n: number) {
  const host = new Client();
  await host.open();
  host.send({ t: 'create', name: 'Host', settings: { variant: 'nine', raceTo: 1, guide: 'short', cueing: 'club' } });
  const { code } = await host.wait('welcome');
  const others: Client[] = [];
  for (let i = 1; i < n; i++) {
    const c = new Client();
    await c.open();
    c.send({ t: 'join', code, name: `P${i}`, token: undefined });
    await c.wait('welcome');
    others.push(c);
  }
  const r = await host.wait('room', (m) => m.room.members.length === n);
  expect(r.room.settings.guide).toBe('short'); // the host's choice reaches everyone
  return { host, others, code, all: [host, ...others] };
}

function anyPlace(m: Match) {
  for (let x = -1.2; x < 1.2; x += 0.05) for (let y = -0.5; y < 0.5; y += 0.05) if (canPlace(m, x, y)) return { x, y };
  throw new Error('nowhere to place');
}

describe('server', () => {
  it('only the host changes the aim guide, and junk falls back to full', async () => {
    const { host, others, all } = await room(2);
    others[0].send({ t: 'settings', settings: { variant: 'nine', raceTo: 1, guide: 'off', cueing: 'club' } });
    host.send({ t: 'settings', settings: { variant: 'nine', raceTo: 1, guide: 'off', cueing: 'club' } });
    expect((await others[0].wait('room', (m) => m.room.settings.guide === 'off')).room.settings.guide).toBe('off');
    host.send({ t: 'settings', settings: { variant: 'nine', raceTo: 1, guide: 'cheat' as any, cueing: 'cheat' as any } });
    const fixed = (await others[0].wait('room', (m) => m.room.settings.guide === 'full')).room.settings;
    expect(fixed.guide).toBe('full');
    expect(fixed.cueing).toBe('casual');
    for (const c of all) c.ws.close();
  });

  it('two players: the server referees a shot and both see it', async () => {
    const { host, others } = await room(2);
    host.send({ t: 'start' });
    const start = await host.wait('match');
    await others[0].wait('match');
    const m = start.match;
    const shooterId = start.seats[m.frame.turn];
    const shooter = shooterId === host.you ? host : others[0];
    const watcher = shooter === host ? others[0] : host;
    // wrong player can't shoot
    watcher.send({ t: 'shot', mid: start.mid, n: shotNumber(m), shot: { dx: 1, dy: 0, power: 0.9, side: 0, height: 0, place: anyPlace(m) } });
    expect((await watcher.wait('error')).msg).toMatch(/turn/);
    shooter.send({ t: 'shot', mid: start.mid, n: shotNumber(m), shot: { dx: 1, dy: 0.0005, power: 0.95, side: 0, height: 0, place: anyPlace(m) } });
    const a = await shooter.wait('shot');
    const b = await watcher.wait('shot');
    expect(a.match.frame.shots).toBe(1);
    expect(JSON.stringify(a.match)).toBe(JSON.stringify(b.match));
    // the same shot again (double click) is ignored: no second result arrives
    shooter.send({ t: 'shot', mid: start.mid, n: shotNumber(m), shot: { dx: 1, dy: 0, power: 0.9, side: 0, height: 0, place: anyPlace(m) } });
    await new Promise((r) => setTimeout(r, 150));
    expect(shooter.inbox.filter((x) => x.t === 'shot')).toHaveLength(0);
    for (const c of [host, ...others]) c.ws.close();
  });

  it('three players: a knockout, concessions move the winner on to a champion', async () => {
    const { host, all } = await room(3);
    host.send({ t: 'start' });
    const first = await host.wait('room', (m) => m.room.phase === 'playing');
    expect(first.room.bracket!.rounds).toHaveLength(2);
    // play: whoever is seated in a live match concedes as player 0 until a champion is named
    const byId = new Map(all.map((c) => [c.you, c]));
    let done: ServerMsg | null = null;
    for (let guard = 0; guard < 10 && !done; guard++) {
      const mm = await host.wait('match', (m) => m.match.winner === null);
      const loser = byId.get(mm.seats[0])!;
      loser.send({ t: 'concede', mid: mm.mid });
      const r = await host.wait('room', (m) => m.room.phase === 'done' || !!m.room.bracket?.rounds.flat().find((x) => x.id === mm.mid)?.winner);
      if (r.room.phase === 'done') done = r;
    }
    expect(done && done.t === 'room' && done.room.champion).toBeTruthy();
    for (const c of all) c.ws.close();
  });

  it('a reload reclaims the seat with the token', async () => {
    const host = new Client();
    await host.open();
    host.send({ t: 'create', name: 'Ann', settings: { variant: 'uk8', raceTo: 1, guide: 'full', cueing: 'casual' } });
    const w = await host.wait('welcome');
    host.ws.close();
    const again = new Client();
    await again.open();
    again.send({ t: 'join', code: w.code, name: 'Ann', token: w.token });
    const w2 = await again.wait('welcome');
    expect(w2.you).toBe(w.you);
    const r = await again.wait('room');
    expect(r.room.host).toBe(w.you);
    again.ws.close();
  });
});
