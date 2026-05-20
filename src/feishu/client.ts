/**
 * Feishu HTTP client — thin wrapper around @larksuite/node-sdk Client.
 * Handles sending messages, reactions, and interactive cards.
 */

import * as Lark from "@larksuiteoapi/node-sdk";
import type * as acp from "@agentclientprotocol/sdk";

/** Maximum time a permission card stays active before auto-closing. */
const PERMISSION_TIMEOUT_SEC = 60;

/** Wrap text in a Feishu interactive card with a markdown element. */
function buildMarkdownCard(text: string): object {
  return {
    config: { wide_screen_mode: true },
    elements: [
      { tag: "markdown", content: text },
    ],
  };
}

/** Map ACP permission option kind to button style. */
function buttonTypeForKind(kind: string): "primary" | "danger" | "default" {
  if (kind === "allow_once") return "primary";
  if (kind === "reject_once" || kind === "reject_always") return "danger";
  return "default";
}

/** Build a permission request interactive card with action buttons. */
function buildPermissionCard(params: acp.RequestPermissionRequest, requestId: string): object {
  const toolTitle = params.toolCall?.title ?? "unknown";
  const toolKind = params.toolCall?.kind ?? "tool";

  const header = {
    title: { tag: "plain_text" as const, content: "Agent 需要确认" },
    template: "blue" as const,
  };

  const actions: Lark.InteractiveCardActionItem[] = params.options.map((opt) => ({
    tag: "button" as const,
    text: { tag: "plain_text" as const, content: opt.name },
    type: buttonTypeForKind(opt.kind),
    value: { r: requestId, o: opt.optionId },
  }));

  return {
    config: { wide_screen_mode: true },
    header,
    elements: [
      {
        tag: "markdown",
        content: `**${toolKind}**: ${toolTitle}\n\n${params.options.length} 个选项，请在 ${PERMISSION_TIMEOUT_SEC}s 内选择`,
      },
      { tag: "action" as const, actions },
    ],
  };
}

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

  /** Reply to a specific message using a markdown card (renders bold, code, etc). */
  async replyText(messageId: string, text: string): Promise<void> {
    await this.client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify(buildMarkdownCard(text)),
        msg_type: "interactive",
        reply_in_thread: false,
      },
    });
  }

  /** Send a markdown card message to a chat (DM or group). */
  async sendText(chatId: string, text: string): Promise<void> {
    await this.client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: chatId,
        content: JSON.stringify(buildMarkdownCard(text)),
        msg_type: "interactive",
      },
    });
  }

  /** Add an emoji reaction. Returns the reaction ID needed to remove it later. */
  async addReaction(messageId: string, emoji = "THINKING"): Promise<string | null> {
    try {
      const res = await this.client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emoji } },
      });
      return (res as any)?.reaction_id ?? null;
    } catch {
      return null;
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

  /** Send an interactive permission card as a reply to the original message. */
  async sendInterruptCard(
    messageId: string,
    params: acp.RequestPermissionRequest,
    requestId: string,
  ): Promise<void> {
    const card = buildPermissionCard(params, requestId);
    await this.client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify(card),
        msg_type: "interactive",
        reply_in_thread: false,
      },
    });
  }
}
