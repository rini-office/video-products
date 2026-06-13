import Database from 'better-sqlite3';
import path from 'path';

const isVercel = !!process.env.VERCEL;
const DB_PATH = isVercel
  ? path.join('/tmp', 'pipeline.db')
  : path.join(process.cwd(), 'data', 'pipeline.db');

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    const fs = require('fs');
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    initializeSchema(db);
  }
  return db;
}

function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      source_file_name TEXT NOT NULL,
      source_file_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      kie_task_id TEXT,
      output_url TEXT,
      output_file_id TEXT,
      image_prompt TEXT,
      image_output_file_id TEXT,
      image_gen_task_id TEXT,
      duration INTEGER DEFAULT 8,
      resolution TEXT DEFAULT '1080p',
      error TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS processed_files (
      file_id TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrate: add missing columns for older DBs
  migrateSchema(db);
}

function migrateSchema(db: Database.Database): void {
  const existingCols = db.prepare("PRAGMA table_info('jobs')").all() as { name: string }[];
  const colNames = new Set(existingCols.map((c) => c.name));

  const migrations: { col: string; def: string }[] = [
    { col: 'image_prompt', def: 'TEXT' },
    { col: 'image_output_file_id', def: 'TEXT' },
    { col: 'image_gen_task_id', def: 'TEXT' },
  ];

  for (const { col, def } of migrations) {
    if (!colNames.has(col)) {
      db.exec(`ALTER TABLE jobs ADD COLUMN ${col} ${def}`);
    }
  }

  // Migrate old config key: drive_source_folder → drive_image_output_folder
  const oldVal = db.prepare("SELECT value FROM config WHERE key = 'drive_source_folder'").get() as { value: string } | undefined;
  if (oldVal?.value) {
    const newExists = db.prepare("SELECT 1 FROM config WHERE key = 'drive_image_output_folder'").get();
    if (!newExists) {
      db.prepare("INSERT OR REPLACE INTO config (key, value, updated_at) VALUES ('drive_image_output_folder', ?, datetime('now'))").run(oldVal.value);
    }
  }
}

export interface Job {
  id: string;
  source_file_name: string;
  source_file_id: string;
  status: 'pending' | 'queued' | 'processing_image' | 'processing_video' | 'completed' | 'failed';
  kie_task_id: string | null;
  output_url: string | null;
  output_file_id: string | null;
  image_prompt: string | null;
  image_output_file_id: string | null;
  image_gen_task_id: string | null;
  duration: number;
  resolution: string;
  error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export function createJob(job: Omit<Job, 'created_at' | 'updated_at' | 'completed_at'>): Job {
  const database = getDb();
  const stmt = database.prepare(`
    INSERT INTO jobs (id, source_file_name, source_file_id, status, kie_task_id, output_url, output_file_id, image_prompt, image_output_file_id, image_gen_task_id, duration, resolution, error)
    VALUES (@id, @source_file_name, @source_file_id, @status, @kie_task_id, @output_url, @output_file_id, @image_prompt, @image_output_file_id, @image_gen_task_id, @duration, @resolution, @error)
  `);
  stmt.run(job);
  return getJob(job.id)!;
}

export function getJob(id: string): Job | undefined {
  const database = getDb();
  return database.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as Job | undefined;
}

export function updateJob(id: string, updates: Partial<Pick<Job, 'status' | 'source_file_id' | 'source_file_name' | 'kie_task_id' | 'output_url' | 'output_file_id' | 'image_prompt' | 'image_output_file_id' | 'image_gen_task_id' | 'error' | 'completed_at'>>): void {
  const database = getDb();
  const fields: string[] = [];
  const values: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push(value);
  }
  fields.push("updated_at = datetime('now')");
  values.push(id);

  database.prepare(`UPDATE jobs SET ${fields.join(', ')} WHERE id = ?`).run(...values);
}

export function getUnprocessedJobs(limit = 50): Job[] {
  const database = getDb();
  return database.prepare('SELECT * FROM jobs WHERE status IN (?, ?) ORDER BY created_at ASC LIMIT ?')
    .all('pending', 'queued', limit) as Job[];
}

export function getRecentJobs(limit = 20): Job[] {
  const database = getDb();
  return database.prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?').all(limit) as Job[];
}

export function getJobStats(): { total: number; completed: number; failed: number; processing_image: number; processing_video: number } {
  const database = getDb();
  const stats = database.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed,
      SUM(CASE WHEN status = 'processing_image' THEN 1 ELSE 0 END) as processing_image,
      SUM(CASE WHEN status = 'processing_video' THEN 1 ELSE 0 END) as processing_video
    FROM jobs
  `).get() as { total: number; completed: number; failed: number; processing_image: number; processing_video: number };
  return stats;
}

export function isFileProcessed(fileId: string): boolean {
  const database = getDb();
  const row = database.prepare('SELECT 1 FROM processed_files WHERE file_id = ?').get(fileId);
  return !!row;
}

export function markFileProcessed(fileId: string): void {
  const database = getDb();
  database.prepare('INSERT OR IGNORE INTO processed_files (file_id) VALUES (?)').run(fileId);
}

// Config helpers

const ENV_FALLBACKS: Record<string, string | undefined> = {
  kie_api_key: process.env.KIE_API_KEY,
  google_client_id: process.env.GOOGLE_CLIENT_ID,
  google_client_secret: process.env.GOOGLE_CLIENT_SECRET,
};

export function getConfig(key: string): string | undefined {
  const database = getDb();
  const row = database.prepare('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value || ENV_FALLBACKS[key];
}

export function setConfig(key: string, value: string): void {
  const database = getDb();
  database.prepare('INSERT OR REPLACE INTO config (key, value, updated_at) VALUES (?, ?, datetime(\'now\'))').run(key, value);
}

export function getAllConfig(): Record<string, string> {
  const database = getDb();
  const rows = database.prepare('SELECT key, value FROM config').all() as { key: string; value: string }[];
  const config: Record<string, string> = {};
  for (const row of rows) {
    config[row.key] = row.value;
  }
  return config;
}
