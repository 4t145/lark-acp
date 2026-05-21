/**
 * Per-chat ACP session manager.
 * Each Feishu chat gets its own agent subprocess + ACP session.
 * Supports multiple sessions per chat; defaults to the latest one.
 */

import type * as acp from "@agentclientprotocol/sdk";
import { FeishuAcpClient } from "./client.js";
import { spawnAgent, spawnAndResumeAgent, killAgent, type AgentProcessInfo } from "./agent-manager.js";
import type { StorageBackend } from "../storage/types.js";
import type { ToolItem } from "../feishu/client.js";

export interface PendingMessage {
  prompt: acp.ContentBlock[];
  messageId: string;
  chatId: string;
}

interface ChatSession {
  chatId: string;
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
  storage: StorageBackend;
  idleTimeoutMs: number;
  maxConcurrentChats: number;
  showThoughts: boolean;
  log: (msg: string) => void;
  onReply: (messageId: string, chatId: string, text: string) => Promise<void>;
  onTyping: (messageId: string) => Promise<string | null>;
  onStopTyping: (messageId: string, reactionId: string) => Promise<void>;
  sendInterruptCard: (messageId: string, params: acp.RequestPermissionRequest, requestId: string, chatId: string) => Promise<void>;
  sendThinkingCard: (replyToMessageId: string) => Promise<string | null>;
  updateThinkingCard: (cardMessageId: string, thoughtText: string, isDone: boolean) => Promise<void>;
  sendActivityCard: (replyToMessageId: string, items: ToolItem[]) => Promise<string | null>;
  updateActivityCard: (cardMessageId: string, items: ToolItem[]) => Promise<void>;
}

const AUTH_HINTS: Record<string, string> = {
  claude: 'Run "claude" in a terminal and complete the login flow first.',
  copilot: 'Run "gh auth login" to authenticate GitHub Copilot CLI.',
  codex: 'Set the OPENAI_API_KEY environment variable or run "codex" to authenticate.',
  gemini: 'Run "gemini" in a terminal and complete the login flow first.',
};

