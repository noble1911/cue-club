# Cue Club

Pool and snooker in the browser (three.js), four games: UK 8-ball, US 8-ball, 9-ball, snooker.
Vs computer, pass & play, online 1v1 and knockout tournaments (3–8 players). TypeScript + Vite;
the Node server runs the TypeScript directly. See README.md for the file map.

| Task | Command |
|------|---------|
| Run locally | `npm run server` + `npm run dev` (http://127.0.0.1:5173) |
| Tests | `npm test` (physics, rules, brackets, server over real sockets) |
| Browser smoke test | `npm run build && npm run e2e` (screenshots in `e2e/shots/`) |
| Deploy | `npm run deploy` (see Hosting) |

## Rules of the codebase

- `src/sim/` is the single source of the game and must stay DOM-free and **deterministic**: the
  server referees with it and the browsers animate with it. Use only `+ − × ÷ √` and the
  `dmath.ts` functions there; never `Math.sin`, `Math.hypot`, `Math.random` or wall-clock time.
  A shot goes through `cleanShot()` before anyone simulates it.
- The only ways to change a match are `takeShot`, `concede` and `nextFrame` (`src/sim/game.ts`).
- Rule messages say `@0`/`@1` for the players; `say()` fills in names (and fixes "You takes").
- Node runs `server/index.ts` with type stripping: no enums, namespaces or parameter properties
  (`erasableSyntaxOnly` in tsconfig enforces it), and imports carry `.ts` extensions.
- Physics feel (friction, restitution, pocket sizes, max speed) lives in `tables.ts`. Retune with
  `npm test` (pot-every-pocket, screw/follow/stun, side) and an AI-vs-AI frame
  (`chooseShot` in a loop) to check frames still finish.
- Cueing (`src/play/stroke.ts`, pure, unit-tested): casual / club / pro turn the player's
  stroke into the shot's power and an aim error in the browser; the server only sees the
  resulting shot, so it needs no changes per mode. Online, the host picks it (`RoomSettings`).
- Table meshes are built from the physics geometry (`src/render/table.ts`). Outlines with pocket
  openings are walked round the rectangle (`outline()`), never sorted by angle (that zig-zags at the
  corners); cushions are built face by face, never extruded with a bevel (it folds at the jaws).
- Balls don't cast shadow-map shadows (lit from straight above, only a ring shows): each has a soft
  contact shadow instead. Lamp fittings fade out whenever they cover the table on screen.
- three r186: `PCFSoftShadowMap` is gone (use `PCFShadowMap`); judge the look with the real GPU
  (`E2E_GPU=metal`, the default on a Mac): SwiftShader can't sample the shadow maps.

## Hosting (home server, Mac Mini 192.168.1.117)

Live at **https://games.noblehaus.uk/cue-club/**, one of the games on the games site. On the LAN
it's http://192.168.1.117:3009/ (the container) or http://192.168.1.117:3010/cue-club/ (through
the gateway).

- **Container** `cue-club` on the external `homeserver` Docker network, `restart: unless-stopped`,
  `/healthz` healthcheck. LAN port **3009** (container 3000) is registered in the home-server
  `registry/services.yaml`. Docker on the box is `/usr/local/bin/docker` (not on the SSH PATH).
- The source on the box is `~/cue-club`, a plain copy of a commit (no git); `.deployed-commit`
  records which. The image build runs the unit tests.
- **Gateway:** `~/home-server/games/Caddyfile` has `handle_path /cue-club/*` →
  `cue-club:3000` (prefix stripped, WebSockets pass through); hub card = the `cue-club` entry in
  `site/games.json` + `site/img/cue-club.jpg` (640×400). Caddyfile changes need
  `~/home-server/scripts/17-games.sh` on the server. Gateway docs: `~/home-server/games/README.md`.
- **Repo:** https://github.com/noble1911/cue-club (public). `gh` stays on ron875 globally: use
  `GH_TOKEN="$(gh auth token --user noble1911)" gh …` per command. `git push` already goes as
  noble1911 (repo-local credential helper asking `gh auth token --user noble1911`).
- Online rooms live in memory, so a deploy ends games in progress.

**Deploy** a committed version (uncommitted changes are never deployed):

```bash
npm run deploy   # export HEAD → ~/cue-club → docker compose up -d --build → wait healthy
                 #   → check the page and an online room through the gateway
```

**Path rules** (the game shares one origin with the other games and is served under a path):

- Relative asset URLs: `vite.config.ts` has `base: './'`; the AI worker is loaded with
  `new URL('./ai.worker.ts', import.meta.url)`.
- The socket URL is built from the page URL: `socketURL()` in `src/net/client.ts`
  (`new URL('ws', location.href)`), never `location.host`.
- Storage keys are prefixed `cue-club.` (`src/ui/dom.ts`): localStorage for preferences,
  sessionStorage `cue-club.seat` for rejoining a room after a reload.
- Check under a prefix before deploying: `npm run preview:path` serves `dist/` at
  http://127.0.0.1:5190/cue-club/ (static only) and logs any request outside the prefix.
