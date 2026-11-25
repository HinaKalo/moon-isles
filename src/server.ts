import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { State } from 'boardgame.io';
import type { IntermediateTransportData } from 'boardgame.io/dist/types/src/master/master.js';
import type { Server as SocketServer, ServerOptions } from 'socket.io';
import { chooseBotAction } from './bot.ts';
import { moonIsles } from './game.ts';
import type { GameState } from './rules.ts';
import { createMatch, MatchStore, type Member } from './store.ts';

const require = createRequire(import.meta.url);
const { Server, SocketIO } = require('boardgame.io/server') as typeof import('boardgame.io/dist/types/packages/server.js');
const { Master } = require('boardgame.io/master') as typeof import('boardgame.io/dist/types/packages/master.js');
const port = Number(process.env.PORT ?? 18910);
const host = process.env.HOST || '127.0.0.1';
const base = (process.env.BASE_PATH ?? '').replace(/\/$/, '');
if (base && !/^\/[a-z0-9/-]+$/.test(base)) throw new Error('Invalid BASE_PATH');
const origin = process.env.PUBLIC_ORIGIN || `http://${host}:${port}`;
const secure = origin.startsWith('https:');
const db = new MatchStore(process.env.DB_PATH ?? 'rooms.sqlite');
const cookie = 'moon_isles_seat';
const validID = /^[A-Za-z0-9_-]{16}$/;
const validToken = /^[A-Za-z0-9_-]{43}$/;
const token = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const cookieValue = (header: string | undefined) => header?.match(/(?:^|;\s*)moon_isles_seat=([A-Za-z0-9_-]{43})(?=;|$)/)?.[1];

const files = new Map<string, { body: Buffer; type: string }>([
  ['/', { body: readFileSync(new URL('../dist/index.html', import.meta.url)), type: 'text/html; charset=utf-8' }],
]);
const contentTypes: Record<string, string> = { js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', webp: 'image/webp' };
for (const file of readdirSync(new URL('../dist/assets/', import.meta.url))) {
  files.set(`/assets/${file}`, {
    body: readFileSync(new URL(`../dist/assets/${file}`, import.meta.url)),
    type: contentTypes[file.split('.').at(-1)!] ?? 'application/octet-stream',
  });
}

class GameTransport extends SocketIO {
  broadcastMove(id: string, payload: IntermediateTransportData) {
    // Use the same per-match channel and player views as boardgame.io's Socket.IO updates.
    this.pubSub.publish(`MATCH-${id}`, payload);
  }
}

const transport = new GameTransport({
  socketOpts: {
    path: `${base}/socket.io`,
    cors: { origin },
    allowRequest: (request, callback) => callback(null, request.headers.origin === undefined || request.headers.origin === origin),
    maxHttpBufferSize: 16_384,
  } satisfies Partial<ServerOptions> as ServerOptions,
});
const server = Server({ games: [moonIsles], db, origins: [origin], transport });
const { app } = server;
const namespace = (app as typeof app & { _io: SocketServer })._io.of(`/${moonIsles.name}`);

const botTimers = new Set<string>();
function scheduleBot(id: string) {
  if (botTimers.has(id)) return;
  botTimers.add(id);
  setTimeout(() => {
    botTimers.delete(id);
    void transport.getMatchQueue(id).add(async () => {
      const { state, metadata } = db.fetch(id, { state: true, metadata: true });
      if (!state || state.ctx.gameover || !db.isBot(id, Number(state.ctx.currentPlayer))) return;
      const actor = state.ctx.currentPlayer;
      const seat = Number(actor);
      const credentials = metadata?.players[seat]?.credentials;
      if (!credentials) throw new Error('AI seat has no credentials');
      const master = new Master(moonIsles, db, {
        send: () => {},
        sendAll: (message) => transport.broadcastMove(id, message),
      }, server.auth);
      await master.onUpdate({
        type: 'MAKE_MOVE',
        payload: {
          type: 'act', playerID: actor, credentials,
          args: [chooseBotAction(state.G, seat)],
        },
      }, state._stateID, id, actor);
    }).catch((error: unknown) => console.error('AI turn failed', error));
  }, 500).unref();
}

db.onStateWritten = (id: string, state: State<GameState>) => {
  if (!state.ctx.gameover && db.isBot(id, Number(state.ctx.currentPlayer))) scheduleBot(id);
};

namespace.use((socket, next) => {
  const { matchID, playerID, credentials } = socket.handshake.auth;
  const session = cookieValue(socket.request.headers.cookie);
  if (!session || typeof matchID !== 'string' || !validID.test(matchID) || !/^[0-3]$/.test(playerID)
      || typeof credentials !== 'string' || !validToken.test(credentials)) {
    next(new Error('Seat required'));
    return;
  }
  const member = db.member(matchID, digest(session));
  const { metadata } = db.fetch(matchID, { metadata: true });
  if (!member || member.is_bot || String(member.seat) !== playerID || metadata?.players[member.seat]?.credentials !== credentials) {
    next(new Error('Seat required'));
    return;
  }
  socket.use(([event, ...args], accept) => {
    if (event === 'sync' && args[0] === matchID && args[1] === playerID && args[2] === credentials) {
      accept();
      return;
    }
    if (event === 'update') {
      const [action, version, room, actor] = args;
      if (room === matchID && actor === playerID && Number.isSafeInteger(version) && version >= 0
          && action?.type === 'MAKE_MOVE' && action.payload?.type === 'act' && action.payload.playerID === playerID
          && action.payload.credentials === credentials && Array.isArray(action.payload.args) && action.payload.args.length === 1) {
        accept();
        return;
      }
    }
    accept(new Error('Unsupported action'));
  });
  socket.on('error', () => socket.disconnect(true));
  next();
});

class RequestError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function payload(request: AsyncIterable<Buffer>): Promise<Record<string, unknown>> {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 4096) throw new RequestError(413, '请求太长');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {
    // Use the same error for malformed JSON and non-object input.
  }
  throw new RequestError(400, '请求格式错误');
}

