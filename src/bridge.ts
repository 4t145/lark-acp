/**
 * FeishuAcpBridge — the main orchestrator.
 *
 * Connects Feishu's WebSocket event stream to ACP agent subprocesses.
 * One bridge = one Feishu bot app → many users → many agent sessions.
 */

import * as Lark from "@larksuiteoapi/node-sdk";
import { FeishuClient } from "./feishu/client.js";
import { FeishuWsConnection } from "./feishu/websocket.js";
import type { FeishuMessageEvent } from "./feishu/types.js";
import { SessionManager } from "./acp/session.js";
import { feishuMessageToPrompt } from "./adapter/inbound.js";
import { formatForFeishu, splitText } from "./adapter/outbound.js";
import type { FeishuAcpConfig } from "./config.js";

/** Text triggers that instruct the bridge to cancel the current agent task. */
const CANCEL_COMMANDS = new Set(["/cancel", "取消", "/stop", "停止"]);

export class FeishuAcpBridge {
  private config: FeishuAcpConfig;
  private feishuClient: FeishuClient;
  private sessionManager: SessionManager | null = null;
  private log: (msg: string) => void;

  constructor(config: FeishuAcpConfig, log?: (msg: string) => void) {
    this.config = config;
    this.log = log ?? ((msg) => console.log(`[lark-acp] ${msg}`));
    this.feishuClient = new FeishuClient({
      appId: config.feishu.appId,
      appSecret: config.feishu.appSecret,
    });
  }

  start(): void {
    this.sessionManager = new SessionManager({
      agentCommand: this.config.agent.command,
      agentArgs: this.config.agent.args,
      agentCwd: this.config.agent.cwd,
      agentEnv: this.config.agent.env,
      agentPreset: this.config.agent.preset,
      storageDir: this.config.storage.dir,
      idleTimeoutMs: this.config.session.idleTimeoutMs,
      maxConcurrentUsers: this.config.session.maxConcurrentUsers,
      showThoughts: this.config.agent.showThoughts,
      log: this.log,
      onReply: (messageId, chatId, text) => this.sendReply(messageId, chatId, text),
      onTyping: (messageId) => this.feishuClient.addReaction(messageId, "THINKING"),
      onStopTyping: (messageId, reactionId) => this.feishuClient.removeReaction(messageId, reactionId),
      sendInterruptCard: (messageId, params, requestId) =>
        this.feishuClient.sendInterruptCard(messageId, params, requestId),
    });
    this.sessionManager.start();

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

    // Only handle user messages (not bot's own)
    if (sender.sender_type !== "user") return;

    const userId = sender.sender_id.open_id;
    const messageId = message.message_id;
    const chatId = message.chat_id;

    if (!userId || !messageId) return;

    this.log(`Message from ${userId} in chat ${chatId}: [${message.message_type}]`);

    const prompt = feishuMessageToPrompt(event);
    if (!prompt.length) return;

    // Check for cancel command before enqueuing
    const firstBlock = prompt[0];
    if (firstBlock.type === "text") {
      const text = firstBlock.text.trim();
      if (CANCEL_COMMANDS.has(text)) {
        this.log(`Cancel command from ${userId}`);
        this.sessionManager?.cancelSession(userId)
          .then(() => this.feishuClient.replyText(messageId, "已取消当前任务"))
          .catch((err) => this.log(`Cancel error: ${String(err)}`));
        return;
      }
    }

    this.enqueue(userId, messageId, chatId, prompt).catch((err) => {
      this.log(`Failed to enqueue message: ${String(err)}`);
    });
  }

  private async enqueue(
    userId: string,
    messageId: string,
    chatId: string,
    prompt: ReturnType<typeof feishuMessageToPrompt>,
  ): Promise<void> {
    await this.sessionManager!.enqueue(userId, { prompt, messageId, chatId });
  }

  private handleCardAction(event: Lark.CardActionEvent): void {
    const value = event.action.value as { r?: string; o?: string } | undefined;
    if (!value?.r || !value?.o) return;

    const openId = event.operator.openId;
    const handled = this.sessionManager?.handleCardAction(openId, value.r, value.o) ?? false;

    if (handled) {
      this.log(`Card action resolved: user=${openId} option=${value.o}`);
    } else {
      this.log(`Card action ignored: user=${openId}, no matching pending permission`);
    }
  }

  private async sendReply(messageId: string, chatId: string, text: string): Promise<void> {
    const formatted = formatForFeishu(text);
    const chunks = splitText(formatted);

    for (const chunk of chunks) {
      // Reply in-thread to the original message for context
      await this.feishuClient.replyText(messageId, chunk);
    }
  }
}
