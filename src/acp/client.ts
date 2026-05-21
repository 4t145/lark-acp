/**
 * ACP Client implementation for Feishu.
 *
 * Implements acp.Client: accumulates text chunks, sends interactive cards
 * for permission requests, provides filesystem read/write access for the agent.
 */

import fs from "node:fs";
import crypto from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import type { ToolItem } from "../feishu/client.js";

interface PendingPermission {
  requestId: string;
  resolve: (value: acp.RequestPermissionResponse) => void;
}

export interface FeishuAcpClientOpts {
  onTyping: () => Promise<void>;
  onThought: (text: string) => Promise<void>;
  showThoughts: boolean;
  sendInterruptCard: (messageId: string, params: acp.RequestPermissionRequest, requestId: string, chatId: string) => Promise<void>;
  sendThinkingCard: (replyToMessageId: string) => Promise<string | null>;
  updateThinkingCard: (cardMessageId: string, thoughtText: string, isDone: boolean) => Promise<void>;
  sendActivityCard: (replyToMessageId: string, items: ToolItem[]) => Promise<string | null>;
  updateActivityCard: (cardMessageId: string, items: ToolItem[]) => Promise<void>;
  log: (msg: string) => void;
}

export class FeishuAcpClient implements acp.Client {
  private chunks: string[] = [];
  private thoughtChunks: string[] = [];
  private opts: FeishuAcpClientOpts;
  private lastTypingAt = 0;
  private currentMessageId = "";
  private currentChatId = "";
  private static readonly TYPING_INTERVAL_MS = 5_000;

  /** Tracks all in-flight permission requests (supports concurrent requests). */
  private pendingPermissions: Map<string, PendingPermission> = new Map();

  /** Tracks the thinking card message ID for incremental updates. */
  private thinkingCardId: string | null = null;

  /** Prevents concurrent thinking card creation (race condition guard). */
  private thinkingCardCreating: Promise<string | null> | null = null;

  /** Unified activity card — tracks all tool items in this prompt turn. */
  private activityCardId: string | null = null;
  private toolItems: ToolItem[] = [];
  private toolCallIds: string[] = [];

  constructor(opts: FeishuAcpClientOpts) {
    this.opts = opts;
  }

  updateCallbacks(cbs: { onTyping: () => Promise<void>; onThought: (text: string) => Promise<void> }): void {
    this.opts = { ...this.opts, ...cbs };
  }

  /** Store the current message context so requestPermission knows where to send the card. */
  setContext(messageId: string, chatId: string): void {
    this.currentMessageId = messageId;
    this.currentChatId = chatId;
  }

