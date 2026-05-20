/**
 * ACP Client implementation for Feishu.
 *
 * Implements acp.Client: accumulates text chunks, sends interactive cards
 * for permission requests, provides filesystem read/write access for the agent.
 */

import fs from "node:fs";
import crypto from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";

/** Timeout for waiting on user's card action response before auto-allowing. */
const PERMISSION_TIMEOUT_MS = 60_000;

interface PendingPermission {
  requestId: string;
  resolve: (value: acp.RequestPermissionResponse) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface FeishuAcpClientOpts {
  onTyping: () => Promise<void>;
  onThought: (text: string) => Promise<void>;
  showThoughts: boolean;
  sendInterruptCard: (messageId: string, params: acp.RequestPermissionRequest, requestId: string) => Promise<void>;
  log: (msg: string) => void;
}

export class FeishuAcpClient implements acp.Client {
  private chunks: string[] = [];
  private thoughtChunks: string[] = [];
  private opts: FeishuAcpClientOpts;
  private lastTypingAt = 0;
  private currentMessageId = "";
  private static readonly TYPING_INTERVAL_MS = 5_000;

  /** Tracks the single in-flight permission request (one per prompt turn). */
  private pendingPermission: PendingPermission | null = null;

  constructor(opts: FeishuAcpClientOpts) {
    this.opts = opts;
  }

  updateCallbacks(cbs: { onTyping: () => Promise<void>; onThought: (text: string) => Promise<void> }): void {
    this.opts = { ...this.opts, ...cbs };
  }

  /** Store the current message context so requestPermission knows where to send the card. */
  setContext(messageId: string): void {
    this.currentMessageId = messageId;
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
      const timer = setTimeout(() => {
        this.opts.log(`[permission] timeout, auto-allow: ${params.toolCall?.title ?? "unknown"}`);
        if (this.pendingPermission?.requestId === requestId) {
          this.pendingPermission = null;
        }
        resolve({ outcome: { outcome: "selected", optionId: defaultOptionId } });
      }, PERMISSION_TIMEOUT_MS);

      this.pendingPermission = { requestId, resolve, timer };

      this.opts.sendInterruptCard(this.currentMessageId, params, requestId).catch((err) => {
        this.opts.log(`[permission] failed to send card: ${String(err)}`);
        // Fall back to auto-allow on send failure
        clearTimeout(timer);
        if (this.pendingPermission?.requestId === requestId) {
          this.pendingPermission = null;
        }
        resolve({ outcome: { outcome: "selected", optionId: defaultOptionId } });
      });
    });
  }

  /** Resolve a pending permission request from a card action event. */
  handleCardAction(requestId: string, optionId: string): boolean {
    const pp = this.pendingPermission;
    if (!pp || pp.requestId !== requestId) return false;

    clearTimeout(pp.timer);
    this.pendingPermission = null;
    pp.resolve({ outcome: { outcome: "selected", optionId } });
    return true;
  }

  /** Cancel any pending permission request (e.g. on /cancel). Resolves with cancelled outcome. */
  cancelPendingPermission(): void {
    const pp = this.pendingPermission;
    if (!pp) return;

    clearTimeout(pp.timer);
    this.pendingPermission = null;
    pp.resolve({ outcome: { outcome: "cancelled" } });
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const u = params.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        await this.flushThoughts();
        if (u.content.type === "text") this.chunks.push(u.content.text);
        await this.maybeSendTyping();
        break;

      case "agent_thought_chunk":
        if (u.content.type === "text") {
          this.opts.log(`[thought] ${u.content.text.substring(0, 80)}`);
          if (this.opts.showThoughts) this.thoughtChunks.push(u.content.text);
        }
        await this.maybeSendTyping();
        break;

      case "tool_call":
        await this.flushThoughts();
        this.opts.log(`[tool] ${u.title} (${u.status})`);
        await this.maybeSendTyping();
        break;

      case "tool_call_update":
        if (u.status === "completed" && u.content) {
          for (const c of u.content) {
            if (c.type === "diff") {
              const diff = c as acp.Diff;
              const lines: string[] = [`--- ${diff.path}`];
              diff.oldText?.split("\n").forEach((l) => lines.push(`- ${l}`));
              diff.newText?.split("\n").forEach((l) => lines.push(`+ ${l}`));
              this.chunks.push("\n```diff\n" + lines.join("\n") + "\n```\n");
            }
          }
        }
        break;
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
    await this.flushThoughts();
    const text = this.chunks.join("");
    this.chunks = [];
    this.lastTypingAt = 0;
    return text;
  }

  private async flushThoughts(): Promise<void> {
    if (!this.thoughtChunks.length) return;
    const text = this.thoughtChunks.join("");
    this.thoughtChunks = [];
    if (text.trim()) {
      await this.opts.onThought(`💭 Thinking...\n${text}`).catch(() => {});
    }
  }

  private async maybeSendTyping(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTypingAt < FeishuAcpClient.TYPING_INTERVAL_MS) return;
    this.lastTypingAt = now;
    await this.opts.onTyping().catch(() => {});
  }
}
