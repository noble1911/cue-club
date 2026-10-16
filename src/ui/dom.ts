// Small DOM helpers and per-browser storage (every key prefixed `cue-club.`: the games site
// shares one origin between all its games).

export function el<T extends HTMLElement = HTMLElement>(html: string): T {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as T;
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const PREFIX = 'cue-club.';

function storage(kind: 'local' | 'session') {
  return {
    get(key: string): string | null {
      try {
        return (kind === 'local' ? localStorage : sessionStorage).getItem(PREFIX + key);
      } catch {
        return null;
      }
    },
    set(key: string, value: string | null): void {
      try {
        const s = kind === 'local' ? localStorage : sessionStorage;
        if (value === null) s.removeItem(PREFIX + key);
        else s.setItem(PREFIX + key, value);
      } catch {
        /* private mode, blocked storage: fine */
      }
    },
  };
}

export const store = storage('local');
export const session = storage('session');
