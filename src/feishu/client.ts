/**
 * Feishu HTTP client — thin wrapper around @larksuite/node-sdk Client.
 * Handles sending messages, reactions, and interactive cards.
 */

import * as Lark from "@larksuiteoapi/node-sdk";
import type * as acp from "@agentclientprotocol/sdk";

/** Wrap text in a Feishu interactive card with a markdown element. */
function buildMarkdownCard(text: string): object {
  return {
    config: { wide_screen_mode: true },
    elements: [
      { tag: "markdown", content: text },
    ],
  };
}

/** Map ACP permission option kind to button style.
 *  allow_always uses primary (blue fill) to visually distinguish from allow_once (default). */
function buttonTypeForKind(kind: string): "primary" | "danger" | "default" {
  if (kind === "allow_always") return "primary";
  if (kind === "reject_once" || kind === "reject_always") return "danger";
  return "default";
}

/** Build a permission request interactive card with vertically-stacked action buttons. */
function buildPermissionCard(params: acp.RequestPermissionRequest, requestId: string, chatId: string): object {
  const toolTitle = params.toolCall?.title ?? "unknown";
  const toolKind = params.toolCall?.kind ?? "tool";

  const header = {
    title: { tag: "plain_text" as const, content: "Agent 需要确认" },
    template: "blue" as const,
  };

  const elements: object[] = [
    {
      tag: "markdown",
      content: `**${toolKind}**: \`${toolTitle}\``,
    },
  ];

  // One action block per button → vertical layout
  for (const opt of params.options) {
    elements.push({
      tag: "action",
      layout: "flow",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: opt.name },
          type: buttonTypeForKind(opt.kind),
          value: { r: requestId, o: opt.optionId, n: opt.name, k: toolKind, t: toolTitle, c: chatId },
        },
      ],
    });
  }

  return { config: { wide_screen_mode: true }, header, elements };
}

/** Build a resolved permission card confirming the user's selection. */
function buildResolvedCard(toolKind: string, toolTitle: string, selectedName: string): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text" as const, content: "已确认" },
      template: "green" as const,
    },
    elements: [
      {
        tag: "markdown",
        content: `**${toolKind}**: \`${toolTitle}\`\n\n已选择: **${selectedName}**`,
      },
    ],
  };
}

/** Build a "thinking" card. Uses compact note element for thought content. */
function buildThinkingCard(text?: string, isDone?: boolean): object {
  const header = {
    title: { tag: "plain_text" as const, content: isDone ? "💭 思考完成" : "💭 思考中..." },
    template: (isDone ? "purple" : "wathet") as string,
  };
  if (!text) {
    return {
      config: { wide_screen_mode: true },
      header,
      elements: [{ tag: "markdown", content: "正在分析..." }],
    };
  }
  return {
    config: { wide_screen_mode: true },
    header,
    elements: [{ tag: "note" as const, elements: [{ tag: "plain_text" as const, content: text }] }],
  };
}

/** Build a unified activity card with todo-list style tool tracking. */
function buildActivityCard(items: ToolItem[]): object {
  const lines: string[] = [];
  for (const item of items) {
    const mark = STATUS_MARKS[item.status] ?? STATUS_MARKS["pending"];
    lines.push(`- ${mark} \`${item.title}\` (${item.kind})`);
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text" as const, content: "📋 Agent 工作中" },
      template: "blue" as const,
    },
    elements: [{ tag: "markdown", content: lines.join("\n") || "准备中..." }],
  };
}

const STATUS_MARKS: Record<ToolItem["status"], string> = {
  pending:   "- [ ]",
  in_progress: "[⏳]",
  completed: "[✅]",
  failed:    "[❌]",
};

export interface FeishuClientOpts {
  appId: string;
  appSecret: string;
}

export interface ToolItem {
  title: string;
  kind: string;
  status: "pending" | "in_progress" | "completed" | "failed";
}

export class FeishuClient {
  private client: Lark.Client;
  private userNameCache = new Map<string, string>();
  private chatNameCache = new Map<string, string>();
  private botOpenId: string | null = null;

  constructor(opts: FeishuClientOpts) {
    this.client = new Lark.Client({
      appId: opts.appId,
      appSecret: opts.appSecret,
      appType: Lark.AppType.SelfBuild,
      // Suppress internal SDK logs
      loggerLevel: Lark.LoggerLevel.error,
    });
  }

