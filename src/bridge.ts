/**
 * FeishuAcpBridge — the main orchestrator.
 *
 * Connects Feishu's WebSocket event stream to ACP agent subprocesses.
 * Routes messages by chat_id; one chat = one active session at a time.
 */

import * as Lark from "@larksuiteoapi/node-sdk";
import { FeishuClient } from "./feishu/client.js";
import { FeishuWsConnection } from "./feishu/websocket.js";
import type { FeishuMessageEvent } from "./feishu/types.js";
import { SessionManager } from "./acp/session.js";
import { feishuMessageToPrompt } from "./adapter/inbound.js";
import { formatForFeishu, splitText } from "./adapter/outbound.js";
import type { FeishuAcpConfig } from "./config.js";
import type { StorageBackend } from "./storage/types.js";

const CANCEL_COMMANDS = new Set(["/cancel", "取消", "/stop", "停止"]);

export class FeishuAcpBridge {
  private config: FeishuAcpConfig;
  private feishuClient: FeishuClient;
  private sessionManager: SessionManager | null = null;
  private log: (msg: string) => void;

  constructor(config: FeishuAcpConfig, storage: StorageBackend, log?: (msg: string) => void) {
    this.config = config;
    this.log = log ?? ((msg) => console.log(`[lark-acp] ${msg}`));
    this.feishuClient = new FeishuClient({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
    });
    this.sessionManager = new SessionManager({
      agentCommand: config.agent.command,
      agentArgs: config.agent.args,
      agentCwd: config.agent.cwd,
      agentEnv: config.agent.env,
      agentPreset: config.agent.preset,
      storage,
      idleTimeoutMs: config.session.idleTimeoutMs,
      maxConcurrentChats: config.session.maxConcurrentUsers,
      showThoughts: config.agent.showThoughts,
      log: this.log,
      onReply: (messageId, chatId, text) => this.sendReply(messageId, chatId, text),
      onTyping: (messageId) => this.feishuClient.addReaction(messageId, "THINKING"),
      onStopTyping: (messageId, reactionId) => this.feishuClient.removeReaction(messageId, reactionId),
      sendInterruptCard: (messageId, params, requestId, chatId) =>
        this.feishuClient.sendInterruptCard(messageId, params, requestId, chatId),
      sendThinkingCard: (replyToMessageId) =>
        this.feishuClient.sendThinkingCard(replyToMessageId),
      updateThinkingCard: (cardMessageId, thoughtText, isDone) =>
        this.feishuClient.updateThinkingCard(cardMessageId, thoughtText, isDone),
      sendActivityCard: (replyToMessageId, items) =>
        this.feishuClient.sendActivityCard(replyToMessageId, items),
      updateActivityCard: (cardMessageId, items) =>
        this.feishuClient.updateActivityCard(cardMessageId, items),
    });
  }

  start(): void {
    this.sessionManager!.start();

    const ws = new FeishuWsConnection({
      appId: this.config.feishu.appId,
      appSecret: this.config.feishu.appSecret,
      onMessage: (event) => this.handleMessage(event),
      onCardAction: (event) => this.handleCardAction(event),
      log: this.log,
    });
    ws.start();
  }

  async stop(): Promise<void> {
    this.log("Stopping bridge...");
    await this.sessionManager?.stop();
    this.log("Bridge stopped");
  }

  private handleMessage(event: FeishuMessageEvent): void {
    const { message, sender } = event;

    if (sender.sender_type !== "user") return;

    const userId = sender.sender_id.open_id;
    const messageId = message.message_id;
    const chatId = message.chat_id;

    if (!userId || !messageId || !chatId) return;

    this.log(`Message from ${userId} in chat ${chatId}: [${message.message_type}]`);

    // Check and enqueue asynchronously (needs bot openId for @mention filter)
    this.checkAndEnqueue(event, chatId, userId, messageId).catch((err) => {
      this.log(`Failed to enqueue message: ${String(err)}`);
    });
  }

  private async checkAndEnqueue(
    event: FeishuMessageEvent,
    chatId: string,
    userId: string,
    messageId: string,
  ): Promise<void> {
    const { message } = event;

    // In group chats, only forward messages that @mention the bot
    if (message.chat_type === "group") {
      const botOpenId = await this.feishuClient.getBotOpenId();
      const mentioned = message.mentions?.some(
        (m) => m.id?.open_id === botOpenId
      );
      if (!mentioned) {
        this.log(`Skipping group message — bot not mentioned`);
        return;
      }
    }

    const prompt = feishuMessageToPrompt(event);
    if (!prompt.length) return;

    const firstBlock = prompt[0];
    if (firstBlock.type === "text") {
      const text = firstBlock.text.trim();
      if (CANCEL_COMMANDS.has(text)) {
        this.log(`Cancel command for chat ${chatId}`);
        this.sessionManager?.cancelSession(chatId)
          .then(() => this.feishuClient.replyText(messageId, "已取消当前任务"))
          .catch((err) => this.log(`Cancel error: ${String(err)}`));
        return;
      }
    }

    await this.enqueueWithContext(chatId, userId, messageId, prompt, event);
  }

  private async enqueueWithContext(
    chatId: string,
    userId: string,
    messageId: string,
    prompt: ReturnType<typeof feishuMessageToPrompt>,
    event: FeishuMessageEvent,
  ): Promise<void> {
    const { message } = event;
    const isGroup = message.chat_type === "group";

    const [userName, chatName] = await Promise.all([
      this.feishuClient.getUserName(userId),
      isGroup ? this.feishuClient.getChatName(chatId) : Promise.resolve(""),
    ]);

    this.log(`Context: user="${userName}" chat="${chatName || "(DM)"}" group=${isGroup}`);

    const context = isGroup
      ? `[上下文: 群聊 "${chatName}" (${chatId}) 中用户 ${userName} (${userId}) 的消息]`
      : `[上下文: 用户 ${userName} (${userId}) 的私聊消息]`;

    prompt.unshift({ type: "text", text: context });
    await this.sessionManager!.enqueue(chatId, { prompt, messageId, chatId });
  }

  private handleCardAction(event: Lark.CardActionEvent): void {
    const value = event.action.value as { r?: string; o?: string; n?: string; k?: string; t?: string; c?: string } | undefined;
    if (!value?.r || !value?.o || !value?.c) return;

    const handled = this.sessionManager?.handleCardAction(value.c, value.r, value.o) ?? false;

    if (handled) {
      this.log(`Card action resolved: chat=${value.c} option=${value.o}`);
      const messageId = event.messageId;
      if (messageId && value.n && value.k && value.t) {
        this.feishuClient.updatePermissionCard(messageId, value.k, value.t, value.n)
          .catch((err) => this.log(`Failed to update card: ${String(err)}`));
      }
    } else {
      this.log(`Card action ignored: chat=${value.c}, no matching pending permission`);
    }
  }

  private async sendReply(messageId: string, chatId: string, text: string): Promise<void> {
    const formatted = formatForFeishu(text);
    const chunks = splitText(formatted);

    for (const chunk of chunks) {
      await this.feishuClient.replyText(messageId, chunk);
    }
  }
}
