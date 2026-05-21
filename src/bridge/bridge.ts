import * as Lark from "@larksuiteoapi/node-sdk";
import { createPinoLogger, type LarkLogger } from "../logger/logger.js";
import { LarkHttpClient } from "../lark/lark-http.js";
import { LarkWsConnection } from "../lark/lark-ws.js";
import { LarkCardPresenter } from "../presenter/lark-presenter.js";
import type { LarkPresenter } from "../presenter/presenter.js";
import { larkMessageToPrompt } from "../interpreter/lark-interpreter.js";
import { ChatRuntime, type PendingMessage } from "./chat-runtime.js";
import type { SessionStore } from "../session-store/session-store.js";

const CANCEL_COMMANDS = new Set(["/cancel", "取消", "/stop", "停止"]);
const NEW_SESSION_COMMANDS = new Set(["/new", "/restart"]);

const DEFAULT_IDLE_TIMEOUT_MS = 24 * 60 * 60_000;
const DEFAULT_MAX_CONCURRENT_CHATS = 10;
const DEFAULT_SHOW_THOUGHTS = true;
const DEFAULT_PERMISSION_TIMEOUT_MS = 5 * 60_000;
const IDLE_CLEANUP_INTERVAL_MS = 2 * 60_000;

const ORPHAN_CARD_REASON = "会话已结束，本次确认已失效";

const SENDER_TYPE_USER = "user";
const CHAT_TYPE_GROUP = "group";

const REPLY_CANCELLED = "已取消当前任务";
const REPLY_RESTARTED = "已创建新会话，下次消息将重新启动 agent";

interface CardActionPayload {
  /** Permission request id. */
  r?: string;
  /** Selected option id. */
  o?: string;
  /** Option display name. */
  n?: string;
  /** Tool kind. */
  k?: string;
  /** Tool title. */
  t?: string;
  /** Chat id. */
  c?: string;
}

export interface LarkBridgeFeishuOptions {
  appId: string;
  appSecret: string;
}

export interface LarkBridgeAgentOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  /** Optional preset id, used purely for logging context. */
  preset?: string;
  /** Forward `agent_thought_chunk` updates as a thinking card. Default `true`. */
  showThoughts?: boolean;
  /**
   * Auto-cancel a permission request if the user doesn't respond within
   * this many ms (0 = wait forever). Default 5 minutes.
   *
   * Without a timeout, an unanswered card will park its agent prompt
   * forever, preventing the chat runtime from being evicted.
   */
  permissionTimeoutMs?: number;
}

export interface LarkBridgeSessionOptions {
  /** Evict an idle chat after this many ms (0 = never). Default 24h. */
  idleTimeoutMs?: number;
  /** Maximum chats kept in memory; oldest idle gets evicted. Default 10. */
  maxConcurrentChats?: number;
}

export interface LarkBridgeOptions {
  feishu: LarkBridgeFeishuOptions;
  agent: LarkBridgeAgentOptions;
  session?: LarkBridgeSessionOptions;

  sessionStore: SessionStore;

  /** Override the default pino-backed logger. */
  logger?: LarkLogger;
  /**
   * Override the default {@link LarkCardPresenter}. When omitted the bridge
   * builds one from `feishu.appId` / `feishu.appSecret`.
   */
  presenter?: LarkPresenter;
}

/**
 * Top-level bridge that connects a Feishu/Lark bot to an ACP agent.
 *
 * Owns: Lark HTTP client, Lark WebSocket subscription, logger, presenter,
 * session store handle, and one {@link ChatRuntime} per active chat.
 *
 * Lifecycle:
 *
 * 1. `new LarkBridge(opts)` — wires dependencies, no IO yet.
 * 2. `await bridge.start()` — initialises the session store and opens
 *    the WebSocket subscription.
 * 3. `await bridge.stop()` — shuts down all chat runtimes and the store.
 */
export class LarkBridge {
  private readonly logger: LarkLogger;
  private readonly http: LarkHttpClient;
  private readonly presenter: LarkPresenter;
  private readonly sessionStore: SessionStore;
  private readonly agentOpts: Required<Omit<LarkBridgeAgentOptions, "env" | "preset">> &
    Pick<LarkBridgeAgentOptions, "env" | "preset">;
  private readonly idleTimeoutMs: number;
  private readonly maxConcurrentChats: number;
  private readonly feishu: LarkBridgeFeishuOptions;

