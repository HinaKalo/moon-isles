import { Client } from 'boardgame.io/client';
import { SocketIO } from 'boardgame.io/multiplayer';
import { drawChart, PORTS, POSITIONS } from './chart.ts';
import { moonIsles } from './game.ts';
import {
  actionCost, actionLabel, cargoLabel, legalActions, LOCATIONS, MAX_ROUNDS, ROLES,
  type Action, type GameState, type Outcome, type Result,
} from './rules.ts';
import './style.css';

type Room = {
  id: string; capacity: number; started: boolean; finished: boolean;
  seat: number | null; credentials?: string; members: { seat: number; name: string; bot?: boolean }[];
};
type Archive = { finishedAt: string; result: Result };
type GameClient = ReturnType<typeof Client<GameState>>;

const app = document.querySelector<HTMLElement>('#app')!;
const toast = document.querySelector<HTMLElement>('#notice')!;
const directory = new URL('./', location.href);
const id = new URLSearchParams(location.search).get('room');
const roomPath = id ? `api/rooms/${encodeURIComponent(id)}` : 'api/rooms';
const outcomes: Record<Outcome, { title: string; detail: string }> = {
  'all-lit': { title: '信标重燃', detail: '海上的每一条航线都有了灯火。' },
  'ship-lost': { title: '航程中断', detail: '轮末风暴使船体完整度降到 0。' },
  deadline: { title: '航程超时', detail: '第五轮结束时仍有信标未点亮。' },
};

let room: Room | undefined;
let client: GameClient | undefined;
let archive: Archive | undefined;
let pendingVersion: number | undefined;
let pendingTimer: number | undefined;
let noticeTimer: number | undefined;
let loadingResult = false;
let waitingSignature = '';
let renderedVersion: number | undefined;
let renderedConnection: boolean | undefined;
let actions: Action[] = [];

function escape(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

function render(html: string) {
  const focus = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.focus : undefined;
  app.innerHTML = html;
  app.setAttribute('aria-busy', 'false');
  const canvas = app.querySelector('canvas');
  if (canvas) drawChart(canvas);
  if (focus) app.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
}

function notify(message: string) {
  window.clearTimeout(noticeTimer);
  toast.textContent = message;
  toast.hidden = false;
  noticeTimer = window.setTimeout(() => { toast.hidden = true; }, 4500);
}

async function request<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(new URL(path, directory), body ? {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  } : {});
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? '服务暂时不可用');
  return data as T;
}

function roomLink(roomID: string) {
  const url = new URL(directory);
  url.searchParams.set('room', roomID);
  return url.href;
}

function isBot(seat: number) {
  return Boolean(room?.members.find((member) => member.seat === seat)?.bot);
}

function botBadge(seat: number) {
  return isBot(seat) ? ' <span class="bot-tag">AI</span>' : '';
}

function chart(game?: GameState) {
  const forecast = game?.forecast[game.round - 1] ?? [];
  return `<div class="chart" aria-label="月灯群岛海图"><canvas aria-hidden="true"></canvas>
    ${PORTS.map((place) => {
      const [x, y] = POSITIONS[place];
      const site = game && place !== 'port' ? game.stations[place] : undefined;
      const target = !game || (place !== 'port' && game.targets.includes(place));
      const storm = place !== 'port' && forecast.includes(place);
      const sailors = game?.players.flatMap((player, seat) => player.location === place ? [seat] : []) ?? [];
      const action = actions.findIndex((item) => item.type === 'sail' && item.to === place);
      const tag = action >= 0 ? 'button' : 'div';
      const subtitle = place === 'port' ? '物资补给' : site?.lit ? '已点亮' : target ? `木 ${site?.cargo.wood ?? 0}/1 · 铁 ${site?.cargo.iron ?? 0}/1` : '';
      return `<${tag} class="location ${target ? 'target' : ''} ${site?.lit ? 'lit' : ''} ${storm ? 'storm' : ''}" style="--x:${x}%;--y:${y}%"
          ${action >= 0 ? `type="button" data-action="${action}" data-focus="map-${place}" aria-label="航行至${LOCATIONS[place].name}"` : ''}>
        <span class="marker ${place === 'port' ? 'harbor' : ''}"><span aria-hidden="true">${place === 'port' ? '⚓' : site?.lit ? '✦' : '♜'}</span></span>
        <span class="location-name">${LOCATIONS[place].name}${storm ? `<span class="storm-label">${site?.guard === null ? '风暴' : '已布防'}</span>` : ''}</span>
        ${subtitle ? `<span class="location-detail">${subtitle}</span>` : ''}
        ${sailors.length ? `<span class="ships" aria-label="所在席位 ${sailors.map((seat) => seat + 1).join('、')}">${sailors.map((seat) => `<span class="ship seat-${seat}">${seat + 1}</span>`).join('')}</span>` : ''}
      </${tag}>`;
    }).join('')}
  </div>`;
}

