import type * as acp from "@agentclientprotocol/sdk";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkHttpClient } from "../lark/lark-http.js";
import { markdownToPost, splitMarkdown } from "./lark-markdown.js";
import type { LarkPresenter, ToolItem } from "./presenter.js";

const STATUS_MARKS: Record<ToolItem["status"], string> = {
  pending: "- [ ]",
  in_progress: "[⏳]",
  completed: "[✅]",
  failed: "[❌]",
};

const HEADER_TEMPLATE_PERMISSION = "blue";
const HEADER_TEMPLATE_RESOLVED = "green";
const HEADER_TEMPLATE_EXPIRED = "grey";
const HEADER_TEMPLATE_THINKING_ACTIVE = "wathet";
const HEADER_TEMPLATE_THINKING_DONE = "purple";
const HEADER_TEMPLATE_ACTIVITY = "blue";

const EMPTY_THOUGHT_PLACEHOLDER = "（空）";
const THOUGHT_DEFAULT_TEXT = "正在分析...";
const ACTIVITY_DEFAULT_TEXT = "准备中...";

function buttonTypeForKind(kind: string): "primary" | "danger" | "default" {
  if (kind === "allow_always") return "primary";
  if (kind === "reject_once" || kind === "reject_always") return "danger";
  return "default";
}

function buildPermissionCard(
  params: acp.RequestPermissionRequest,
  requestId: string,
  chatId: string,
): object {
  const toolTitle = params.toolCall?.title ?? "unknown";
  const toolKind = params.toolCall?.kind ?? "tool";

  const elements: object[] = [
    { tag: "markdown", content: `**${toolKind}**: \`${toolTitle}\`` },
  ];

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

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text" as const, content: "Agent 需要确认" },
      template: HEADER_TEMPLATE_PERMISSION,
    },
    elements,
  };
}

function buildResolvedCard(toolKind: string, toolTitle: string, selectedName: string): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text" as const, content: "已确认" },
      template: HEADER_TEMPLATE_RESOLVED,
    },
    elements: [
      {
        tag: "markdown",
        content: `**${toolKind}**: \`${toolTitle}\`\n\n已选择: **${selectedName}**`,
      },
    ],
  };
}

function buildExpiredCard(reason: string): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text" as const, content: "已失效" },
      template: HEADER_TEMPLATE_EXPIRED,
    },
    elements: [{ tag: "markdown", content: reason }],
  };
}

function buildThinkingCard(text?: string, isDone?: boolean): object {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text" as const,
        content: isDone ? "💭 思考完成" : "💭 思考中...",
      },
      template: isDone ? HEADER_TEMPLATE_THINKING_DONE : HEADER_TEMPLATE_THINKING_ACTIVE,
    },
    elements: [{ tag: "markdown", content: text ?? THOUGHT_DEFAULT_TEXT }],
  };
}

function buildActivityCard(items: readonly ToolItem[]): object {
  const lines: string[] = [];
  for (const item of items) {
    const mark = STATUS_MARKS[item.status];
    const line = item.detail
      ? `- ${mark} \`${item.title}\` (${item.kind}): ${item.detail}`
      : `- ${mark} \`${item.title}\` (${item.kind})`;
    lines.push(line);
  }
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text" as const, content: "📋 Agent 工作中" },
      template: HEADER_TEMPLATE_ACTIVITY,
    },
    elements: [{ tag: "markdown", content: lines.join("\n") || ACTIVITY_DEFAULT_TEXT }],
  };
}

export interface LarkCardPresenterOptions {
  http: LarkHttpClient;
  logger: LarkLogger;
}

/**
 * Default {@link LarkPresenter} implementation using Lark / Feishu
 * interactive cards via {@link LarkHttpClient}.
 */
export class LarkCardPresenter implements LarkPresenter {
  private readonly http: LarkHttpClient;
  private readonly logger: LarkLogger;

  constructor(opts: LarkCardPresenterOptions) {
    this.http = opts.http;
    this.logger = opts.logger.child({ name: "presenter" });
  }

  async replyText(messageId: string, text: string): Promise<void> {
    for (const chunk of splitMarkdown(text)) {
      const post = markdownToPost(chunk);
      await this.http.replyPost(messageId, post);
    }
  }

  async addReaction(messageId: string, emoji?: string): Promise<string | null> {
    return this.http.addReaction(messageId, emoji);
  }

  async removeReaction(messageId: string, reactionId: string): Promise<void> {
    await this.http.removeReaction(messageId, reactionId);
  }

  async sendInterruptCard(
    messageId: string,
    params: acp.RequestPermissionRequest,
    requestId: string,
    chatId: string,
  ): Promise<string | null> {
    return this.http.replyCard(messageId, buildPermissionCard(params, requestId, chatId));
  }

  async updatePermissionCard(
    messageId: string,
    toolKind: string,
    toolTitle: string,
    selectedName: string,
  ): Promise<void> {
    await this.http.patchCard(messageId, buildResolvedCard(toolKind, toolTitle, selectedName));
  }

  async expirePermissionCard(messageId: string, reason: string): Promise<void> {
    try {
      await this.http.patchCard(messageId, buildExpiredCard(reason));
    } catch (err) {
      this.logger.warn({ err, messageId }, "expirePermissionCard failed");
    }
  }

  async sendThinkingCard(replyToMessageId: string): Promise<string | null> {
    try {
      return await this.http.replyCard(replyToMessageId, buildThinkingCard());
    } catch (err) {
      this.logger.warn({ err, replyToMessageId }, "sendThinkingCard failed");
      return null;
    }
  }

  async updateThinkingCard(cardMessageId: string, thoughtText: string, isDone: boolean): Promise<void> {
    const card = buildThinkingCard(thoughtText || EMPTY_THOUGHT_PLACEHOLDER, isDone);
    try {
      await this.http.patchCard(cardMessageId, card);
    } catch (err) {
      this.logger.warn({ err, cardMessageId }, "updateThinkingCard failed");
    }
  }

  async sendActivityCard(replyToMessageId: string, items: ToolItem[]): Promise<string | null> {
    try {
      return await this.http.replyCard(replyToMessageId, buildActivityCard(items));
    } catch (err) {
      this.logger.warn({ err, replyToMessageId }, "sendActivityCard failed");
      return null;
    }
  }

  async updateActivityCard(cardMessageId: string, items: ToolItem[]): Promise<void> {
    try {
      await this.http.patchCard(cardMessageId, buildActivityCard(items));
    } catch (err) {
      this.logger.warn({ err, cardMessageId }, "updateActivityCard failed");
    }
  }
}
