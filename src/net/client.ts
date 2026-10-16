// The browser's end of the socket. Reconnects by itself and, if we were in a room, rejoins it
// with our seat token, so a dropped connection or a reload carries on where it left off.

import type { ClientMsg, ServerMsg } from './protocol.ts';
import { session } from '../ui/dom.ts';

/** The socket sits next to the page (games.noblehaus.uk/cue-club/ws), never at the site root. */
export function socketURL(): string {
  const u = new URL('ws', location.href);
  u.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  u.search = '';
  u.hash = '';
  return u.toString();
}

export interface Seat {
  code: string;
  token: string;
  name: string;
}

/** `replaced`: this seat was opened in another tab, which now has it (no reconnecting). */
export type Status = 'connecting' | 'open' | 'lost' | 'replaced';

export class Connection {
  private ws: WebSocket | null = null;
  private outbox: ClientMsg[] = [];
  private retry = 0;
  private closed = false;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private heard = 0;
  seat: Seat | null = null;
  private onMessage: (m: ServerMsg) => void;
  private onStatus: (s: Status) => void;

  constructor(onMessage: (m: ServerMsg) => void, onStatus: (s: Status) => void) {
    this.onMessage = onMessage;
    this.onStatus = onStatus;
    try {
      const saved = session.get('seat');
      if (saved) this.seat = JSON.parse(saved);
    } catch {
      this.seat = null;
    }
    this.open();
  }

  private open(): void {
    this.onStatus('connecting');
    const ws = new WebSocket(socketURL());
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.onStatus('open');
      if (this.seat) ws.send(JSON.stringify({ t: 'join', code: this.seat.code, name: this.seat.name, token: this.seat.token } satisfies ClientMsg));
      for (const m of this.outbox.splice(0)) ws.send(JSON.stringify(m));
      this.heard = Date.now();
      // Ping every 10 s; the server answers. A phone that moved networks can keep a dead socket
      // that never reports closing: after 25 s of silence give up on it and connect afresh.
      this.pinger = setInterval(() => {
        if (Date.now() - this.heard > 25_000) return this.abandon(ws);
        this.send({ t: 'ping' });
      }, 10_000);
    };
    ws.onmessage = (e) => {
      this.heard = Date.now();
      let m: ServerMsg;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      this.onMessage(m);
    };
    ws.onclose = (e) => {
      if (this.pinger) clearInterval(this.pinger);
      if (this.closed || this.ws !== ws) return;
      if (e.code === 4000) {
        this.closed = true;
        return this.onStatus('replaced');
      }
      this.onStatus('lost');
      const wait = Math.min(8000, 500 * 2 ** this.retry++);
      setTimeout(() => !this.closed && this.open(), wait);
    };
  }

  /** Drop a silent socket without waiting for it to close, and reconnect. */
  private abandon(ws: WebSocket): void {
    if (this.pinger) clearInterval(this.pinger);
    ws.onclose = ws.onmessage = ws.onopen = null;
    try {
      ws.close();
    } catch {
      /* already gone */
    }
    if (this.closed) return;
    this.onStatus('lost');
    this.open();
  }

  remember(seat: Seat | null): void {
    this.seat = seat;
    session.set('seat', seat ? JSON.stringify(seat) : null);
  }

  send(m: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
    else if (m.t !== 'aim' && m.t !== 'ping') this.outbox.push(m);
  }

  close(): void {
    this.closed = true;
    this.remember(null);
    this.ws?.close();
  }
}