function showHome() {
  render(`<div class="boarding">
    <section class="invitation">
      <p class="eyebrow">合作桌游 · 2–4 人</p>
      <h1>月灯<br class="desktop-only">群岛</h1>
      <p class="lede">风暴将至。召集同伴，把木材和铁件送上岛，在第五轮结束前重新点亮信标。</p>
      <form class="boarding-form" data-form="create">
        <label for="captain">你的昵称</label><input id="captain" name="name" maxlength="32" required placeholder="单人试玩可留空">
        <label for="capacity">总席位</label><select id="capacity" name="capacity"><option value="2">2 位旅人</option><option value="3">3 位旅人</option><option value="4">4 位旅人</option></select>
        <div class="boarding-choices">
          <button class="primary" type="submit" data-mode="solo" formnovalidate>单人试玩</button>
          <button type="submit">创建好友房</button>
        </div>
        <p class="boarding-hint">单人试玩会由 AI 填满其余席位。</p>
      </form>
    </section>
    <section aria-label="海图与规则">${chart()}${rules()}</section>
  </div>`);
}

function rules() {
  return `<details class="rules"><summary>航行规则与计分</summary>
    <p>每轮每人行动一次，拥有 2 个行动点。移动、装货、交货、点灯或布防各用 1 点。每轮首次执行专长免费。</p>
    <p>港口可补给。每人最多携带 2 件物资，每座信标需要 1 件木材和 1 件铁件。风暴站点可提前布防，每道防护抵挡一次袭击。</p>
    <p>轮末先结算风暴。船体完整度归零即失败，点亮全部目标即可获胜，航程最多持续 5 轮。</p>
    <p>信标每座 20 分，剩余完整度每点 5 分，成功抵挡每次 2 分。获胜时每提前一轮再得 5 分。</p>
  </details>`;
}

function showRoom(info: Room) {
  const member = info.seat !== null;
  const full = info.members.length === info.capacity;
  render(`<div class="boarding">
    <section class="invitation">
      <p class="eyebrow">航程准备</p><h1 class="room-title">集合同伴</h1>
      <p class="lede">${info.started ? '这段航程已经出发。' : `已入座 ${info.members.length} / ${info.capacity}`}</p>
      <ol class="roster">${Array.from({ length: info.capacity }, (_, seat) => {
        const person = info.members.find((item) => item.seat === seat);
        return `<li><span class="ship seat-${seat}">${seat + 1}</span><span><strong>${person ? escape(person.name) : '等待同伴'}</strong><small>${ROLES[seat].name} · ${ROLES[seat].description}</small></span>${seat === info.seat ? '<span class="you">你</span>' : ''}</li>`;
      }).join('')}</ol>
      ${member ? `<div class="room-controls"><button type="button" data-command="invite" data-focus="invite">复制邀请</button>
        ${info.seat === 0 ? `<button class="primary" type="button" data-command="start" data-focus="start" ${full ? '' : 'disabled'}>启航</button>` : '<p class="status">等待房主启航</p>'}</div>
        <label class="invite-field">邀请链接<input value="${escape(roomLink(info.id))}" readonly></label>`
        : !info.started && !full ? `<form class="boarding-form" data-form="join"><label for="sailor">你的昵称</label><input id="sailor" name="name" maxlength="32" required placeholder="输入昵称" value="${escape(app.querySelector<HTMLInputElement>('#sailor')?.value ?? '')}"><button class="primary" type="submit">加入航程</button></form>`
          : '<p class="status">可请房主另开一局。</p><a href="./">返回首页</a>'}
    </section><section aria-label="海图与规则">${chart()}${rules()}</section>
  </div>`);
}

async function loadRoom() {
  try {
    room = await request<Room>(roomPath);
    const signature = JSON.stringify(room);
    if (room.finished) {
      void loadResult();
      return;
    }
    if (room.started && room.credentials && room.seat !== null) {
      connect(room, room.credentials, room.seat);
      return;
    }
    if (signature !== waitingSignature) {
      showRoom(room);
      waitingSignature = signature;
    }
    if (!room.started) window.setTimeout(loadRoom, 1900);
  } catch (error) {
    if (room) {
      notify('房间暂时无法同步，正在重试');
      window.setTimeout(loadRoom, 3000);
    } else {
      render(`<section class="message"><h1>无法加入航程</h1><p>${escape((error as Error).message)}</p><a href="./">返回首页</a></section>`);
    }
  }
}