  private readonly chats = new Map<string, ChatRuntime>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private ws: LarkWsConnection | null = null;
  private started = false;

  constructor(opts: LarkBridgeOptions) {
    this.feishu = opts.feishu;
    this.logger = opts.logger ?? createPinoLogger();
    this.sessionStore = opts.sessionStore;

    this.http = new LarkHttpClient({
      appId: opts.feishu.appId,
      appSecret: opts.feishu.appSecret,
      logger: this.logger,
    });

    this.presenter =
      opts.presenter ?? new LarkCardPresenter({ http: this.http, logger: this.logger });

    this.agentOpts = {
      command: opts.agent.command,
      args: opts.agent.args,
      cwd: opts.agent.cwd,
      env: opts.agent.env,
      preset: opts.agent.preset,
      showThoughts: opts.agent.showThoughts ?? DEFAULT_SHOW_THOUGHTS,
      permissionTimeoutMs: opts.agent.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS,
    };

    this.idleTimeoutMs = opts.session?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.maxConcurrentChats =
      opts.session?.maxConcurrentChats ?? DEFAULT_MAX_CONCURRENT_CHATS;
  }

  /**
   * Initialise the session store and open the Lark WebSocket subscription.
   *
   * @throws when the session store fails to initialise.
   */
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await this.sessionStore.init();

    this.cleanupTimer = setInterval(() => this.evictIdle(), IDLE_CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();

    this.ws = new LarkWsConnection({
      appId: this.feishu.appId,
      appSecret: this.feishu.appSecret,
      logger: this.logger,
      onMessage: (event) => this.handleMessage(event),
      onCardAction: (event) => this.handleCardAction(event),
    });
    this.ws.start();

    this.logger.info("bridge started");
  }

  async stop(): Promise<void> {
    this.logger.info("stopping bridge");
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    for (const runtime of this.chats.values()) runtime.shutdown();
    this.chats.clear();
    await this.sessionStore.close();
    this.logger.info("bridge stopped");
  }

  /** Active chat runtime count (mostly for tests / metrics). */
  get activeChatCount(): number {
    return this.chats.size;
  }

  // ----- WS event handlers ------------------------------------------------

  private handleMessage(event: Lark.RawMessageEvent): void {
    const { message, sender } = event;
    if (sender.sender_type !== SENDER_TYPE_USER) return;

    const userId = sender.sender_id.open_id;
    const messageId = message.message_id;
    const chatId = message.chat_id;
    if (!userId || !messageId || !chatId) return;

    this.logger.info(
      { userId, chatId, messageType: message.message_type },
      "message received",
    );

    this.routeMessage(event, userId, messageId, chatId).catch((err) =>
      this.logger.error({ err, chatId }, "routeMessage failed"),
    );
  }

  private async routeMessage(
    event: Lark.RawMessageEvent,
    userId: string,
    messageId: string,
    chatId: string,
  ): Promise<void> {
    const { message } = event;

    if (message.chat_type === CHAT_TYPE_GROUP) {
      let botOpenId: string;
      try {
        botOpenId = await this.http.getBotOpenId();
      } catch (err) {
        // Without our own open_id we can't tell who is mentioned — drop the
        // event rather than risk treating every group message as addressed
        // to us. The next message will retry.
        this.logger.warn({ err, chatId }, "getBotOpenId failed — skipping group message");
        return;
      }
      const mentioned = message.mentions?.some((m) => m.id?.open_id === botOpenId);
      if (!mentioned) {
        this.logger.debug({ chatId }, "skipping group message — bot not mentioned");
        return;
      }
    }

    const prompt = await larkMessageToPrompt(event, {
      downloader: this.http,
      logger: this.logger,
    });
    if (!prompt.length) return;

    if (await this.maybeHandleCommand(prompt, chatId, messageId)) return;

    await this.enqueueWithContext(event, chatId, userId, messageId, prompt);
  }

