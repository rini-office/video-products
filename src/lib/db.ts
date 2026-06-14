import { Pool } from '@neondatabase/serverless';

// Vercel edge/Node.js auto-detection — use WebSocket for Node, HTTP fetch for edge
// In Next.js App Router with runtime='nodejs', Pool (WebSocket) is fine.

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    const DATABASE_URL = process.env.DATABASE_URL;
    if (!DATABASE_URL) {
      throw new Error('DATABASE_URL environment variable is required. Get yours at https://neon.tech');
    }
    pool = new Pool({ connectionString: DATABASE_URL });
  }
  return pool;
}

// ── Schema initialization ─────────────────────────────────────────────────

async function initializeSchema(): Promise<void> {
  const p = getPool();
  await p.query(`
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
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS processed_files (
      file_id TEXT PRIMARY KEY,
      processed_at TEXT NOT NULL
    );
  `);

  // Run migrations for existing databases
  await migrateSchema(p);
}

async function migrateSchema(p: Pool): Promise<void> {
  // Add missing columns for older DBs
  const { rows: existingCols } = await p.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns WHERE table_name = 'jobs'`
  );
  const colNames = new Set(existingCols.map((c) => c.column_name));

  const migrations: { col: string; def: string }[] = [
    { col: 'image_prompt', def: 'TEXT' },
    { col: 'image_output_file_id', def: 'TEXT' },
    { col: 'image_gen_task_id', def: 'TEXT' },
  ];

  for (const { col, def } of migrations) {
    if (!colNames.has(col)) {
      await p.query(`ALTER TABLE jobs ADD COLUMN ${col} ${def}`);
    }
  }

  // Migrate old config key: drive_source_folder → drive_image_output_folder
  const { rows: oldRows } = await p.query<{ value: string }>(
    `SELECT value FROM config WHERE key = 'drive_source_folder'`
  );
  if (oldRows.length > 0 && oldRows[0].value) {
    const { rows: newRows } = await p.query(
      `SELECT 1 FROM config WHERE key = 'drive_image_output_folder'`
    );
    if (newRows.length === 0) {
      await p.query(
        `INSERT INTO config (key, value, updated_at) VALUES ('drive_image_output_folder', $1, $2)
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = $2`,
        [oldRows[0].value, new Date().toISOString()]
      );
    }
  }
}

// schemaInitPromise ensures schema is ready before any query
let schemaInitPromise: Promise<void> | null = null;

async function ensureSchema(): Promise<void> {
  if (!schemaInitPromise) {
    schemaInitPromise = initializeSchema();
  }
  await schemaInitPromise;
}

// ── Job type ──────────────────────────────────────────────────────────────

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

// ── Job CRUD ──────────────────────────────────────────────────────────────

export async function createJob(job: Omit<Job, 'created_at' | 'updated_at' | 'completed_at'>): Promise<Job> {
  await ensureSchema();
  const now = new Date().toISOString();
  const p = getPool();
  await p.query(
    `INSERT INTO jobs (id, source_file_name, source_file_id, status, kie_task_id, output_url, output_file_id, image_prompt, image_output_file_id, image_gen_task_id, duration, resolution, error, created_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      job.id, job.source_file_name, job.source_file_id, job.status,
      job.kie_task_id, job.output_url, job.output_file_id, job.image_prompt,
      job.image_output_file_id, job.image_gen_task_id, job.duration,
      job.resolution, job.error, now, now,
    ]
  );
  return (await getJob(job.id))!;
}

export async function getJob(id: string): Promise<Job | undefined> {
  await ensureSchema();
  const p = getPool();
  const { rows } = await p.query<Job>('SELECT * FROM jobs WHERE id = $1', [id]);
  return rows[0];
}

