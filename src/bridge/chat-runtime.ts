import type * as acp from "@agentclientprotocol/sdk";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkPresenter } from "../presenter/presenter.js";
import { LarkAcpClient } from "../acp/lark-acp-client.js";
import {
  spawnAgent,
  spawnAndResumeAgent,
  killAgent,
  type AgentProcess,
  type SpawnAgentOptions,
} from "../acp/agent-process.js";
import type { SessionStore } from "../session-store/session-store.js";

export interface PendingMessage {
  prompt: acp.ContentBlock[];
  messageId: string;
  chatId: string;
}

export interface ChatRuntimeOptions {
  chatId: string;
  agentCommand: string;
  agentArgs: string[];
  agentCwd: string;
  agentEnv?: Record<string, string>;
  showThoughts: boolean;
  permissionTimeoutMs: number;
  presenter: LarkPresenter;
  sessionStore: SessionStore;
  logger: LarkLogger;
}

interface ChatRuntimeState {
  client: LarkAcpClient;
  agent: AgentProcess;
  queue: PendingMessage[];
  processing: boolean;
  lastActivity: number;
}

/**
 * Per-chat ACP runtime: owns one agent subprocess, one `LarkAcpClient`,
 * and a FIFO queue of pending Feishu messages.
 *
 * Constructed lazily by {@link LarkBridge} on the first message for a
 * chat. Subsequent messages are enqueued via {@link enqueue}; the runtime
 * processes them serially.
 */
export class ChatRuntime {
  private readonly opts: ChatRuntimeOptions;
  private readonly logger: LarkLogger;
  private state: ChatRuntimeState | null = null;
  private aborted = false;

  constructor(opts: ChatRuntimeOptions) {
    this.opts = opts;
    this.logger = opts.logger.child({ name: "chat", chatId: opts.chatId });
  }

  get chatId(): string {
    return this.opts.chatId;
  }

  get processing(): boolean {
    return this.state?.processing ?? false;
  }

  get lastActivity(): number {
    return this.state?.lastActivity ?? 0;
  }

  /** Enqueue a Feishu message; spawns the agent on first call. */
  async enqueue(message: PendingMessage): Promise<void> {
    if (!this.state) {
      this.state = await this.bootstrap(message);
    }

    this.state.lastActivity = Date.now();
    this.state.queue.push(message);

    if (!this.state.processing) {
      this.state.processing = true;
      this.processQueue().catch((err) =>
        this.logger.error({ err }, "queue processor crashed"),
      );
    }
  }

  /**
   * Cancel the current prompt (if any) and clear the queue. Keeps the
   * agent process alive so the next message can resume the same session.
   */
  async cancel(): Promise<void> {
    if (!this.state) return;
    this.logger.info("cancelling current task");
    this.state.client.cancelPendingPermission();
    try {
      await this.state.agent.connection.cancel({ sessionId: this.state.agent.sessionId });
    } catch (err) {
      this.logger.warn({ err }, "cancel notification rejected");
    }
    this.state.queue.length = 0;
  }

  /** Tear down the agent process so the next message starts fresh. */
  shutdown(): void {
    if (!this.state) return;
    this.logger.info("shutting down chat runtime");
    this.state.client.cancelPendingPermission();
    killAgent(this.state.agent.process);
    this.state = null;
    this.aborted = true;
  }

  /** Forward a card-action event to the underlying ACP client. */
  handleCardAction(requestId: string, optionId: string): boolean {
    return this.state?.client.handleCardAction(requestId, optionId) ?? false;
  }

  /** Notification callback invoked when the underlying agent process exits. */
  onAgentExit(handler: () => void): void {
    if (!this.state) return;
    this.state.agent.process.on("exit", handler);
  }

  private async bootstrap(firstMessage: PendingMessage): Promise<ChatRuntimeState> {
    this.logger.info("creating chat runtime");

    const client = new LarkAcpClient({
      presenter: this.opts.presenter,
      logger: this.logger,
      showThoughts: this.opts.showThoughts,
      permissionTimeoutMs: this.opts.permissionTimeoutMs,
      callbacks: {
        onTyping: () =>
          this.opts.presenter.addReaction(firstMessage.messageId).then(() => {}),
      },
    });

    const spawnOpts: SpawnAgentOptions = {
      command: this.opts.agentCommand,
      args: this.opts.agentArgs,
      cwd: this.opts.agentCwd,
      env: this.opts.agentEnv,
      client,
      logger: this.logger,
    };

    const latest = await this.opts.sessionStore.getLatest(this.opts.chatId);
    let agent: AgentProcess;
    if (latest) {
      this.logger.info({ previousSessionId: latest.sessionId }, "attempting resume");
      const result = await spawnAndResumeAgent(spawnOpts, latest.sessionId);
      agent = result.agent;
    } else {
      agent = await spawnAgent(spawnOpts);
    }

    await this.persistSession(agent.sessionId);

    return {
      client,
      agent,
      queue: [],
      processing: false,
      lastActivity: Date.now(),
    };
  }