function nickname(value: unknown): string {
  if (typeof value !== 'string') throw new RequestError(400, '请输入昵称');
  const name = value.trim();
  if (!name || Array.from(name).length > 16 || /[\p{C}]/u.test(name)) throw new RequestError(400, '昵称须为 1–16 个可见字符');
  return name;
}

function activateMatch(id: string, capacity: number, members: Member[]) {
  const match = createMatch({ game: moonIsles, numPlayers: capacity, setupData: { names: members.map(({ name }) => name) }, unlisted: true });
  if ('setupDataError' in match) throw new Error(match.setupDataError);
  for (const { seat, name } of members) Object.assign(match.metadata.players[seat], { name, credentials: token() });
  db.createMatch(id, match);
  db.markStarted(id);
}

app.use(async (ctx) => {
  ctx.set('X-Content-Type-Options', 'nosniff');
  ctx.set('Referrer-Policy', 'no-referrer');
  ctx.set('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  if (base && ctx.path === base) {
    ctx.redirect(`${base}/${ctx.search}`);
    return;
  }
  if (!ctx.path.startsWith(`${base}/`)) return;
  const path = ctx.path.slice(base.length);
  if ((ctx.method === 'GET' || ctx.method === 'HEAD') && files.has(path)) {
    const file = files.get(path)!;
    ctx.set('Content-Type', file.type);
    ctx.set('Cache-Control', path === '/' ? 'no-cache' : 'public, max-age=31536000, immutable');
    ctx.body = file.body;
    return;
  }
  ctx.set('Cache-Control', 'no-store');
  try {
    if (ctx.method === 'GET' && path === '/health') {
      db.database.prepare('SELECT 1').get();
      ctx.body = { ok: true };
      return;
    }
    if (ctx.method === 'POST') {
      const source = ctx.get('Origin');
      if (source && source !== origin) throw new RequestError(403, '请求来源不符');
      if (!ctx.is('application/json')) throw new RequestError(415, '请求格式错误');
    }
    const existing = cookieValue(ctx.get('Cookie'));
    const memberSession = existing ? digest(existing) : undefined;
    const newSession = () => {
      const value = existing ?? token();
      ctx.cookies.set(cookie, value, { httpOnly: true, sameSite: 'strict', secure, path: `${base}/`, maxAge: 365 * 86400_000, overwrite: true });
      return digest(value);
    };
    if (ctx.method === 'POST' && path === '/api/rooms') {
      const { name, capacity, mode } = await payload(ctx.req);
      if (capacity !== 2 && capacity !== 3 && capacity !== 4) throw new RequestError(400, '请选择 2–4 个席位');
      if (mode !== undefined && mode !== 'solo') throw new RequestError(400, '未知游戏模式');
      const solo = mode === 'solo';
      const playerName = nickname(solo && (name === undefined || (typeof name === 'string' && !name.trim())) ? '船长' : name);
      const id = randomBytes(12).toString('base64url');
      const session = newSession();
      db.transaction(() => {
        db.createRoom(id, capacity, playerName, session);
        if (solo) {
          const botNames = ['雾帆', '星砂', '归潮'];
          for (let seat = 1; seat < capacity; seat++) db.addMember(id, seat, botNames[seat - 1], token(), true);
          activateMatch(id, capacity, db.members(id));
        }
      });
      ctx.status = 201;
      ctx.body = { id };
      return;
    }

    const route = /^\/api\/rooms\/([A-Za-z0-9_-]{16})(?:\/(join|start|result))?$/.exec(path);
    if (!route) throw new RequestError(404, '页面不存在');
    const [, id, operation] = route;
    const room = db.room(id);
    if (!room) throw new RequestError(404, '找不到这个房间');
    const member = memberSession ? db.member(id, memberSession) : undefined;

    if (ctx.method === 'GET' && !operation) {
      const result = member && room.started ? db.result(id) : undefined;
      const credentials = member && room.started && !result
        ? db.fetch(id, { metadata: true }).metadata.players[member.seat].credentials : undefined;
      ctx.body = {
        id, capacity: room.capacity, started: Boolean(room.started), finished: Boolean(result),
        seat: member?.seat ?? null, credentials,
        members: db.members(id).map(({ seat, name, is_bot }) => ({ seat, name, ...(is_bot ? { bot: true } : {}) })),
      };
    } else if (ctx.method === 'POST' && operation === 'join') {
      const { name } = await payload(ctx.req);
      if (!member) {
        const playerName = nickname(name);
        db.transaction(() => {
          const members = db.members(id);
          if (memberSession && db.member(id, memberSession)) return;
          if (db.room(id)?.started || members.length >= room.capacity) throw new RequestError(409, '房间已经满员或开局');
          db.addMember(id, members.length, playerName, newSession());
        });
      }
      ctx.body = { id };
    } else if (ctx.method === 'POST' && operation === 'start') {
      if (member?.seat !== 0) throw new RequestError(403, '只有房主可以开局');
      if (!room.started) {
        const members = db.members(id);
        if (members.length !== room.capacity) throw new RequestError(409, '请等所有玩家入座');
        db.transaction(() => activateMatch(id, room.capacity, members));
      }
      ctx.body = { id };
    } else if (ctx.method === 'GET' && operation === 'result') {
      if (!member) throw new RequestError(403, '请在原浏览器中查看这场航程');
      const result = db.result(id);
      if (!result) throw new RequestError(409, '结算尚未完成');
      ctx.body = result;
    } else {
      throw new RequestError(405, '请求方法错误');
    }
  } catch (error) {
    if (!(error instanceof RequestError)) {
      console.error(error);
      ctx.status = 500;
      ctx.body = { error: '服务暂时不可用' };
      return;
    }
    ctx.status = error.status;
    ctx.body = { error: error.message };
  }
});

app.proxy = process.env.TRUST_PROXY === '1';
app.listen(port, host, () => {
  for (const { id } of db.pendingBotTurns()) scheduleBot(id);
  console.log(`Moon Isles listening on ${host}:${port}${base}/`);
});
