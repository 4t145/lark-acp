/**
 * FeishuAcpBridge — the main orchestrator.
 *
 * Connects Feishu's WebSocket event stream to ACP agent subprocesses.
 * One bridge = one Feishu bot app → many users → many agent sessions.
 */

import { FeishuClient } from "./feishu/client.js";
import { FeishuWsConnection } from "./feishu/websocket.js";
import type { FeishuMessageEvent } from "./feishu/types.js";
import { SessionManager } from "./acp/session.js";
import { feishuMessageToPrompt } from "./adapter/inbound.js";
import { formatForFeishu, splitText } from "./adapter/outbound.js";
import type { FeishuAcpConfig } from "./config.js";

export class FeishuAcpBridge {
  private config: FeishuAcpConfig;
  private feishuClient: FeishuClient;
  private sessionManager: SessionManager | null = null;
  private log: (msg: string) => void;

  constructor(config: FeishuAcpConfig, log?: (msg: string) => void) {
    this.config = config;
    this.log = log ?? ((msg) => console.log(`[feishu-acp] ${msg}`));
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
      idleTimeoutMs: this.config.session.idleTimeoutMs,
      maxConcurrentUsers: this.config.session.maxConcurrentUsers,
      showThoughts: this.config.agent.showThoughts,
      log: this.log,
      onReply: (messageId, chatId, text) => this.sendReply(messageId, chatId, text),
      onTyping: (messageId) => this.feishuClient.addReaction(messageId, "ZAP"),
    });
    this.sessionManager.start();

    const ws = new FeishuWsConnection({
      appId: this.config.feishu.appId,
      appSecret: this.config.feishu.appSecret,
      onMessage: (event) => this.handleMessage(event),
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

    // Convert and enqueue — fire-and-forget
    this.enqueue(event, userId, messageId, chatId).catch((err) => {
      this.log(`Failed to enqueue message: ${String(err)}`);
    });
  }

  private async enqueue(
    event: FeishuMessageEvent,
    userId: string,
    messageId: string,
    chatId: string,
  ): Promise<void> {
    const prompt = feishuMessageToPrompt(event);
    if (!prompt.length) return; // empty message, skip

    await this.sessionManager!.enqueue(userId, { prompt, messageId, chatId });
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