export class SessionManager {
  private sessions = new Map<string, ChatSession>();
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
    for (const [chatId, s] of this.sessions) {
      this.opts.log(`Stopping session for chat ${chatId}`);
      killAgent(s.agentInfo.process);
    }
    this.sessions.clear();
    await this.opts.storage.close();
  }

  async enqueue(chatId: string, message: PendingMessage): Promise<void> {
    let session = this.sessions.get(chatId);

    if (!session) {
      if (this.sessions.size >= this.opts.maxConcurrentChats) this.evictOldest();
      session = await this.createSession(chatId, message);
      this.sessions.set(chatId, session);
    }

    session.lastActivity = Date.now();
    session.queue.push(message);

    if (!session.processing) {
      session.processing = true;
      this.processQueue(session).catch((err) => {
        this.opts.log(`[${chatId}] queue error: ${String(err)}`);
      });
    }
  }

  get activeCount(): number {
    return this.sessions.size;
  }

  async cancelSession(chatId: string): Promise<void> {
    const session = this.sessions.get(chatId);
    if (!session) return;

    this.opts.log(`[${chatId}] Cancelling current task`);

    session.client.cancelPendingPermission();

    try {
      await session.agentInfo.connection.cancel({ sessionId: session.agentInfo.sessionId });
    } catch (err) {
      this.opts.log(`[${chatId}] cancel notification error: ${String(err)}`);
    }

    session.queue.length = 0;
  }

  handleCardAction(chatId: string, requestId: string, optionId: string): boolean {
    const session = this.sessions.get(chatId);
    if (!session) return false;
    return session.client.handleCardAction(requestId, optionId);
  }

  private async createSession(chatId: string, firstMessage: PendingMessage): Promise<ChatSession> {
    this.opts.log(`Creating session for chat ${chatId}`);

    const client = new FeishuAcpClient({
      onTyping: () => this.opts.onTyping(firstMessage.messageId).then(() => {}),
      onThought: (text) => this.opts.onReply(firstMessage.messageId, firstMessage.chatId, text),
      showThoughts: this.opts.showThoughts,
      sendInterruptCard: (messageId, params, requestId) =>
        this.opts.sendInterruptCard(messageId, params, requestId, chatId),
      sendThinkingCard: this.opts.sendThinkingCard,
      updateThinkingCard: this.opts.updateThinkingCard,
      sendActivityCard: this.opts.sendActivityCard,
      updateActivityCard: this.opts.updateActivityCard,
      log: (msg) => this.opts.log(`[${chatId}] ${msg}`),
    });

    const spawnOpts = {
      command: this.opts.agentCommand,
      args: this.opts.agentArgs,
      cwd: this.opts.agentCwd,
      env: this.opts.agentEnv,
      client,
      log: (msg: string) => this.opts.log(`[${chatId}] ${msg}`),
    };

    // Try to resume the latest session for this chat
    let agentInfo: AgentProcessInfo;
    const latest = await this.opts.storage.getLatest(chatId);
    if (latest) {
      this.opts.log(`[${chatId}] Found previous session ${latest.sessionId}, attempting resume...`);
      const result = await spawnAndResumeAgent(spawnOpts, latest.sessionId);
      agentInfo = result.agentInfo;
      if (result.resumed) {
        this.opts.log(`[${chatId}] Resumed previous session ${latest.sessionId}`);
      } else {
        this.opts.log(`[${chatId}] Could not resume, started new session ${agentInfo.sessionId}`);
      }
    } else {
      agentInfo = await spawnAgent(spawnOpts);
    }

    // Persist to storage
    this.opts.storage.save({
      chatId,
      sessionId: agentInfo.sessionId,
      agentCommand: this.opts.agentCommand,
      agentArgs: this.opts.agentArgs,
      cwd: this.opts.agentCwd,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }).catch((err) => this.opts.log(`[${chatId}] storage save error: ${String(err)}`));

    agentInfo.process.on("exit", () => {
      const s = this.sessions.get(chatId);
      if (s?.agentInfo.process === agentInfo.process) {
        this.opts.log(`Agent for chat ${chatId} exited, cleaning up session`);
        this.sessions.delete(chatId);
      }
    });

    return {
      chatId,
      client,
      agentInfo,
      queue: [],
      processing: false,
      lastActivity: Date.now(),
    };
  }

  private async processQueue(session: ChatSession): Promise<void> {
    try {
      while (session.queue.length > 0 && !this.aborted) {
        const pending = session.queue.shift()!;

        session.client.updateCallbacks({
          onTyping: () => this.opts.onTyping(pending.messageId).then(() => {}),
          onThought: (text) => this.opts.onReply(pending.messageId, pending.chatId, text),
        });

        await session.client.flush();

        session.client.setContext(pending.messageId, pending.chatId);

        try {
          const reactionId = await this.opts.onTyping(pending.messageId).catch(() => null);
          this.opts.log(`[${session.chatId}] Sending prompt to agent`);
          const result = await session.agentInfo.connection.prompt({
            sessionId: session.agentInfo.sessionId,
            prompt: pending.prompt,
          });

          if (reactionId) {
            this.opts.onStopTyping(pending.messageId, reactionId).catch(() => {});
          }

          let reply = await session.client.flush();
          if (result.stopReason === "cancelled") reply += "\n[cancelled]";
          else if (result.stopReason === "refusal") reply += "\n[agent refused]";

          this.opts.log(`[${session.chatId}] Done (${result.stopReason}), reply=${reply.length} chars`);

          if (reply.trim()) {
            this.opts.log(`[${session.chatId}] Sending reply to chat ${pending.chatId}`);
            await this.opts.onReply(pending.messageId, pending.chatId, reply);
          }

          // Update last activity timestamp in storage
          this.opts.storage.save({
            chatId: session.chatId,
            sessionId: session.agentInfo.sessionId,
            agentCommand: this.opts.agentCommand,
            agentArgs: this.opts.agentArgs,
            cwd: this.opts.agentCwd,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }).catch(() => {});
        } catch (err) {
          const errMsg = formatAgentError(err);

          const isAuthError = isAuthenticationError(err);
          if (isAuthError || session.agentInfo.process.killed || session.agentInfo.process.exitCode !== null) {
            killAgent(session.agentInfo.process);
            this.sessions.delete(session.chatId);

            if (isAuthError) {
              const preset = this.opts.agentPreset ?? "";
              const hint = AUTH_HINTS[preset] ?? `Ensure the agent (${this.opts.agentCommand}) is authenticated before starting lark-acp.`;
              this.opts.log(`[${session.chatId}] Agent authentication failed. ${hint}`);
              await this.opts.onReply(
                pending.messageId,
                pending.chatId,
                `⚠️ Agent authentication failed.\n${hint}`,
              ).catch(() => {});
            } else {
              this.opts.log(`[${session.chatId}] Agent crashed: ${errMsg}`);
              await this.opts.onReply(
                pending.messageId,
                pending.chatId,
                `⚠️ Agent crashed: ${errMsg}`,
              ).catch(() => {});
            }
            return;
          }

          this.opts.log(`[${session.chatId}] Agent error: ${errMsg}`);
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
    for (const [chatId, s] of this.sessions) {
      if (!s.processing && now - s.lastActivity > this.opts.idleTimeoutMs) {
        const idleMin = Math.round((now - s.lastActivity) / 60_000);
        this.opts.log(`Session ${chatId} idle ${idleMin}min, evicting`);
        killAgent(s.agentInfo.process);
        this.sessions.delete(chatId);
      }
    }
  }

  private evictOldest(): void {
    let oldest: { chatId: string; lastActivity: number } | null = null;
    for (const [chatId, s] of this.sessions) {
      if (!s.processing && (!oldest || s.lastActivity < oldest.lastActivity)) {
        oldest = { chatId, lastActivity: s.lastActivity };
      }
    }
    if (oldest) {
      this.opts.log(`Max sessions reached, evicting chat ${oldest.chatId}`);
      const s = this.sessions.get(oldest.chatId);
      if (s) killAgent(s.agentInfo.process);
      this.sessions.delete(oldest.chatId);
    }
  }
}

function formatAgentError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const e = err as Record<string, unknown>;
    if (typeof e["message"] === "string") return e["message"];
    return JSON.stringify(err);
  }
  return String(err);
}

function isAuthenticationError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as Record<string, unknown>;
  if (typeof e["code"] === "number" && e["code"] === -32000) return true;
  if (typeof e["message"] === "string" && /auth(entication)? required/i.test(e["message"])) return true;
  return false;
}
