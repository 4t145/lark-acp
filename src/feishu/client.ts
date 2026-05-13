/**
 * Feishu HTTP client — thin wrapper around @larksuite/node-sdk Client.
 * Handles sending messages and reactions.
 */

import * as Lark from "@larksuiteoapi/node-sdk";

export interface FeishuClientOpts {
  appId: string;
  appSecret: string;
}

export class FeishuClient {
  private client: Lark.Client;

  constructor(opts: FeishuClientOpts) {
    this.client = new Lark.Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      appType: Lark.AppType.SelfBuild,
      // Suppress internal SDK logs
      loggerLevel: Lark.LoggerLevel.error,
    });
  }

  /** Reply to a specific message with plain text. */
  async replyText(messageId: string, text: string): Promise<void> {
    await this.client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify({ text }),
        msg_type: "text",
        reply_in_thread: false,
      },
    });
  }

  /** Send a text message to a chat (DM or group). */
  async sendText(chatId: string, text: string): Promise<void> {
    await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ text }),
        msg_type: "text",
      },
    });
  }

  /** Add an emoji reaction to a message (best-effort, used as typing indicator). */
  async addReaction(messageId: string, emoji = "THINKING"): Promise<void> {
    try {
      await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      });
    } catch {
      // reactions are best-effort
    }
  }

  /** Fetch bot info and return a direct chat deep-link the user can click. */
  async getBotChatLink(): Promise<string | null> {
    try {
      // GET /open-apis/bot/v3/info
      const res = await (this.client as any).request({
        method: "GET",
        url: "/open-apis/bot/v3/info",
      });
      const openId: string | undefined = res?.bot?.open_id;
      if (openId) {
        return `https://applink.feishu.cn/client/chat/open?botId=${openId}`;
      }
    } catch {
      // non-fatal
    }
    return null;
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    try {
      await this.client.im.messageReaction.delete({
        path: { message_id: messageId, reaction_id: reactionId },
      });
    } catch {
      // best-effort
    }
  }
}