function connect(info: Room, credentials: string, seat: number) {
  if (client) return;
  render('<p class="status" role="status">正在同步航程…</p>');
  const playerID = String(seat);
  client = Client({
    game: moonIsles, matchID: info.id, playerID, credentials, numPlayers: info.capacity, debug: false,
    multiplayer: SocketIO({
      socketOpts: {
        path: `${directory.pathname}socket.io`,
        auth: { matchID: info.id, playerID, credentials },
      },
    }),
  });
  client.subscribe((state) => {
    if (!state) return;
    if (state.G.result || state.ctx.gameover) {
      void loadResult();
      return;
    }
    if (pendingVersion !== undefined && state._stateID > pendingVersion) {
      window.clearTimeout(pendingTimer);
      pendingVersion = undefined;
    }
    if (renderedVersion === state._stateID && renderedConnection === state.isConnected) return;
    renderedVersion = state._stateID;
    renderedConnection = state.isConnected;
    showGame(state.G, Number(state.ctx.currentPlayer), seat, state.isConnected);
  });
  client.start();
  window.setTimeout(() => {
    if (!client?.getState() && !archive) render('<section class="message"><h1>正在等待联机</h1><p>可刷新页面恢复原席。</p><button data-command="reload">刷新</button></section>');
  }, 10_000);
}

function showGame(game: GameState, current: number, seat: number, connected: boolean) {
  const player = game.players[seat];
  const mine = current === seat;
  actions = connected && mine && pendingVersion === undefined ? legalActions(game, seat) : [];
  const lit = game.targets.filter((site) => game.stations[site].lit).length;
  render(`<div class="play">
    <div class="voyage-bar">
      <h1>第 ${game.round} <small>/ ${MAX_ROUNDS} 轮</small></h1>
      <div class="voyage-stat">信标 <strong>${lit} / ${game.targets.length}</strong></div>
      <div class="voyage-stat">船体 <strong class="${game.integrity === 1 ? 'urgent' : ''}">${game.integrity} / 3</strong></div>
      <div class="turn-badge" role="status">${!connected ? '连接中断，正在重连' : mine ? '轮到你行动' : isBot(current) ? `AI 队友 ${escape(game.players[current].name)} 行动中` : `等待 ${escape(game.players[current].name)}`}</div>
    </div>
    <div class="play-grid">
      <section aria-label="海图与预报">
        ${chart(game)}
        <div class="forecast"><h2>风暴预报</h2><ol>${game.forecast.map((sites, index) => `<li class="${index + 1 === game.round ? 'current' : ''}"><span>第 ${index + 1} 轮</span><strong>${sites.map((site) => LOCATIONS[site].name).join('、') || '晴天'}</strong></li>`).join('')}</ol></div>
        ${rules()}
      </section>
      <aside class="side">
        <section class="crew"><h2>同行者</h2><ol>${game.players.map((sailor, index) => `<li class="${index === current ? 'active' : ''}"><span class="ship seat-${index}">${index + 1}</span><span><strong>${escape(sailor.name)}${index === seat ? ' · 你' : ''}${botBadge(index)}</strong><small>${ROLES[index].name} · ${LOCATIONS[sailor.location].name}</small></span></li>`).join('')}</ol></section>
        <section class="actions">
          <div class="action-title"><h2>行动</h2><span>${player.points} 行动点</span></div>
          <p>${cargoLabel(player.cargo)}<br>${player.usedRole ? '本轮专长已使用' : ROLES[seat].description}</p>
          <div class="action-buttons">${actions.map((action, index) => `<button type="button" data-action="${index}" data-focus="action-${escape(actionLabel(action))}" class="${action.type === 'pass' ? 'pass' : ''}">${actionLabel(action)}${action.type === 'pass' ? '' : `<small>${actionCost(game, seat, action) ? '1 点' : '免费'}</small>`}</button>`).join('') || '<p class="status">等待同步后的行动机会。</p>'}</div>
        </section>
      </aside>
    </div>
    <section class="log"><h2>航行记录</h2>${game.log.length ? `<ol>${game.log.slice(-10).reverse().map((entry) => `<li><span>第 ${entry.round} 轮</span>${escape(entry.text)}</li>`).join('')}</ol>` : '<p>航程刚刚开始。</p>'}</section>
  </div>`);
}

async function loadResult() {
  if (archive || loadingResult) return;
  loadingResult = true;
  window.clearTimeout(pendingTimer);
  pendingVersion = undefined;
  render('<p class="status" role="status">正在读取已保存的结算…</p>');
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        archive = await request<Archive>(`${roomPath}/result`);
        break;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => window.setTimeout(resolve, 350));
      }
    }
    client?.stop();
    if (archive) showResult(archive);
  } catch (error) {
    render(`<section class="message"><h1>暂时无法读取结算</h1><p>${escape((error as Error).message)}</p><button data-command="result">重试</button></section>`);
  } finally {
    loadingResult = false;
  }
}

