import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { _android, chromium, devices } from 'playwright';

const dbFolder = process.env.TEST_BASE_URL ? undefined : await mkdtemp(join(tmpdir(), 'moon-isles-browser-'));
const port = process.env.TEST_PORT ?? '18911';
const base = process.env.TEST_BASE_URL ?? `http://127.0.0.1:${port}/gamehub/moon-isles/`;
const screenshots = process.env.SCREENSHOT_DIR;
const androidSerial = process.env.TEST_ANDROID_SERIAL;
if (androidSerial && dbFolder) throw new Error('Use TEST_BASE_URL with a server reachable from the Android device.');
let android;
let androidContext;
let serverProcess;
let output = '';

async function start() {
  if (dbFolder) {
    serverProcess = spawn(process.execPath, ['src/server.ts'], {
      env: { ...process.env, DB_PATH: join(dbFolder, 'match.sqlite'), PORT: port, BASE_PATH: '/gamehub/moon-isles', PUBLIC_ORIGIN: new URL(base).origin, TRUST_PROXY: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [serverProcess.stdout, serverProcess.stderr]) stream.on('data', (data) => { output += data; });
  }
  for (let attempt = 0; attempt < 70; attempt++) {
    if (serverProcess?.exitCode != null) throw new Error(output);
    try {
      const response = await fetch(new URL('health', base));
      if (response.ok && (await response.json()).ok) return;
    } catch {
      // Allow the local server time to bind.
    }
    await delay(100);
  }
  throw new Error(`Health check failed at ${base}\n${output}`);
}

async function stop() {
  if (!serverProcess || serverProcess.exitCode !== null || serverProcess.signalCode !== null) return;
  const exited = once(serverProcess, 'exit');
  serverProcess.kill();
  await exited;
}

const browser = await chromium.launch();
const errors = [];
try {
  await start();
  const desktop = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  if (androidSerial) {
    _android.setDefaultTimeout(15_000);
    android = (await _android.devices()).find((device) => device.serial() === androidSerial);
    if (!android) throw new Error(`Android device not found: ${androidSerial}`);
    androidContext = await android.launchBrowser({ hasTouch: true });
  }
  const mobile = androidContext ? await androidContext.newPage() : await browser.newPage(devices['iPhone 13']);
  const visitor = await browser.newContext();
  const websocketFrames = new Set();
  for (const page of [desktop, mobile]) {
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('websocket', (socket) => {
      if (socket.url().includes('/gamehub/moon-isles/socket.io/')) socket.on('framereceived', () => websocketFrames.add(page));
    });
    page.on('console', (message) => {
      if (message.type() === 'error') console.error(`Browser: ${message.text()}`);
    });
  }
  await desktop.goto(base);
  if (screenshots) await desktop.screenshot({ path: join(screenshots, 'moon-isles-home.png'), fullPage: true });
  await desktop.getByLabel('你的昵称').fill('阿澄');
  await desktop.getByRole('button', { name: '创建好友房' }).click();
  await desktop.getByRole('heading', { name: '集合同伴' }).waitFor();
  const invitation = desktop.url();
  const id = new URL(invitation).searchParams.get('room');
  const endpoint = new URL(`api/rooms/${id}/`, base).href;
  assert.equal(await desktop.getByRole('button', { name: '启航' }).isDisabled(), true);
  await mobile.goto(invitation);
  await mobile.getByLabel('你的昵称').fill('小舟');
  await mobile.getByRole('button', { name: '加入航程' }).click();
  await mobile.getByText('等待房主启航').waitFor();
  const unauthorized = await mobile.request.post(endpoint + 'start', { data: {} });
  assert.equal(unauthorized.status(), 403);
  assert.equal((await visitor.request.post(endpoint + 'join', { data: { name: '来客' } })).status(), 409);
  await desktop.getByRole('button', { name: '启航' }).click();

  const action = (page, name) => page.locator('.action-buttons').getByRole('button', { name: new RegExp(name) });
  const play = async (page, name) => {
    if (page === mobile) await action(page, name).tap();
    else await action(page, name).click();
  };
  const load = '装载木材 ×1、铁件 ×1';
  const deliver = '交付木材 ×1、铁件 ×1';
  await action(desktop, load).waitFor();
  assert.equal((await desktop.request.post(endpoint + 'start', { data: {} })).status(), 200);
  await mobile.getByText('等待 阿澄').waitFor();
  assert.equal(await mobile.locator('button[data-action]').count(), 0);
  await play(desktop, load);
  await action(desktop, '航行至北礁').waitFor({ state: 'visible' });
  if (dbFolder) {
    // Observe the committed state before simulating a service restart.
    await desktop.locator('.actions > p').filter({ hasText: '木材 ×1、铁件 ×1' }).waitFor();
    await stop();
    await desktop.getByText('连接中断，正在重连').waitFor();
    await start();
    await desktop.getByText('轮到你行动').waitFor();
    await desktop.locator('.action-title').getByText('1 行动点').waitFor();
  }
  if (screenshots) await desktop.screenshot({ path: join(screenshots, 'moon-isles-board.png'), fullPage: true });
  await play(desktop, '航行至北礁');
  await play(desktop, deliver);
  await play(mobile, load);
  await mobile.locator('.actions > p').filter({ hasText: '木材 ×1、铁件 ×1' }).waitFor();
  await mobile.reload();
  await action(mobile, '航行至北礁').waitFor();
  if (screenshots) await mobile.screenshot({ path: join(screenshots, 'moon-isles-mobile.png'), fullPage: true });
  await play(mobile, '航行至北礁');
  await play(mobile, '点亮信标');
  await desktop.getByRole('heading', { name: /第 2.*轮/ }).waitFor();

  const target = async () => desktop.locator('.forecast li.current strong').textContent();
  if (await target() === '北礁') {
    await play(desktop, '设置风暴防护');
    await play(desktop, '航行至外海台');
  } else {
    await play(desktop, '航行至外海台');
    await play(desktop, '设置风暴防护');
  }
  await play(desktop, '结束回合');
  await play(mobile, '航行至外海台');
  await play(mobile, deliver);
  await desktop.getByRole('heading', { name: /第 3.*轮/ }).waitFor();
  await play(desktop, '点亮信标');
  if (await target() === '北礁') await play(desktop, '航行至北礁');
  await play(desktop, '设置风暴防护');
  await play(mobile, '结束回合');
  await desktop.getByRole('heading', { name: '信标重燃' }).waitFor();
  await mobile.getByRole('heading', { name: '信标重燃' }).waitFor();
  assert.equal(await desktop.getByTestId('total').textContent(), '69');
  assert.equal(await mobile.getByTestId('total').textContent(), '69');
  assert.equal(websocketFrames.size, 2);
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  if (screenshots) await desktop.screenshot({ path: join(screenshots, 'moon-isles-result.png'), fullPage: true });
  const result = await (await desktop.request.get(endpoint + 'result')).json();
  assert.equal(result.result.players[0].blocked, 2);
  assert.equal(result.result.players[1].delivered.iron, 1);
  assert.equal((await visitor.request.get(endpoint + 'result')).status(), 403);
  if (dbFolder) {
    await stop();
    await start();
  }
  await desktop.reload();
  await desktop.getByRole('heading', { name: '信标重燃' }).waitFor();
  assert.deepEqual(await (await desktop.request.get(endpoint + 'result')).json(), result);
  console.log(`Desktop + ${androidSerial ? 'Android Chrome' : 'mobile Chromium'} finished with 69 points. Result retained at ${base}`);

  await desktop.goto(base);
  await desktop.getByRole('button', { name: '单人试玩' }).click();
  await action(desktop, load).waitFor();
  const soloURL = desktop.url();
  const soloID = new URL(soloURL).searchParams.get('room');
  const soloEndpoint = new URL(`api/rooms/${soloID}`, base).href;
  const soloRoom = await (await desktop.request.get(soloEndpoint)).json();
  assert.deepEqual(soloRoom.members.map(({ name, bot }) => ({ name, bot: Boolean(bot) })), [
    { name: '船长', bot: false }, { name: '雾帆', bot: true },
  ]);
  const publicRoom = await (await visitor.request.get(soloEndpoint)).json();
  assert.equal(publicRoom.seat, null);
  assert.equal(publicRoom.credentials, undefined);
  assert.equal((await visitor.request.post(`${soloEndpoint}/join`, { data: { name: '来客' } })).status(), 409);

  await play(desktop, load);
  await play(desktop, '航行至北礁');
  await play(desktop, deliver);
  await desktop.getByText(/AI 队友 雾帆 行动中/).waitFor();
  if (dbFolder) {
    await stop();
    await desktop.getByText('连接中断，正在重连').waitFor();
    await start();
  }
  await desktop.getByRole('heading', { name: /第 2.*轮/ }).waitFor();
  assert.equal(await desktop.locator('.voyage-stat').first().textContent(), '信标 1 / 2');
  await play(desktop, '航行至月灯港');
  await play(desktop, load);
  await play(desktop, '航行至北礁');
  await desktop.getByRole('heading', { name: /第 3.*轮/ }).waitFor();
  await play(desktop, '航行至外海台');
  await play(desktop, deliver);
  await play(desktop, '点亮信标');
  await desktop.getByRole('heading', { name: '信标重燃' }).waitFor();
  const soloResult = await (await desktop.request.get(`${soloEndpoint}/result`)).json();
  assert.equal(soloResult.result.reason, 'all-lit');
  assert.equal(soloResult.result.players[1].lit[0], 'north');
  const { beacons, integrity, defenses, speed, total } = soloResult.result.score;
  assert.equal(total, beacons + integrity + defenses + speed);
  assert.equal(await desktop.locator('.contributions .bot-tag').count(), 1);
  await desktop.reload();
  await desktop.getByRole('heading', { name: '信标重燃' }).waitFor();
  assert.deepEqual(await (await desktop.request.get(`${soloEndpoint}/result`)).json(), soloResult);

  for (const capacity of [3, 4]) {
    const response = await desktop.request.post(new URL('api/rooms', base).href, { data: { mode: 'solo', capacity } });
    assert.equal(response.status(), 201);
    const { id: matchID } = await response.json();
    const detail = await (await desktop.request.get(new URL(`api/rooms/${matchID}`, base).href)).json();
    assert.equal(detail.started, true);
    assert.equal(detail.seat, 0);
    assert.equal(detail.members.filter((member) => member.bot).length, capacity - 1);
  }
  assert.deepEqual(errors, []);
  console.log(`Solo match finished with ${total} points and retained AI contributions after reload.`);
} catch (error) {
  if (output) console.error(output);
  throw error;
} finally {
  await androidContext?.close();
  await android?.close();
  await browser.close();
  await stop();
  if (dbFolder) await rm(dbFolder, { recursive: true, force: true });
}
