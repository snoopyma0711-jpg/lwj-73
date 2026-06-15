import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';
import { promisify } from 'util';

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const dbPath = path.join(dataDir, 'locker.db');
const rawDb = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('DB open error:', err);
});

rawDb.serialize(() => {
  rawDb.run('PRAGMA journal_mode = WAL');
  rawDb.run('PRAGMA foreign_keys = ON');
});

class DB {
  private db: sqlite3.Database;
  constructor(d: sqlite3.Database) { this.db = d; }

  all<T = any>(sql: string, params: any[] = []): Promise<T[]> {
    return new Promise((res, rej) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) rej(err); else res(rows as T[]);
      });
    });
  }

  get<T = any>(sql: string, params: any[] = []): Promise<T | undefined> {
    return new Promise((res, rej) => {
      this.db.get(sql, params, (err, row) => {
        if (err) rej(err); else res(row as T | undefined);
      });
    });
  }

  run(sql: string, params: any[] = []): Promise<{ lastID: number | string; changes: number }> {
    return new Promise((res, rej) => {
      this.db.run(sql, params, function (err) {
        if (err) rej(err); else res({ lastID: this.lastID, changes: this.changes });
      });
    });
  }

  exec(sql: string): Promise<void> {
    return new Promise((res, rej) => {
      this.db.exec(sql, (err) => { if (err) rej(err); else res(); });
    });
  }

  async transaction<T>(fn: (run: (sql: string, params?: any[]) => Promise<{ lastID: number | string; changes: number }>) => Promise<T>): Promise<T> {
    await this.run('BEGIN');
    try {
      const runner = (sql: string, params: any[] = []) => this.run(sql, params);
      const result = await fn(runner);
      await this.run('COMMIT');
      return result;
    } catch (e) {
      await this.run('ROLLBACK');
      throw e;
    }
  }
}

export const db = new DB(rawDb);

export async function initDB(): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS lockers (
      id TEXT PRIMARY KEY,
      zone TEXT NOT NULL,
      row_no INTEGER NOT NULL,
      col_no INTEGER NOT NULL,
      size TEXT NOT NULL CHECK(size IN ('S','M','L')),
      status TEXT NOT NULL DEFAULT 'IDLE' CHECK(status IN ('IDLE','OCCUPIED','RESERVED','FAULT')),
      ticket_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tickets (
      id TEXT PRIMARY KEY,
      visitor_id TEXT NOT NULL,
      visitor_name TEXT NOT NULL,
      visitor_phone TEXT,
      request_type TEXT NOT NULL CHECK(request_type IN ('STORE','RETRIEVE','SWAP')),
      from_locker_id TEXT,
      to_locker_id TEXT,
      target_size TEXT CHECK(target_size IN ('S','M','L')),
      reason TEXT,
      status TEXT NOT NULL CHECK(status IN ('QUEUING','CALLED','IN_PROGRESS','COMPLETED','CANCELLED','TIMEOUT','FAULT')),
      operator TEXT,
      held_until INTEGER,
      requeue_count INTEGER NOT NULL DEFAULT 0,
      queue_position INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      completed_at INTEGER,
      result_note TEXT
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      ticket_id TEXT NOT NULL,
      action TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT,
      locker_id TEXT,
      operator TEXT,
      note TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
    CREATE INDEX IF NOT EXISTS idx_tickets_visitor ON tickets(visitor_id, status);
    CREATE INDEX IF NOT EXISTS idx_lockers_status ON lockers(status);
  `);
}

export default db;
