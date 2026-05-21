import type { SessionRecord, SessionStore } from "./session-store.js";

const TABLE_DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  chat_id       TEXT NOT NULL,
  session_id    TEXT NOT NULL,
  label         TEXT,
  agent_command TEXT NOT NULL,
  agent_args    JSONB NOT NULL DEFAULT '[]',
  cwd           TEXT NOT NULL,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  PRIMARY KEY (chat_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_sessions_chat_updated ON sessions (chat_id, updated_at DESC);
`;

const UPSERT_SQL = `
INSERT INTO sessions (chat_id, session_id, label, agent_command, agent_args, cwd, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (chat_id, session_id) DO UPDATE SET
  label = EXCLUDED.label,
  agent_command = EXCLUDED.agent_command,
  agent_args = EXCLUDED.agent_args,
  cwd = EXCLUDED.cwd,
  updated_at = EXCLUDED.updated_at
`;

interface PgPool {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}

interface PgClient {
  query(sql: string, params: unknown[]): Promise<{ rows: unknown[] }>;
  release(): void;
}

interface PgRow {
  chat_id: string;
  session_id: string;
  label: string | null;
  agent_command: string;
  agent_args: string[];
  cwd: string;
  created_at: string; // BIGINT comes back as a string from `pg`.
  updated_at: string;
}

function rowToRecord(row: PgRow): SessionRecord {
  return {
    chatId: row.chat_id,
    sessionId: row.session_id,
    label: row.label ?? undefined,
    agentCommand: row.agent_command,
    agentArgs: row.agent_args,
    cwd: row.cwd,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

/**
 * PostgreSQL-backed {@link SessionStore}.
 *
 * Requires the optional peer dependency `pg`. The dependency is loaded
 * lazily via dynamic import so the file backend works without it.
 */
export class PostgresSessionStore implements SessionStore {
  private pool: PgPool | null = null;

  constructor(private readonly url: string) {}

  /**
   * @throws when the optional `pg` package is not installed, or when
   *         creating the schema fails.
   */
  async init(): Promise<void> {
    // Indirect specifier prevents the bundler / type-checker from
    // requiring `pg` at build time; it is an optional peer dependency.
    const moduleName = "pg";
    let mod: { default?: unknown; Pool?: unknown };
    try {
      mod = (await import(moduleName)) as { default?: unknown; Pool?: unknown };
    } catch {
      throw new Error("PostgresSessionStore requires the `pg` package. Install it with `bun add pg`.");
    }
    const exports = (mod.default ?? mod) as { Pool: new (opts: { connectionString: string }) => PgPool };
    this.pool = new exports.Pool({ connectionString: this.url });
    await this.query(TABLE_DDL);
  }

  async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }

  async listByChat(chatId: string): Promise<readonly SessionRecord[]> {
    const rows = await this.query(
      "SELECT * FROM sessions WHERE chat_id = $1 ORDER BY updated_at DESC",
      [chatId],
    );
    return (rows as PgRow[]).map(rowToRecord);
  }

  async getLatest(chatId: string): Promise<SessionRecord | null> {
    const rows = await this.query(
      "SELECT * FROM sessions WHERE chat_id = $1 ORDER BY updated_at DESC LIMIT 1",
      [chatId],
    );
    const row = (rows as PgRow[])[0];
    return row ? rowToRecord(row) : null;
  }

  async save(record: SessionRecord): Promise<void> {
    await this.query(UPSERT_SQL, [
      record.chatId,
      record.sessionId,
      record.label ?? null,
      record.agentCommand,
      JSON.stringify(record.agentArgs),
      record.cwd,
      record.createdAt,
      record.updatedAt,
    ]);
  }

  async delete(chatId: string, sessionId: string): Promise<void> {
    await this.query("DELETE FROM sessions WHERE chat_id = $1 AND session_id = $2", [
      chatId,
      sessionId,
    ]);
  }

  private async query(sql: string, params: unknown[] = []): Promise<unknown[]> {
    if (!this.pool) throw new Error("PostgresSessionStore.init() has not been called");
    const client = await this.pool.connect();
    try {
      const result = await client.query(sql, params);
      return result.rows;
    } finally {
      client.release();
    }
  }
}