function showResult({ result, finishedAt }: Archive) {
  const ending = outcomes[result.reason];
  const score = result.score;
  const items = [
    ['信标', `${result.lit.length} / ${result.targets.length} 座`, score.beacons],
    ['船体完整度', `剩余 ${result.integrity} 点`, score.integrity],
    ['风暴防护', `抵挡 ${score.defenses / 2} 次`, score.defenses],
    ['提前完成', `提前 ${score.speed / 5} 轮`, score.speed],
  ];
  render(`<div class="result">
    <header class="result-head">
      <div><p class="eyebrow">${result.reason === 'all-lit' ? '全队获胜' : '全队失败'} · 第 ${result.round} 轮</p>
        <h1>${ending.title}</h1><p>${ending.detail}</p></div>
      <div class="total"><span>团队总分</span><strong data-testid="total">${score.total}</strong><span>分</span></div>
    </header>
    <section class="score-section"><h2>计分明细</h2><dl>${items.map(([name, detail, points]) => `<div><dt>${name}<small>${detail}</small></dt><dd>+${points}</dd></div>`).join('')}</dl>
      <p>已点亮 ${result.lit.length ? result.lit.map((site) => LOCATIONS[site].name).join('、') : '0 座信标'}</p>
    </section>
    <section class="contributions"><h2>同行者贡献</h2>
      <ul>${result.players.map((player, seat) => `<li><h3><span class="ship seat-${seat}">${seat + 1}</span>${escape(player.name)}${botBadge(seat)}<small>${ROLES[seat].name}</small></h3>
        <p>交付 ${cargoLabel(player.delivered) === '空舱' ? '0 件物资' : cargoLabel(player.delivered)}</p>
        <p>点亮 ${player.lit.length ? player.lit.map((site) => LOCATIONS[site].name).join('、') : '0 座信标'}</p>
        <p>抵挡风暴 ${player.blocked} 次</p></li>`).join('')}</ul>
    </section>
    <footer class="result-foot"><span>结算已保存 · <time datetime="${escape(finishedAt)}">${new Date(finishedAt).toLocaleString('zh-CN')}</time></span><a class="primary" href="./">再开一局</a></footer>
  </div>`);
}

app.addEventListener('submit', async (event) => {
  const form = event.target as HTMLFormElement;
  if (!form.dataset.form) return;
  event.preventDefault();
  const submitter = (event as SubmitEvent).submitter;
  const buttons = form.querySelectorAll('button');
  for (const button of buttons) button.disabled = true;
  try {
    const data = new FormData(form);
    const create = form.dataset.form === 'create';
    const body = create ? {
      name: data.get('name'), capacity: Number(data.get('capacity')), mode: submitter?.dataset.mode,
    } : { name: data.get('name') };
    const created = await request<{ id: string }>(create ? 'api/rooms' : `${roomPath}/join`, body);
    location.assign(roomLink(created.id));
  } catch (error) {
    notify((error as Error).message);
    for (const button of buttons) button.disabled = false;
  }
});

app.addEventListener('click', async (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>('button');
  if (!button) return;
  if (button.dataset.action !== undefined) {
    const snapshot = client?.getState();
    const action = actions[Number(button.dataset.action)];
    if (!client || !snapshot?.isConnected || !action || pendingVersion !== undefined) return;
    pendingVersion = snapshot._stateID;
    for (const option of app.querySelectorAll<HTMLButtonElement>('button[data-action]')) option.disabled = true;
    pendingTimer = window.setTimeout(() => {
      pendingVersion = undefined;
      const state = client?.getState();
      if (state && room?.seat != null && !state.G.result) showGame(state.G, Number(state.ctx.currentPlayer), room.seat, state.isConnected);
      notify('行动尚未确认，请检查当前局面');
    }, 2500);
    client.moves.act(action);
    return;
  }
  if (button.dataset.command === 'invite' && room) {
    try {
      await navigator.clipboard.writeText(roomLink(room.id));
      notify('邀请链接已复制');
    } catch {
      const field = app.querySelector<HTMLInputElement>('.invite-field input');
      field?.focus();
      field?.select();
      notify('请复制已选中的邀请链接');
    }
  }
  if (button.dataset.command === 'start') {
    button.disabled = true;
    try {
      await request(`${roomPath}/start`, {});
      location.reload();
    } catch (error) {
      button.disabled = false;
      notify((error as Error).message);
    }
  }
  if (button.dataset.command === 'result') void loadResult();
  if (button.dataset.command === 'reload') location.reload();
});

if (id) void loadRoom();
else showHome();
