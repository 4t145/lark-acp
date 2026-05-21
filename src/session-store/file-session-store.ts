import fs from "node:fs";
import path from "node:path";
import type { SessionRecord, SessionStore } from "./session-store.js";

const SESSIONS_FILE_NAME = "sessions.json";

/** Pre-multi-session legacy on-disk shape. */
interface LegacyRecord {
  sessionId: string;
  cwd: string;
  updatedAt: number;
}

/**
 * JSON-file backed {@link SessionStore}. Writes are coalesced via
 * `setImmediate` so a burst of `save()` calls produces one fsync.
 */
export class FileSessionStore implements SessionStore {
  private readonly filePath: string;
  private readonly data = new Map<string, SessionRecord[]>();
  private flushScheduled = false;

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, SESSIONS_FILE_NAME);
  }

  async init(): Promise<void> {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    if (!fs.existsSync(this.filePath)) return;

    let parsed: unknown;
    try {
      const raw = fs.readFileSync(this.filePath, "utf-8");
      parsed = JSON.parse(raw);
    } catch {
      // Corrupt file — treat as empty rather than crashing.
      return;
    }

    if (!parsed || typeof parsed !== "object") return;

    const record = parsed as Record<string, unknown>;
    const firstValue = Object.values(record)[0];

    const isLegacy =
      firstValue !== undefined &&
      typeof firstValue === "object" &&
      firstValue !== null &&
      "sessionId" in (firstValue as Record<string, unknown>) &&
      !("chatId" in (firstValue as Record<string, unknown>));

    if (isLegacy) {
      this.migrateLegacy(record as Record<string, LegacyRecord>);
      return;
    }

    for (const [chatId, entries] of Object.entries(record)) {
      if (Array.isArray(entries)) {
        this.data.set(chatId, entries as SessionRecord[]);
      }
    }
  }

  async close(): Promise<void> {
    // No persistent handles — writes are synchronous.
  }

  async listByChat(chatId: string): Promise<readonly SessionRecord[]> {
    const records = this.data.get(chatId);
    if (!records) return [];
    return [...records].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async getLatest(chatId: string): Promise<SessionRecord | null> {
    const records = this.data.get(chatId);
    if (!records?.length) return null;
    return records.reduce((a, b) => (a.updatedAt > b.updatedAt ? a : b));
  }

  async save(record: SessionRecord): Promise<void> {
    let records = this.data.get(record.chatId);
    if (!records) {
      records = [];
      this.data.set(record.chatId, records);
    }
    const idx = records.findIndex((r) => r.sessionId === record.sessionId);
    if (idx >= 0) records[idx] = record;
    else records.push(record);
    this.scheduleFlush();
  }

  async delete(chatId: string, sessionId: string): Promise<void> {
    const records = this.data.get(chatId);
    if (!records) return;
    const idx = records.findIndex((r) => r.sessionId === sessionId);
    if (idx < 0) return;
    records.splice(idx, 1);
    if (!records.length) this.data.delete(chatId);
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushScheduled) return;
    this.flushScheduled = true;
    setImmediate(() => {
      this.flushScheduled = false;
      const obj: Record<string, SessionRecord[]> = {};
      for (const [chatId, records] of this.data) {
        obj[chatId] = records;
      }
      fs.writeFileSync(this.filePath, JSON.stringify(obj, null, 2), "utf-8");
    });
  }

  private migrateLegacy(legacy: Record<string, LegacyRecord>): void {
    for (const [oldKey, val] of Object.entries(legacy)) {
      this.data.set(oldKey, [
        {
          chatId: oldKey,
          sessionId: val.sessionId,
          agentCommand: "",
          agentArgs: [],
          cwd: val.cwd,
          createdAt: val.updatedAt,
          updatedAt: val.updatedAt,
        },
      ]);
    }
    this.scheduleFlush();
  }
}
