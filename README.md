# Cue Club

Pool and snooker in the browser, in 3D (three.js / WebGL). Four games on three real-size tables:

| Game | Table | Rules in short |
|------|-------|----------------|
| **UK 8-Ball** | 7ft pub table, reds & yellows | Fouls give the opponent two visits (the first a free shot); in-off = ball in hand behind the baulk line |
| **US 8-Ball** | 9ft, solids & stripes | WPA-style: fouls give ball in hand anywhere, rail after contact required, no called pockets |
| **9-Ball** | 9ft | Lowest ball first, pot the 9 (combinations count) to win |
| **Snooker** | 12ft, 15 reds + colours | Reds and colours, the colours in sequence, foul values, re-spotted black |

Play **against the computer** (Easy → Pro), **two players on one screen**, or **online**: a room of
two plays a match, three to eight play a **knockout tournament** (byes as needed), and anyone
waiting can watch any table live. Matches can be a single frame or first to 2, 3 or 5. Online, the
room's host sets the aim guide (full, short or off) for everyone.

Sound is synthesised from the physics (ball clicks, cushions, the cue tip, pockets with a ball
return or a net, cloth rumble), panned to where it happens, with each room's echo and snooker
applause. Volume is in the pause menu.

Each game has its own room: snooker in a panelled club, UK 8-ball in a pub, US 8-ball and 9-ball in
a neon-lit pool hall.

Live at **https://games.noblehaus.uk/cue-club/**.

## Controls

- **With a mouse (PC):** right-drag to aim (up/down tilts the camera); hold the **left button and
  pull the mouse back** to draw the cue, anywhere on the table.
- **On a touch screen:** drag on the table to aim; the power bar on the right is the cue.
- Arrow keys aim too; hold Shift for fine aim.
- **Controls in the game:** the **? Controls** button or **H** lists them for your device and
  cueing level (it opens by itself the first time). Keyboard players can swap **Arrows** (aim and
  power on the arrows, spin on WASD) for **WASD** (the other way round) there or on the menu.
- **Hold Z** (or the Zoom button) to zoom in on the contact point while you line up; the mouse
  wheel moves the cue view in and out.
- **Shoot** depends on the **cueing** setting (menu, or the host's choice online):
  - *Casual:* pull back (mouse or power bar) and let go (or ↑/↓ then Space). Exactly as aimed.
  - *Club:* pull back to your power (the white mark), then push forward through the ball.
    Drift sideways and the shot goes off line, more so on hard hits; snatch it and it's off;
    decelerate and it comes up short. Keyboard: ↑/↓ set the mark, Space starts the meter, Space
    again strikes: stop it on the mark.
  - *Pro:* no meter. Pull back and push forward: the faster the push, the harder the hit.
- **Fine aim:** drag the wheel on the left (made for thumbs on a phone).
- **Spin:** click the cue ball (bottom left) where you want to strike it: low = screw, high =
  follow, sides = side. W A S D nudge it.
- **Ball in hand:** drag the cue ball to place it.
- **Camera (V):** behind the cue, **sight** (your eye down the cue, the way you aim without a
  guide; dragging is finer here), or overhead.
- Tap during a shot to fast-forward.

## How it works

```
src/sim/       the game, DOM-free (the server runs it too)
  physics.ts   balls: sliding → rolling friction, spin, ball/cushion impacts, pockets
  tables.ts    table geometry (cushion segments incl. pocket jaws, pocket capture circles)
  rules/       uk8, us8, nine, snooker: judge a shot from what the physics saw
  game.ts      a match: frames, turns, concessions (takeShot is the only way to change it)
  ai.ts        the computer player: ghost-ball pot search, simulated with the real physics
src/net/       protocol (messages), tournament (knockout brackets), client (socket)
src/render/    three.js view: table model from the same geometry, textures drawn on canvases
src/play/      the table screen (input, turns, HUD) and the AI web worker
server/        Node: serves dist/, runs rooms, referees every online shot
```

- **One simulation, two runtimes.** The server imports `src/sim/` directly (Node ≥ 24 runs
  TypeScript) and referees each online shot; the browsers animate the same shot with the same
  code and land on the server's result.
- **Deterministic.** The simulation uses only `+ − × ÷ √` (`dmath.ts` has a Taylor-series sine),
  fixed steps and a fixed order, so every engine computes the same break. Shots are cleaned to
  six decimals before anyone simulates them.
- **Spin falls out of the model.** A ball slides until friction makes it roll; an impact swaps
  velocity but not spin. So stun, screw, follow and side off the cushion all happen on their own.
- **The AI uses the referee.** It scores candidate shots by playing them through `takeShot`, so
  it knows every rule, and harder levels replay their best options with their own aiming error
  to prefer shots with margin.

## Develop

```bash
npm install
npm run server         # game server on :3009 (rooms + referee)
npm run dev            # http://127.0.0.1:5173 (forwards /ws to :3009)
npm test               # physics, rules, brackets, server over real WebSockets
npm run build && npm run e2e   # headless Chrome: vs computer + a 3-player online knockout
```
