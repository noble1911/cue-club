// Messages between the browsers and the server (JSON over one WebSocket at ./ws).
//
// A room holds 2–8 players. The host picks the game and starts: two players play one match,
// three or more play a knockout. Every match in the room is broadcast to every member, so anyone
// can watch any table. The server referees: a shot is the cue's direction, power and spin, the
// server runs the same simulation as the browsers and sends back the shot and the match after it.
// The browsers animate the shot from their copy of the match and land on exactly that state.

import type { Match } from '../sim/game.ts';
import type { Shot } from '../sim/physics.ts';
import type { VariantId } from '../sim/rules/types.ts';
import type { Bracket } from './tournament.ts';
import type { Cueing } from '../play/stroke.ts';

/** How much of the aim line players see. */
export type GuideSetting = 'full' | 'short' | 'off';
export const GUIDE_SETTINGS: GuideSetting[] = ['full', 'short', 'off'];

export interface RoomSettings {
  variant: VariantId;
  /** First to this many frames wins each match. */
  raceTo: number;
  /** The aim guide everyone in the room plays with (the host decides). */
  guide: GuideSetting;
  /** How everyone strikes the ball: casual, club or pro (the host decides). */
  cueing: Cueing;
}

export interface MemberView {
  id: string;
  name: string;
  connected: boolean;
}

export interface RoomView {
  code: string;
  host: string;
  settings: RoomSettings;
  members: MemberView[];
  phase: 'lobby' | 'playing' | 'done';
  bracket: Bracket | null;
  champion: string | null;
}

/** What a player is lining up, relayed so everyone sees the cue move. */
export interface Aim {
  dx: number;
  dy: number;
  power: number;
  side: number;
  height: number;
  /** The cue ball while it's being placed. */
  place?: { x: number; y: number };
}

export type ClientMsg =
  | { t: 'create'; name: string; settings: RoomSettings }
  | { t: 'join'; code: string; name: string; token?: string }
  | { t: 'settings'; settings: RoomSettings }
  | { t: 'start' }
  | { t: 'aim'; mid: string; aim: Aim }
  | { t: 'shot'; mid: string; n: number; shot: Shot }
  | { t: 'concede'; mid: string }
  | { t: 'again' }
  | { t: 'leave' }
  | { t: 'ping' };

export type ServerMsg =
  | { t: 'welcome'; you: string; token: string; code: string }
  | { t: 'room'; room: RoomView }
  | { t: 'match'; mid: string; seats: [string, string]; match: Match }
  | { t: 'shot'; mid: string; shot: Shot; match: Match }
  | { t: 'aim'; mid: string; aim: Aim }
  | { t: 'error'; msg: string }
  | { t: 'pong' };

/** A shot's sequence number within a match: stops a double-click playing the same shot twice. */
export function shotNumber(m: Match): number {
  return m.frameNo * 10000 + m.frame.shots;
}

export const MAX_PLAYERS = 8;