  private async processQueue(): Promise<void> {
    const state = this.state;
    if (!state) return;

    try {
      while (state.queue.length > 0 && !this.aborted) {
        const pending = state.queue.shift()!;

        state.client.updateCallbacks({
          onTyping: () =>
            this.opts.presenter.addReaction(pending.messageId).then(() => {}),
        });

        await state.client.flush();
        state.client.setContext(pending.messageId, pending.chatId);

        try {
          await this.runPrompt(state, pending);
        } catch (err) {
          await this.handlePromptError(state, pending, err);
          if (!this.state) return; // shut down by error handler
        }
      }
    } finally {
      if (this.state) this.state.processing = false;
    }
  }

  private async runPrompt(state: ChatRuntimeState, pending: PendingMessage): Promise<void> {
    const reactionId = await this.opts.presenter.addReaction(pending.messageId).catch(() => null);
    this.logger.info("sending prompt to agent");

    const result = await state.agent.connection.prompt({
      sessionId: state.agent.sessionId,
      prompt: pending.prompt,
    });

    if (reactionId) {
      this.opts.presenter
        .removeReaction(pending.messageId, reactionId)
        .catch((err) => this.logger.debug({ err }, "removeReaction failed"));
    }

    let reply = await state.client.flush();
    if (result.stopReason === "cancelled") reply += "\n[cancelled]";
    else if (result.stopReason === "refusal") reply += "\n[agent refused]";

    this.logger.info({ stopReason: result.stopReason, replyLen: reply.length }, "prompt done");

    if (reply.trim()) {
      await this.opts.presenter.replyText(pending.messageId, reply);
    }

    await this.persistSession(state.agent.sessionId);
  }

  private async handlePromptError(
    state: ChatRuntimeState,
    pending: PendingMessage,
    err: unknown,
  ): Promise<void> {
    const errMsg = formatAgentError(err);
    const isAuthError = isAuthenticationError(err);
    const procDead =
      state.agent.process.killed || state.agent.process.exitCode !== null;

    if (isAuthError || procDead) {
      this.shutdown();
      const summary = isAuthError
        ? `⚠️ Agent authentication failed: ${errMsg}`
        : `⚠️ Agent crashed: ${errMsg}`;
      this.logger.error({ err, isAuthError }, "agent died");
      await this.opts.presenter
        .replyText(pending.messageId, summary)
        .catch((sendErr) => this.logger.warn({ err: sendErr }, "error reply failed"));
      return;
    }

    this.logger.warn({ err }, "agent error");
    await this.opts.presenter
      .replyText(pending.messageId, `⚠️ Agent error: ${errMsg}`)
      .catch((sendErr) => this.logger.warn({ err: sendErr }, "error reply failed"));
  }

  private async persistSession(sessionId: string): Promise<void> {
    const now = Date.now();
    try {
      await this.opts.sessionStore.save({
        chatId: this.opts.chatId,
        sessionId,
        agentCommand: this.opts.agentCommand,
        agentArgs: this.opts.agentArgs,
        cwd: this.opts.agentCwd,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      this.logger.warn({ err }, "session store save failed");
    }
  }
}

function formatAgentError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj["message"] === "string") return obj["message"];
    return JSON.stringify(err);
  }
  return String(err);
}

const ACP_AUTH_REQUIRED_CODE = -32_000;
const AUTH_REQUIRED_PATTERN = /auth(entication)? required/i;

function isAuthenticationError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const obj = err as Record<string, unknown>;
  if (typeof obj["code"] === "number" && obj["code"] === ACP_AUTH_REQUIRED_CODE) return true;
  if (typeof obj["message"] === "string" && AUTH_REQUIRED_PATTERN.test(obj["message"])) return true;
  return false;
}