  /** Fetch cached bot open_id. */
  async getBotOpenId(): Promise<string> {
    if (this.botOpenId) return this.botOpenId;
    try {
      const res = await (this.client as any).request({
        method: "GET",
        url: "/open-apis/bot/v3/info",
      });
      this.botOpenId = (res?.bot?.open_id as string) ?? "";
    } catch {
      this.botOpenId = "";
    }
    return this.botOpenId ?? "";
  }

  /** Fetch and cache user display name by open_id. */
  async getUserName(openId: string): Promise<string> {
    const cached = this.userNameCache.get(openId);
    if (cached) return cached;

    try {
      const res = await (this.client as any).request({
        method: "GET",
        url: `/open-apis/contact/v3/users/${openId}`,
        params: { user_id_type: "open_id" },
      });
      const name: string = res?.data?.user?.name ?? openId;
      this.userNameCache.set(openId, name);
      return name;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[lark-acp] getUserName failed for ${openId}: ${msg}`);
      this.userNameCache.set(openId, openId);
      return openId;
    }
  }

  /** Fetch and cache chat name by chat_id. Returns empty string for P2P chats. */
  async getChatName(chatId: string): Promise<string> {
    const cached = this.chatNameCache.get(chatId);
    if (cached !== undefined) return cached;

    try {
      const res = await (this.client as any).request({
        method: "GET",
        url: `/open-apis/im/v1/chats/${chatId}`,
      });
      const name: string = res?.data?.name ?? "";
      this.chatNameCache.set(chatId, name);
      return name;
    } catch {
      this.chatNameCache.set(chatId, "");
      return "";
    }
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
    chatId: string,
  ): Promise<void> {
    const card = buildPermissionCard(params, requestId, chatId);
    await this.client.im.message.reply({
      path: { message_id: messageId },
      data: {
        content: JSON.stringify(card),
        msg_type: "interactive",
        reply_in_thread: false,
      },
    });
  }

  /** Replace the permission card with a confirmation card showing the user's selection. */
  async updatePermissionCard(
    messageId: string,
    toolKind: string,
    toolTitle: string,
    selectedName: string,
  ): Promise<void> {
    const card = buildResolvedCard(toolKind, toolTitle, selectedName);
    await (this.client as any).request({
      method: "PATCH",
      url: `/open-apis/im/v1/messages/${messageId}`,
      data: {
        content: JSON.stringify(card),
        msg_type: "interactive",
      },
    });
  }

  /** Create a "thinking" card as a reply. Returns the card's message_id. */
  async sendThinkingCard(replyToMessageId: string): Promise<string | null> {
    try {
      const res = await this.client.im.message.reply({
        path: { message_id: replyToMessageId },
        data: {
          content: JSON.stringify(buildThinkingCard()),
          msg_type: "interactive",
          reply_in_thread: false,
        },
      });
      return (res as any)?.data?.message_id ?? null;
    } catch {
      return null;
    }
  }

  /** Update a thinking card with content and optional done status. */
  async updateThinkingCard(cardMessageId: string, thoughtText: string, isDone: boolean): Promise<void> {
    const card = buildThinkingCard(thoughtText, isDone);
    await (this.client as any).request({
      method: "PATCH",
      url: `/open-apis/im/v1/messages/${cardMessageId}`,
      data: {
        content: JSON.stringify(card),
        msg_type: "interactive",
      },
    }).catch(() => {});
  }

  /** Create the unified activity card. Returns the card's message_id. */
  async sendActivityCard(replyToMessageId: string, items: ToolItem[]): Promise<string | null> {
    try {
      const res = await this.client.im.message.reply({
        path: { message_id: replyToMessageId },
        data: {
          content: JSON.stringify(buildActivityCard(items)),
          msg_type: "interactive",
          reply_in_thread: false,
        },
      });
      return (res as any)?.data?.message_id ?? null;
    } catch {
      return null;
    }
  }

  /** Update the activity card with the latest tool items. */
  async updateActivityCard(cardMessageId: string, items: ToolItem[]): Promise<void> {
    await (this.client as any).request({
      method: "PATCH",
      url: `/open-apis/im/v1/messages/${cardMessageId}`,
      data: {
        content: JSON.stringify(buildActivityCard(items)),
        msg_type: "interactive",
      },
    }).catch(() => {});
  }
}
