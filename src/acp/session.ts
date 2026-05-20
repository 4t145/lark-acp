/**
 * Per-user ACP session manager.
 * Each Feishu user gets their own agent subprocess + ACP session.
 * Messages are serialized per user via a queue.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { FeishuAcpClient } from "./client.js";
import { spawnAgent, spawnAndResumeAgent, killAgent, type AgentProcessInfo } from "./agent-manager.js";
import { SessionStore } from "./session-store.js";

export interface PendingMessage {
  prompt: acp.ContentBlock[];
  messageId: string; // Feishu message ID for reply threading
  chatId: string;
}

interface UserSession {
  userId: string;
  client: FeishuAcpClient;
  agentInfo: AgentProcessInfo;
  queue: PendingMessage[];
  processing: boolean;
  lastActivity: number;
}

export interface SessionManagerOpts {
  agentCommand: string;
  agentArgs: string[];
  agentCwd: string;
  agentEnv?: Record<string, string>;
  agentPreset?: string;
  storageDir: string;
  idleTimeoutMs: number;
  maxConcurrentUsers: number;
  showThoughts: boolean;
  log: (msg: string) => void;
  onReply: (messageId: string, chatId: string, text: string) => Promise<void>;
  onTyping: (messageId: string) => Promise<string | null>;
  onStopTyping: (messageId: string, reactionId: string) => Promise<void>;
  sendInterruptCard: (messageId: string, params: acp.RequestPermissionRequest, requestId: string) => Promise<void>;
}

/** Maps agent presets to auth remediation hints. */
const AUTH_HINTS: Record<string, string> = {
  claude: 'Run "claude" in a terminal and complete the login flow first.',
  copilot: 'Run "gh auth login" to authenticate GitHub Copilot CLI.',
  codex: 'Set the OPENAI_API_KEY environment variable or run "codex" to authenticate.',
  gemini: 'Run "gemini" in a terminal and complete the login flow first.',
};

export class SessionManager {
  private sessions = new Map<string, UserSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private aborted = false;
  private opts: SessionManagerOpts;
  private store: SessionStore;

  constructor(opts: SessionManagerOpts) {
    this.opts = opts;
    this.store = new SessionStore(opts.storageDir);
  }

  start(): void {
    this.cleanupTimer = setInterval(() => this.cleanupIdle(), 2 * 60_000);
    this.cleanupTimer.unref();
  }

  async stop(): Promise<void> {
    this.aborted = true;
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    for (const [userId, s] of this.sessions) {
      this.opts.log(`Stopping session for ${userId}`);
      killAgent(s.agentInfo.process);
    }
    this.sessions.clear();
  }

