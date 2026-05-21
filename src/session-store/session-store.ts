/**
 * Persistent mapping from `chatId` → ACP session(s), used so the bridge can
 * resume the agent's conversation across process restarts.
 *
 * The library does **not** ship a default — callers must construct one of
 * {@link FileSessionStore}, {@link PostgresSessionStore}, or their own
 * implementation, and pass it to `LarkBridge`.
 */

export interface SessionRecord {
  chatId: string;
  sessionId: string;
  label?: string;
  agentCommand: string;
  agentArgs: string[];
  cwd: string;
  createdAt: number;
  updatedAt: number;
}

export interface SessionStore {
  /**
   * Open / verify the underlying resource. Must be called before any other
   * method.
   *
   * @throws when the underlying resource (file system, database) cannot be
   *         initialised.
   */
  init(): Promise<void>;

  /** Release any open handles. */
  close(): Promise<void>;

  /** All sessions for a chat, sorted by `updatedAt` descending. */
  listByChat(chatId: string): Promise<readonly SessionRecord[]>;

  /** Most recently updated session for a chat, or `null` if none. */
  getLatest(chatId: string): Promise<SessionRecord | null>;

  /** Upsert a record (key: `chatId` + `sessionId`). */
  save(record: SessionRecord): Promise<void>;

  delete(chatId: string, sessionId: string): Promise<void>;
}