  private async maybeHandleCommand(
    prompt: Awaited<ReturnType<typeof larkMessageToPrompt>>,
    chatId: string,
    messageId: string,
  ): Promise<boolean> {
    const firstBlock = prompt[0];
    if (firstBlock?.type !== "text") return false;

    const text = firstBlock.text.trim();
    if (CANCEL_COMMANDS.has(text)) {
      this.logger.info({ chatId }, "cancel command");
      const runtime = this.chats.get(chatId);
      try {
        await runtime?.cancel();
        await this.presenter.replyText(messageId, REPLY_CANCELLED);
      } catch (err) {
        this.logger.warn({ err, chatId }, "cancel command failed");
      }
      return true;
    }
    if (NEW_SESSION_COMMANDS.has(text)) {
      this.logger.info({ chatId }, "restart command");
      const runtime = this.chats.get(chatId);
      runtime?.shutdown();
      this.chats.delete(chatId);
      this.presenter
        .replyText(messageId, REPLY_RESTARTED)
        .catch((err) => this.logger.warn({ err }, "restart reply failed"));
      return true;
    }
    return false;
  }

  private async enqueueWithContext(
    event: Lark.RawMessageEvent,
    chatId: string,
    userId: string,
    messageId: string,
    prompt: Awaited<ReturnType<typeof larkMessageToPrompt>>,
  ): Promise<void> {
    const isGroup = event.message.chat_type === CHAT_TYPE_GROUP;
    const [userName, chatName] = await Promise.all([
      this.http.getUserName(userId),
      isGroup ? this.http.getChatName(chatId) : Promise.resolve(""),
    ]);

    const context = isGroup
      ? `[上下文: 群聊 "${chatName}" (${chatId}) 中用户 ${userName} (${userId}) 的消息]`
      : `[上下文: 用户 ${userName} (${userId}) 的私聊消息]`;

    prompt.unshift({ type: "text", text: context });

    const runtime = this.acquireRuntime(chatId);
    const pending: PendingMessage = { prompt, messageId, chatId };
    await runtime.enqueue(pending);
  }

  private acquireRuntime(chatId: string): ChatRuntime {
    const existing = this.chats.get(chatId);
    if (existing) return existing;

    if (this.chats.size >= this.maxConcurrentChats) this.evictOldest();

    const runtime = new ChatRuntime({
      chatId,
      agentCommand: this.agentOpts.command,
      agentArgs: this.agentOpts.args,
      agentCwd: this.agentOpts.cwd,
      agentEnv: this.agentOpts.env,
      showThoughts: this.agentOpts.showThoughts,
      permissionTimeoutMs: this.agentOpts.permissionTimeoutMs,
      presenter: this.presenter,
      sessionStore: this.sessionStore,
      logger: this.logger,
    });
    this.chats.set(chatId, runtime);
    return runtime;
  }

  private handleCardAction(event: Lark.CardActionEvent): void {
    const value = event.action.value as CardActionPayload | undefined;
    if (!value?.r || !value?.o || !value?.c) return;

    const runtime = this.chats.get(value.c);
    const handled = runtime?.handleCardAction(value.r, value.o) ?? false;
    const messageId = event.messageId;

    if (!handled) {
      this.logger.info({ chatId: value.c, requestId: value.r }, "orphan card action — patching as expired");
      if (messageId) {
        this.presenter
          .expirePermissionCard(messageId, ORPHAN_CARD_REASON)
          .catch((err) => this.logger.warn({ err }, "expirePermissionCard failed"));
      }
      return;
    }

    this.logger.info({ chatId: value.c, optionId: value.o }, "card action resolved");

    if (messageId && value.n && value.k && value.t) {
      this.presenter
        .updatePermissionCard(messageId, value.k, value.t, value.n)
        .catch((err) => this.logger.warn({ err }, "updatePermissionCard failed"));
    }
  }

  // ----- Lifecycle helpers ------------------------------------------------

  private evictIdle(): void {
    if (this.idleTimeoutMs <= 0) return;
    const now = Date.now();
    for (const [chatId, runtime] of this.chats) {
      if (runtime.processing) continue;
      if (now - runtime.lastActivity <= this.idleTimeoutMs) continue;
      this.logger.info({ chatId }, "evicting idle chat");
      runtime.shutdown();
      this.chats.delete(chatId);
    }
  }

  private evictOldest(): void {
    let oldest: { chatId: string; lastActivity: number } | null = null;
    for (const [chatId, runtime] of this.chats) {
      if (runtime.processing) continue;
      if (!oldest || runtime.lastActivity < oldest.lastActivity) {
        oldest = { chatId, lastActivity: runtime.lastActivity };
      }
    }
    if (!oldest) return;
    this.logger.info({ chatId: oldest.chatId }, "max concurrent chats reached — evicting oldest");
    const runtime = this.chats.get(oldest.chatId);
    runtime?.shutdown();
    this.chats.delete(oldest.chatId);
  }
}