  async enqueue(userId: string, message: PendingMessage): Promise<void> {
    let session = this.sessions.get(userId);

    if (!session) {
      if (this.sessions.size >= this.opts.maxConcurrentUsers) this.evictOldest();
      session = await this.createSession(userId, message);
      this.sessions.set(userId, session);
    }

    session.lastActivity = Date.now();
    session.queue.push(message);

    if (!session.processing) {
      session.processing = true;
      this.processQueue(session).catch((err) => {
        this.opts.log(`[${userId}] queue error: ${String(err)}`);
      });
    }
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  /** Cancel the current agent prompt and clear the queue for a user. */
  async cancelSession(userId: string): Promise<void> {
    const session = this.sessions.get(userId);
    if (!session) return;

    this.opts.log(`[${userId}] Cancelling current task`);

    // Cancel any in-flight permission request first (so requestPermission returns)
    session.client.cancelPendingPermission();

    // Notify the agent to cancel
    try {
      await session.agentInfo.connection.cancel({ sessionId: session.agentInfo.sessionId });
    } catch (err) {
      this.opts.log(`[${userId}] cancel notification error: ${String(err)}`);
    }

    // Clear remaining messages in queue
    session.queue.length = 0;
  }

  /** Handle a card action event — resolve the pending permission request. */
  handleCardAction(openId: string, requestId: string, optionId: string): boolean {
    const session = this.sessions.get(openId);
    if (!session) return false;
    return session.client.handleCardAction(requestId, optionId);
  }

  private async createSession(userId: string, firstMessage: PendingMessage): Promise<UserSession> {
    this.opts.log(`Creating session for user ${userId}`);

    const client = new FeishuAcpClient({
      onTyping: () => this.opts.onTyping(firstMessage.messageId).then(() => {}),
      onThought: (text) => this.opts.onReply(firstMessage.messageId, firstMessage.chatId, text),
      showThoughts: this.opts.showThoughts,
      sendInterruptCard: this.opts.sendInterruptCard,
      log: (msg) => this.opts.log(`[${userId}] ${msg}`),
    });

    const spawnOpts = {
      command: this.opts.agentCommand,
      args: this.opts.agentArgs,
      cwd: this.opts.agentCwd,
      env: this.opts.agentEnv,
      client,
      log: (msg: string) => this.opts.log(`[${userId}] ${msg}`),
    };

    // Try to resume a previous session from the store
    let agentInfo: AgentProcessInfo;
    const previous = this.store.get(userId);
    if (previous) {
      this.opts.log(`[${userId}] Found previous session ${previous.sessionId}, attempting resume...`);
      const result = await spawnAndResumeAgent(spawnOpts, previous.sessionId);
      agentInfo = result.agentInfo;
      if (result.resumed) {
        this.opts.log(`[${userId}] Resumed previous session ${previous.sessionId}`);
      } else {
        this.opts.log(`[${userId}] Could not resume, started new session ${agentInfo.sessionId}`);
      }
    } else {
      agentInfo = await spawnAgent(spawnOpts);
    }

    // Persist the session mapping
    this.store.set(userId, {
      sessionId: agentInfo.sessionId,
      cwd: this.opts.agentCwd,
      updatedAt: Date.now(),
    });

    agentInfo.process.on("exit", () => {
      const s = this.sessions.get(userId);
      if (s?.agentInfo.process === agentInfo.process) {
        this.opts.log(`Agent for ${userId} exited, cleaning up session`);
        this.sessions.delete(userId);
      }
    });

    return {
      userId,
      client,
      agentInfo,
      queue: [],
      processing: false,
      lastActivity: Date.now(),
    };
  }

  private async processQueue(session: UserSession): Promise<void> {
    try {
      while (session.queue.length > 0 && !this.aborted) {
        const pending = session.queue.shift()!;

        // Point callbacks at current message
        session.client.updateCallbacks({
          onTyping: () => this.opts.onTyping(pending.messageId).then(() => {}),
          onThought: (text) => this.opts.onReply(pending.messageId, pending.chatId, text),
        });

        await session.client.flush(); // reset buffers

        // Set current message context for permission card routing
        session.client.setContext(pending.messageId);

        try {
          const reactionId = await this.opts.onTyping(pending.messageId).catch(() => null);
          this.opts.log(`[${session.userId}] Sending prompt to agent`);
          const result = await session.agentInfo.connection.prompt({
            sessionId: session.agentInfo.sessionId,
            prompt: pending.prompt,
          });

          // Remove the thinking reaction now that we have a reply
          if (reactionId) {
            this.opts.onStopTyping(pending.messageId, reactionId).catch(() => {});
          }

          let reply = await session.client.flush();
          if (result.stopReason === "cancelled") reply += "\n[cancelled]";
          else if (result.stopReason === "refusal") reply += "\n[agent refused]";

          this.opts.log(`[${session.userId}] Done (${result.stopReason}), ${reply.length} chars`);

          if (reply.trim()) {
            await this.opts.onReply(pending.messageId, pending.chatId, reply);
          }
        } catch (err) {
          const errMsg = formatAgentError(err);

          // Drop the session if the process died or authentication failed
          const isAuthError = isAuthenticationError(err);
          if (isAuthError || session.agentInfo.process.killed || session.agentInfo.process.exitCode !== null) {
            killAgent(session.agentInfo.process);
            this.sessions.delete(session.userId);

            if (isAuthError) {
              const preset = this.opts.agentPreset ?? "";
              const hint = AUTH_HINTS[preset] ?? `Ensure the agent (${this.opts.agentCommand}) is authenticated before starting lark-acp.`;
              this.opts.log(`[${session.userId}] Agent authentication failed. ${hint}`);
              await this.opts.onReply(
                pending.messageId,
                pending.chatId,
                `⚠️ Agent authentication failed.\n${hint}`,
              ).catch(() => {});
            } else {
              this.opts.log(`[${session.userId}] Agent crashed: ${errMsg}`);
              await this.opts.onReply(
                pending.messageId,
                pending.chatId,
                `⚠️ Agent crashed: ${errMsg}`,
              ).catch(() => {});
            }
            return;
          }

          this.opts.log(`[${session.userId}] Agent error: ${errMsg}`);
          await this.opts
            .onReply(pending.messageId, pending.chatId, `⚠️ Agent error: ${errMsg}`)
            .catch(() => {});
        }
      }
    } finally {
      session.processing = false;
    }
  }

  private cleanupIdle(): void {
    if (this.opts.idleTimeoutMs <= 0) return;
    const now = Date.now();
    for (const [userId, s] of this.sessions) {
      if (!s.processing && now - s.lastActivity > this.opts.idleTimeoutMs) {
        const idleMin = Math.round((now - s.lastActivity) / 60_000);
        this.opts.log(`Session ${userId} idle ${idleMin}min, evicting`);
        killAgent(s.agentInfo.process);
        this.sessions.delete(userId);
      }
    }
  }

  private evictOldest(): void {
    let oldest: { userId: string; lastActivity: number } | null = null;
    for (const [userId, s] of this.sessions) {
      if (!s.processing && (!oldest || s.lastActivity < oldest.lastActivity)) {
        oldest = { userId, lastActivity: s.lastActivity };
      }
    }
    if (oldest) {
      this.opts.log(`Max sessions reached, evicting ${oldest.userId}`);
      const s = this.sessions.get(oldest.userId);
      if (s) killAgent(s.agentInfo.process);
      this.sessions.delete(oldest.userId);
    }
  }
}

/** Extract a human-readable message from any thrown value. */
function formatAgentError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e["message"] === "string") return e["message"];
    return JSON.stringify(err);
  }
  return String(err);
}

/** Returns true if the error is a JSON-RPC "Authentication required" error. */
function isAuthenticationError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  // ACP SDK throws RequestError (extends Error) with code -32000 for auth failures
  if (typeof e["code"] === "number" && e["code"] === -32000) return true;
  if (typeof e["message"] === "string" && /auth(entication)? required/i.test(e["message"])) return true;
  return false;
}