export async function updateJob(
  id: string,
  updates: Partial<Pick<Job, 'status' | 'source_file_id' | 'source_file_name' | 'kie_task_id' | 'output_url' | 'output_file_id' | 'image_prompt' | 'image_output_file_id' | 'image_gen_task_id' | 'error' | 'completed_at'>>
): Promise<void> {
  await ensureSchema();
  const p = getPool();
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIdx = 1;

  for (const [key, value] of Object.entries(updates)) {
    setClauses.push(`${key} = $${paramIdx}`);
    values.push(value);
    paramIdx++;
  }
  setClauses.push(`updated_at = $${paramIdx}`);
  values.push(new Date().toISOString());
  paramIdx++;
  values.push(id);

  await p.query(`UPDATE jobs SET ${setClauses.join(', ')} WHERE id = $${paramIdx}`, values);
}

export async function getUnprocessedJobs(limit = 50): Promise<Job[]> {
  await ensureSchema();
  const p = getPool();
  const { rows } = await p.query<Job>(
    'SELECT * FROM jobs WHERE status IN ($1, $2) ORDER BY created_at ASC LIMIT $3',
    ['pending', 'queued', limit]
  );
  return rows;
}

export async function getRecentJobs(limit = 20): Promise<Job[]> {
  await ensureSchema();
  const p = getPool();
  const { rows } = await p.query<Job>(
    'SELECT * FROM jobs ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return rows;
}

export async function getJobStats(): Promise<{
  total: number; completed: number; failed: number; processing_image: number; processing_video: number;
}> {
  await ensureSchema();
  const p = getPool();
  const { rows } = await p.query<{
    total: string; completed: string; failed: string; processing_image: string; processing_video: string;
  }>(
    `SELECT
       COUNT(*) as total,
       COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) as completed,
       COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) as failed,
       COALESCE(SUM(CASE WHEN status = 'processing_image' THEN 1 ELSE 0 END), 0) as processing_image,
       COALESCE(SUM(CASE WHEN status = 'processing_video' THEN 1 ELSE 0 END), 0) as processing_video
     FROM jobs`
  );
  const r = rows[0];
  return {
    total: parseInt(r.total),
    completed: parseInt(r.completed),
    failed: parseInt(r.failed),
    processing_image: parseInt(r.processing_image),
    processing_video: parseInt(r.processing_video),
  };
}

export async function isFileProcessed(fileId: string): Promise<boolean> {
  await ensureSchema();
  const p = getPool();
  const { rows } = await p.query('SELECT 1 FROM processed_files WHERE file_id = $1', [fileId]);
  return rows.length > 0;
}

export async function markFileProcessed(fileId: string): Promise<void> {
  await ensureSchema();
  const p = getPool();
  await p.query(
    'INSERT INTO processed_files (file_id, processed_at) VALUES ($1, $2) ON CONFLICT (file_id) DO NOTHING',
    [fileId, new Date().toISOString()]
  );
}

// ── Config helpers ────────────────────────────────────────────────────────

const ENV_FALLBACKS: Record<string, string | undefined> = {
  kie_api_key: process.env.KIE_API_KEY,
  google_client_id: process.env.GOOGLE_CLIENT_ID,
  google_client_secret: process.env.GOOGLE_CLIENT_SECRET,
};

export async function getConfig(key: string): Promise<string | undefined> {
  await ensureSchema();
  const p = getPool();
  const { rows } = await p.query<{ value: string }>(
    'SELECT value FROM config WHERE key = $1', [key]
  );
  return rows[0]?.value || ENV_FALLBACKS[key];
}

export async function setConfig(key: string, value: string): Promise<void> {
  await ensureSchema();
  const p = getPool();
  await p.query(
    `INSERT INTO config (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = $3`,
    [key, value, new Date().toISOString()]
  );
}

export async function getAllConfig(): Promise<Record<string, string>> {
  await ensureSchema();
  const p = getPool();
  const { rows } = await p.query<{ key: string; value: string }>(
    'SELECT key, value FROM config'
  );
  const config: Record<string, string> = {};
  for (const row of rows) {
    config[row.key] = row.value;
  }
  return config;
}

// ── Raw pool access (for complex queries in routes) ───────────────────────

export async function getDb(): Promise<Pool> {
  await ensureSchema();
  return getPool();
}

// ── Cleanup for graceful shutdown ─────────────────────────────────────────

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    schemaInitPromise = null;
  }
}
