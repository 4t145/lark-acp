/**
 * Per-user ACP session manager.
 * Each Feishu user gets their own agent subprocess + ACP session.
 * Messages are serialized per user via a queue.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { FeishuAcpClient } from "./client.js";
import { spawnAgent, killAgent, type AgentProcessInfo } from "./agent-manager.js";

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
  idleTimeoutMs: number;
  maxConcurrentUsers: number;
  showThoughts: boolean;
  log: (msg: string) => void;
  onReply: (messageId: string, chatId: string, text: string) => Promise<void>;
  onTyping: (messageId: string) => Promise<void>;
}

export class SessionManager {
  private sessions = new Map<string, UserSession>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private aborted = false;
  private opts: SessionManagerOpts;

  constructor(opts: SessionManagerOpts) {
    this.opts = opts;
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

  private async createSession(userId: string, firstMessage: PendingMessage): Promise<UserSession> {
    this.opts.log(`Creating session for user ${userId}`);

    const client = new FeishuAcpClient({
      onTyping: () => this.opts.onTyping(firstMessage.messageId),
      onThought: (text) => this.opts.onReply(firstMessage.messageId, firstMessage.chatId, text),
      showThoughts: this.opts.showThoughts,
      log: (msg) => this.opts.log(`[${userId}] ${msg}`),
    });

    const agentInfo = await spawnAgent({
      command: this.opts.agentCommand,
      args: this.opts.agentArgs,
      cwd: this.opts.agentCwd,
      env: this.opts.agentEnv,
      client,
      log: (msg) => this.opts.log(`[${userId}] ${msg}`),
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
          onTyping: () => this.opts.onTyping(pending.messageId),
          onThought: (text) => this.opts.onReply(pending.messageId, pending.chatId, text),
        });

        await session.client.flush(); // reset buffers

        try {
          this.opts.onTyping(pending.messageId).catch(() => {});
          this.opts.log(`[${session.userId}] Sending prompt to agent`);

          const result = await session.agentInfo.connection.prompt({
            sessionId: session.agentInfo.sessionId,
            prompt: pending.prompt,
          });

          let reply = await session.client.flush();
          if (result.stopReason === "cancelled") reply += "\n[cancelled]";
          else if (result.stopReason === "refusal") reply += "\n[agent refused]";

          this.opts.log(`[${session.userId}] Done (${result.stopReason}), ${reply.length} chars`);

          if (reply.trim()) {
            await this.opts.onReply(pending.messageId, pending.chatId, reply);
          }
        } catch (err) {
          this.opts.log(`[${session.userId}] Agent error: ${String(err)}`);

          // If the process died, drop the session
          if (session.agentInfo.process.killed || session.agentInfo.process.exitCode !== null) {
            this.sessions.delete(session.userId);
            return;
          }

          await this.opts
            .onReply(pending.messageId, pending.chatId, `⚠️ Agent error: ${String(err)}`)
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
