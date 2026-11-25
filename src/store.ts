import { DatabaseSync } from 'node:sqlite';
import { createRequire } from 'node:module';
import type { State, LogEntry } from 'boardgame.io';
import type { CreateMatchOpts, FetchOpts, FetchResult, Sync as Storage } from 'boardgame.io/dist/types/src/server/db/base.js';
import type { GameState, Result } from './rules.ts';

const require = createRequire(import.meta.url);
export const { createMatch, Sync } = require('boardgame.io/internal') as typeof import('boardgame.io/dist/types/packages/internal.js');
type Metadata = CreateMatchOpts['metadata'];
type MatchRow = { state: string; initial: string; metadata: string; log: string };
export type Room = { id: string; capacity: number; started: number };
export type Member = { seat: number; name: string; session: string; is_bot: number };

export class MatchStore extends Sync implements Storage {
  database: DatabaseSync;
  onStateWritten?: (id: string, state: State<GameState>) => void;

  constructor(path: string) {
    super();
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY, capacity INTEGER NOT NULL, started INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS seats (
        room TEXT NOT NULL REFERENCES rooms(id), seat INTEGER NOT NULL, name TEXT NOT NULL,
        session TEXT NOT NULL, PRIMARY KEY(room, seat), UNIQUE(room, session)
      );
      CREATE TABLE IF NOT EXISTS bot_seats (
        room TEXT NOT NULL, seat INTEGER NOT NULL, PRIMARY KEY(room, seat),
        FOREIGN KEY(room, seat) REFERENCES seats(room, seat) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS matches (
        id TEXT PRIMARY KEY REFERENCES rooms(id), state TEXT NOT NULL, initial TEXT NOT NULL,
        metadata TEXT NOT NULL, log TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS results (
        id TEXT PRIMARY KEY REFERENCES matches(id), finished_at TEXT NOT NULL, result TEXT NOT NULL
      );
    `);
  }

  connect() {}

  transaction<T>(fn: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const value = fn();
      this.database.exec('COMMIT');
      return value;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  createRoom(id: string, capacity: number, name: string, session: string) {
    this.database.prepare('INSERT INTO rooms (id, capacity) VALUES (?, ?)').run(id, capacity);
    this.addMember(id, 0, name, session);
  }

  room(id: string) {
    return this.database.prepare('SELECT id, capacity, started FROM rooms WHERE id = ?').get(id) as Room | undefined;
  }

  members(id: string) {
    return this.database.prepare(`
      SELECT s.seat, s.name, s.session, b.seat IS NOT NULL AS is_bot
      FROM seats s LEFT JOIN bot_seats b ON b.room = s.room AND b.seat = s.seat
      WHERE s.room = ? ORDER BY s.seat
    `).all(id) as Member[];
  }

  member(id: string, session: string) {
    return this.database.prepare(`
      SELECT s.seat, s.name, s.session, b.seat IS NOT NULL AS is_bot
      FROM seats s LEFT JOIN bot_seats b ON b.room = s.room AND b.seat = s.seat
      WHERE s.room = ? AND s.session = ?
    `).get(id, session) as Member | undefined;
  }

  addMember(id: string, seat: number, name: string, session: string, bot = false) {
    this.database.prepare('INSERT INTO seats VALUES (?, ?, ?, ?)').run(id, seat, name, session);
    if (bot) this.database.prepare('INSERT INTO bot_seats VALUES (?, ?)').run(id, seat);
  }

  isBot(id: string, seat: number) {
    return Boolean(this.database.prepare('SELECT 1 FROM bot_seats WHERE room = ? AND seat = ?').get(id, seat));
  }

  pendingBotTurns() {
    return this.database.prepare(`
      SELECT m.id FROM matches m JOIN bot_seats b
        ON b.room = m.id AND b.seat = CAST(json_extract(m.state, '$.ctx.currentPlayer') AS INTEGER)
      LEFT JOIN results r ON r.id = m.id
      WHERE r.id IS NULL
    `).all() as { id: string }[];
  }

  markStarted(id: string) {
    this.database.prepare('UPDATE rooms SET started = 1 WHERE id = ?').run(id);
  }

  createMatch(id: string, { initialState, metadata }: CreateMatchOpts) {
    const state = JSON.stringify(initialState);
    this.database.prepare('INSERT INTO matches VALUES (?, ?, ?, ?, ?)').run(id, state, state, JSON.stringify(metadata), '[]');
  }

  setState(id: string, state: State<GameState>, deltalog?: LogEntry[]) {
    this.transaction(() => {
      const { log = [] } = this.fetch(id, { log: true });
      const update = this.database.prepare('UPDATE matches SET state = ?, log = ? WHERE id = ?')
        .run(JSON.stringify(state), JSON.stringify(log.concat(deltalog ?? [])), id);
      if (update.changes !== 1) throw new Error('Cannot save an unknown match');
      if (state.G.result) {
        this.database.prepare('INSERT INTO results VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING')
          .run(id, new Date().toISOString(), JSON.stringify(state.G.result));
      }
    });
    this.onStateWritten?.(id, state);
  }

  setMetadata(id: string, metadata: Metadata) {
    this.database.prepare('UPDATE matches SET metadata = ? WHERE id = ?').run(JSON.stringify(metadata), id);
  }

  fetch<O extends FetchOpts>(id: string, opts: O): FetchResult<O> {
    const row = this.database.prepare('SELECT state, initial, metadata, log FROM matches WHERE id = ?').get(id) as MatchRow | undefined;
    if (!row) return {} as FetchResult<O>;
    return {
      ...(opts.state ? { state: JSON.parse(row.state) } : {}),
      ...(opts.initialState ? { initialState: JSON.parse(row.initial) } : {}),
      ...(opts.metadata ? { metadata: JSON.parse(row.metadata) } : {}),
      ...(opts.log ? { log: JSON.parse(row.log) } : {}),
    } as FetchResult<O>;
  }

  result(id: string): { finishedAt: string; result: Result } | undefined {
    const row = this.database.prepare('SELECT finished_at, result FROM results WHERE id = ?').get(id);
    if (!row) return undefined;
    return { finishedAt: row.finished_at as string, result: JSON.parse(row.result as string) };
  }

  wipe(id: string) {
    this.transaction(() => {
      this.database.prepare('DELETE FROM results WHERE id = ?').run(id);
      this.database.prepare('DELETE FROM matches WHERE id = ?').run(id);
      this.database.prepare('DELETE FROM seats WHERE room = ?').run(id);
      this.database.prepare('DELETE FROM rooms WHERE id = ?').run(id);
    });
  }
}
