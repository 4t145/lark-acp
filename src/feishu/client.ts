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
  async addReaction(messageId: string, emoji = "ZAP"): Promise<void> {
    try {
      await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      });
    } catch {
      // reactions are best-effort
    }
  }

  /** Remove a reaction (called after reply is sent). */
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
