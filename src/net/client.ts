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

export class Connection {
  private ws: WebSocket | null = null;
  private outbox: ClientMsg[] = [];
  private retry = 0;
  private closed = false;
  private pinger: ReturnType<typeof setInterval> | null = null;
  seat: Seat | null = null;
  private onMessage: (m: ServerMsg) => void;
  private onStatus: (s: 'connecting' | 'open' | 'lost') => void;

  constructor(onMessage: (m: ServerMsg) => void, onStatus: (s: 'connecting' | 'open' | 'lost') => void) {
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
      this.pinger = setInterval(() => this.send({ t: 'ping' }), 25_000);
    };
    ws.onmessage = (e) => {
      let m: ServerMsg;
      try {
        m = JSON.parse(e.data);
      } catch {
        return;
      }
      this.onMessage(m);
    };
    ws.onclose = () => {
      if (this.pinger) clearInterval(this.pinger);
      if (this.closed) return;
      this.onStatus('lost');
      const wait = Math.min(8000, 500 * 2 ** this.retry++);
      setTimeout(() => !this.closed && this.open(), wait);
    };
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