  async requestPermission(params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const prvAllow = params.options.find((o) => o.kind === "allow_once" || o.kind === "allow_always");
    const defaultOptionId = prvAllow?.optionId ?? params.options[0]?.optionId ?? "allow";

    if (!this.currentMessageId) {
      this.opts.log(`[permission] no message context, auto-allow: ${params.toolCall?.title ?? "unknown"}`);
      return { outcome: { outcome: "selected", optionId: defaultOptionId } };
    }

    const requestId = crypto.randomUUID();

    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      const pp: PendingPermission = { requestId, resolve };
      this.pendingPermissions.set(requestId, pp);

      this.opts.sendInterruptCard(this.currentMessageId, params, requestId, this.currentChatId).catch((err) => {
        this.opts.log(`[permission] failed to send card: ${String(err)}`);
        if (this.pendingPermissions.get(requestId)?.requestId === requestId) {
          this.pendingPermissions.delete(requestId);
        }
        resolve({ outcome: { outcome: "selected", optionId: defaultOptionId } });
      });
    });
  }

  /** Resolve a pending permission request from a card action event. */
  handleCardAction(requestId: string, optionId: string): boolean {
    const pp = this.pendingPermissions.get(requestId);
    if (!pp) return false;

    this.pendingPermissions.delete(requestId);
    pp.resolve({ outcome: { outcome: "selected", optionId } });
    return true;
  }

  /** Cancel all pending permission requests (e.g. on /cancel). Resolves with cancelled outcome. */
  cancelPendingPermission(): void {
    for (const [requestId, pp] of this.pendingPermissions) {
      pp.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pendingPermissions.clear();
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const u = params.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type === "text") {
          const snippet = u.content.text.substring(0, 60).replace(/\n/g, "\\n");
          this.opts.log(`[event] message_chunk len=${u.content.text.length} "${snippet}..."`);
          this.chunks.push(u.content.text);
        }
        await this.maybeSendTyping();
        break;

      case "agent_thought_chunk":
        if (u.content.type === "text") {
          this.opts.log(`[event] thought_chunk len=${u.content.text.length}`);
          if (this.opts.showThoughts) {
            this.thoughtChunks.push(u.content.text);
            this.createThinkingCardIfNeeded().catch((err) => {
              this.opts.log(`[think-card] create failed: ${String(err)}`);
            });
          }
        }
        await this.maybeSendTyping();
        break;

      case "tool_call": {
        const title = u.title ?? "unknown";
        const kind = u.kind ?? "tool";
        const toolCallId = (u as Record<string, unknown>).toolCallId as string | undefined;
        const status = (u.status ?? "in_progress") as ToolItem["status"];
        this.opts.log(`[event] tool_call id=${toolCallId ?? "?"} title="${title}" kind=${kind} status=${status}`);
        this.upsertToolItem(toolCallId, title, kind, status);
        this.refreshActivityCard().catch(() => {});
        await this.maybeSendTyping();
        break;
      }

      case "tool_call_update": {
        const toolCallId = (u as Record<string, unknown>).toolCallId as string;
        this.opts.log(`[event] tool_call_update id=${toolCallId} status=${u.status}`);
        if (u.status === "completed" || u.status === "failed") {
          const kind = u.kind ?? "tool";
          let diffText: string | undefined;
          if (u.content) {
            for (const c of u.content) {
              if (c.type === "diff") {
                const diff = c as acp.Diff;
                const lines: string[] = [`--- ${diff.path}`];
                diff.oldText?.split("\n").forEach((l) => lines.push(`- ${l}`));
                diff.newText?.split("\n").forEach((l) => lines.push(`+ ${l}`));
                diffText = lines.join("\n");
                this.chunks.push("\n```diff\n" + diffText + "\n```\n");
              }
            }
          }
          const status = u.status as ToolItem["status"];
          this.upsertToolItem(toolCallId, u.title ?? "unknown", kind, status);
          this.refreshActivityCard().catch(() => {});
        }
        break;
      }
    }
  }

  async readTextFile(params: acp.ReadTextFileRequest): Promise<acp.ReadTextFileResponse> {
    const content = await fs.promises.readFile(params.path, "utf-8");
    return { content };
  }

  async writeTextFile(params: acp.WriteTextFileRequest): Promise<acp.WriteTextFileResponse> {
    await fs.promises.writeFile(params.path, params.content, "utf-8");
    return {};
  }

  /** Flush accumulated text (and thoughts) — resets internal buffers. */
  async flush(): Promise<string> {
    await this.finalizeThinkingCard();
    const text = this.chunks.join("");
    this.chunks = [];
    this.lastTypingAt = 0;
    return text;
  }

  private async createThinkingCardIfNeeded(): Promise<void> {
    if (this.thinkingCardId) return;
    if (this.thinkingCardCreating) {
      // Another call is already creating the card; wait for its result
      this.opts.log(`[think-card] waiting for in-flight creation`);
      const id = await this.thinkingCardCreating;
      if (id) this.thinkingCardId = id;
      return;
    }
    if (!this.currentMessageId) return;

    this.opts.log(`[think-card] creating...`);
    const promise = this.opts.sendThinkingCard(this.currentMessageId);
    this.thinkingCardCreating = promise;
    try {
      const id = await promise;
      if (id) {
        this.thinkingCardId = id;
        this.opts.log(`[think-card] created id=${id}`);
      } else {
        this.opts.log(`[think-card] create returned null`);
      }
    } finally {
      this.thinkingCardCreating = null;
    }
  }

  /** Update the thinking card with final content and mark it done. Called only at end of prompt. */
  private async finalizeThinkingCard(): Promise<void> {
    const id = this.thinkingCardId;
    if (!id) return;
    this.thinkingCardId = null;
    const text = this.thoughtChunks.join("");
    this.thoughtChunks = [];
    this.opts.log(`[think-card] finalize id=${id} text_len=${text.length} chunks=${this.thoughtChunks.length}`);
    await this.opts.updateThinkingCard(id, text || "（空）", true).catch((err) => {
      this.opts.log(`[think-card] finalize update failed: ${String(err)}`);
    });
  }

  private upsertToolItem(
    toolCallId: string | undefined,
    title: string,
    kind: string,
    status: ToolItem["status"],
  ): void {
    const key = toolCallId ?? `${kind}:${title}`;
    // Replace or append
    const idx = this.toolItems.findIndex((item, i) => {
      if (toolCallId && toolCallId === this.toolCallIds[i]) return true;
      return item.title === title && item.kind === kind && status !== "failed"; // don't match failed items
    });
    if (idx >= 0) {
      this.toolItems[idx] = { title, kind, status };
      if (toolCallId) this.toolCallIds[idx] = toolCallId;
    } else {
      this.toolItems.push({ title, kind, status });
      this.toolCallIds.push(toolCallId ?? "");
    }
  }

  private async refreshActivityCard(): Promise<void> {
    if (!this.currentMessageId) return;

    if (!this.activityCardId) {
      const id = await this.opts.sendActivityCard(this.currentMessageId, this.toolItems);
      if (id) {
        this.activityCardId = id;
        this.opts.log(`[activity-card] created id=${id} items=${this.toolItems.length}`);
      } else {
        this.opts.log(`[activity-card] create returned null`);
      }
      return;
    }
    this.opts.log(`[activity-card] updating id=${this.activityCardId} items=${this.toolItems.length}`);
    await this.opts.updateActivityCard(this.activityCardId, this.toolItems).catch((err) => {
      this.opts.log(`[activity-card] update failed: ${String(err)}`);
    });
  }

  private async maybeSendTyping(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTypingAt < FeishuAcpClient.TYPING_INTERVAL_MS) return;
    this.lastTypingAt = now;
    await this.opts.onTyping().catch(() => {});
  }
}
