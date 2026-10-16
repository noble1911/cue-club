// Browser smoke test: drives the installed Chrome through the menu, a game against the
// computer, and a three-player online knockout (separate browser contexts = separate players),
// checking that every player sees the same table after each refereed shot. Screenshots in
// e2e/shots/.
//   npm run build && npm run e2e        (CHROME=… to override; E2E_GPU=swiftshader off a Mac)
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../server/index.ts';

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = process.env.SHOTS || 'e2e/shots';
const GPU = process.env.E2E_GPU || (process.platform === 'darwin' ? 'metal' : 'swiftshader');
fs.mkdirSync(SHOTS, { recursive: true });
process.env.FRAME_PAUSE_MS = '1500';

const server = await startServer(0);
const base = `http://127.0.0.1:${server.address().port}/`;
const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: [`--use-angle=${GPU}`, '--enable-gpu', '--ignore-gpu-blocklist'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
let failures = 0;
const check = (cond, what) => {
  console.log(`${cond ? '✔' : '✖'} ${what}`);
  if (!cond) failures++;
};
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

async function newPage(name, width = 1280, height = 800) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width, height });
  page.on('pageerror', (e) => errors.push(`${name}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && errors.push(`${name}: ${m.text()}`));
  await page.goto(base, { waitUntil: 'networkidle0' });
  return page;
}

/** The first game in a browser shows the controls: check it did, and close it as a player would. */
async function dismissControls(page, name) {
  const shown = await page.waitForSelector('.controls-panel:not(.hidden)', { timeout: 3000 }).then(() => true, () => false);
  if (shown) await page.click('.ctl-close');
  return shown;
}
const myTurn = (p) => p.$eval('.table-screen', (e) => e.classList.contains('my-turn')).catch(() => false);
async function pullAndShoot(p, amount) {
  const box = await p.$eval('.power-track', (e) => {
    const r = e.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + 4, h: r.height };
  });
  await p.mouse.move(box.x, box.y);
  await p.mouse.down();
  await p.mouse.move(box.x, box.y + box.h * amount, { steps: 6 });
  await p.mouse.up();
}
const tableState = (p) =>
  p.evaluate(() => {
    const m = window.__cue.match();
    return m ? JSON.stringify([m.frame.turn, m.frame.balls.map((b) => [b.id, b.on, b.x, b.y])]) : null;
  });

try {
  // ------------------------------------------------------------ vs the computer
  const solo = await newPage('solo');
  await shot(solo, 'menu');
  check(!!(await solo.$('.game[data-v="snooker"]')), 'menu lists the four games');
  await solo.click('.game[data-v="uk8"]');
  await solo.click('.modes button[data-m="ai"]');
  await solo.click('.lvl button[data-l="easy"]');
  await solo.click('.go');
  check(await dismissControls(solo), 'first game: the controls list opens by itself');
  let mine = 0;
  for (let i = 0; i < 40 && mine < 2; i++) {
    await sleep(800);
    if (!(await myTurn(solo))) continue;
    const before = await tableState(solo);
    await pullAndShoot(solo, mine === 0 ? 0.85 : 0.4);
    mine++;
    await sleep(600);
    await shot(solo, `solo-shot-${mine}`);
    for (let k = 0; k < 30 && (await tableState(solo)) === before; k++) await sleep(500);
    check((await tableState(solo)) !== before, `vs computer: shot ${mine} played`);
  }
  check(mine === 2, 'vs computer: the computer took its turns and handed the table back');

  // ------------------------------------------------------------ club cueing: pull back, push through
  const club = await newPage('club');
  await club.click('.game[data-v="nine"]');
  await club.click('.modes button[data-m="local"]');
  await club.click('.cue button[data-c="club"]');
  await club.click('.go');
  await dismissControls(club);
  await sleep(1200);
  {
    const b = await club.$eval('.power-track', (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + 4, h: r.height };
    });
    await club.mouse.move(b.x, b.y);
    await club.mouse.down();
    await club.mouse.move(b.x, b.y + b.h * 0.6, { steps: 6 });
    await club.mouse.up();
    await sleep(300);
    check(!(await club.evaluate(() => window.__cue.view.isPlaying)), 'club cueing: pulling back alone does not shoot');
    await club.mouse.move(b.x, b.y);
    await club.mouse.down();
    await club.mouse.move(b.x, b.y + b.h * 0.6, { steps: 6 });
    for (let i = 1; i <= 8; i++) await club.mouse.move(b.x + i * 4, b.y + b.h * 0.6 * (1 - i / 8) - (i === 8 ? 2 : 0));
    await club.mouse.up();
    await sleep(300);
    const msg = await club.$eval('.hmsg', (e) => e.textContent);
    check(/off line/.test(msg) && (await club.evaluate(() => window.__cue.view.isPlaying)), `club cueing: a drifting push is played, off line ("${msg}")`);
  }

  // ------------------------------------------------------------ a mouse on a PC: left strikes, right aims
  const pc = await newPage('pc');
  await pc.click('.game[data-v="uk8"]');
  await pc.click('.modes button[data-m="local"]');
  await pc.click('.cue button[data-c="pro"]');
  await pc.click('.go');
  await dismissControls(pc);
  await sleep(1200);
  {
    const ang = () => pc.evaluate(() => Math.atan2(window.__cue.view.aim.dy, window.__cue.view.aim.dx));
    const a0 = await ang();
    await pc.mouse.move(700, 400);
    await pc.mouse.down({ button: 'right' });
    await pc.mouse.move(760, 400, { steps: 5 });
    await pc.mouse.up({ button: 'right' });
    check(Math.abs((await ang()) - a0) > 0.05 && !(await pc.evaluate(() => window.__cue.view.isPlaying)), 'mouse: right-drag aims without shooting');
    // Shift part-way through a drag slows what comes next; it must not undo what was done
    {
      const s0 = await ang();
      await pc.mouse.move(600, 400);
      await pc.mouse.down({ button: 'right' });
      await pc.mouse.move(700, 400, { steps: 5 });
      const coarse = (await ang()) - s0;
      await pc.keyboard.down('Shift');
      await pc.mouse.move(720, 400, { steps: 4 });
      const after = (await ang()) - s0;
      await pc.keyboard.up('Shift');
      await pc.mouse.up({ button: 'right' });
      const fineBit = after - coarse;
      check(Math.abs(after) >= Math.abs(coarse) && Math.abs(fineBit) < Math.abs(coarse) * 0.05, `mouse: Shift mid-drag keeps the aim and fine-tunes (${coarse.toFixed(3)} rad, then ${fineBit.toFixed(4)} more)`);
    }
    await pc.mouse.move(600, 300);
    await pc.mouse.down();
    await pc.mouse.move(600, 306);
    await pc.mouse.up();
    await sleep(200);
    check(!(await pc.evaluate(() => window.__cue.view.isPlaying)), 'mouse: a 6 px twitch of the left button does not shoot');
    await pc.mouse.move(600, 300);
    await pc.mouse.down();
    await pc.mouse.move(600, 520, { steps: 8 });
    await sleep(120);
    for (let i = 1; i <= 6; i++) await pc.mouse.move(600, 520 - (222 * i) / 6);
    await pc.mouse.up();
    await sleep(300);
    check(await pc.evaluate(() => window.__cue.view.isPlaying), 'mouse: hold left, pull back, push forward strikes (pro)');
    await shot(pc, 'mouse-stroke');
  }

  // ------------------------------------------------------------ online knockout, three players
  const ann = await newPage('Ann', 1100, 700);
  await ann.click('.game[data-v="nine"]');
  await ann.click('.modes button[data-m="online"]');
  await ann.$eval('.n1', (e) => ((e.value = 'Ann'), e.dispatchEvent(new Event('input'))));
  await ann.click('.create');
  await ann.waitForSelector('.code-big');
  const code = await ann.$eval('.code-big', (e) => e.textContent.trim());
  const players = { Ann: ann };
  for (const n of ['Bob', 'Cat']) {
    const p = await newPage(n, 1100, 700);
    await p.click('.modes button[data-m="online"]');
    await p.$eval('.n1', (e, v) => ((e.value = v), e.dispatchEvent(new Event('input'))), n);
    await p.$eval('.code', (e, c) => (e.value = c), code);
    await p.click('.join');
    await p.waitForSelector('.members');
    players[n] = p;
  }
  await sleep(400);
  check((await ann.$eval('.start', (e) => e.textContent)).includes('3 players'), 'online: three players in the room, host can start a tournament');
  await shot(ann, 'online-lobby');
  await ann.click('.start');
  await sleep(1500);
  for (const p of Object.values(players)) await dismissControls(p).catch(() => {});
  let played = 0;
  for (let i = 0; i < 30 && played < 3; i++) {
    await sleep(1000);
    for (const [n, p] of Object.entries(players)) {
      if (!(await myTurn(p))) continue;
      await pullAndShoot(p, 0.8);
      played++;
      await sleep(9000);
      const states = (await Promise.all(Object.values(players).map(tableState))).filter(Boolean);
      check(states.length === 2 && states[0] === states[1], `online: shot ${played} by ${n}, both players see the same table`);
      break;
    }
  }
  check(played === 3, 'online: three shots refereed');
  // the player with a bye watches from the bracket
  let watched = false;
  for (const [n, p] of Object.entries(players)) {
    const btn = await p.$('.bracket .watch');
    if (!btn) continue;
    await shot(p, `online-bracket-${n}`);
    await btn.click();
    await sleep(1200);
    watched = !!(await p.$('.table-screen')) && (await p.$eval('.htitle', (e) => e.textContent)).includes('watching');
    await shot(p, `online-watching-${n}`);
  }
  check(watched, 'online: the player with a bye can watch the semi-final');
} finally {
  check(errors.length === 0, `no page errors${errors.length ? ': ' + errors.join(' | ') : ''}`);
  await browser.close();
  server.closeAllConnections();
  server.close();
}
console.log(failures ? `${failures} failed` : 'all passed');
process.exit(failures ? 1 : 0);
