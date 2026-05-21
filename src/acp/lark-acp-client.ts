import fs from "node:fs";
import crypto from "node:crypto";
import type * as acp from "@agentclientprotocol/sdk";
import type { LarkLogger } from "../logger/logger.js";
import type { LarkPresenter, ToolItem } from "../presenter/presenter.js";

const TYPING_INTERVAL_MS = 5_000;
const ACTIVITY_FLUSH_DEBOUNCE_MS = 100;
const EMPTY_THOUGHT_PLACEHOLDER = "（空）";

const PERMISSION_TIMEOUT_REASON = "用户未在规定时间内响应，已自动取消";
const PERMISSION_SHUTDOWN_REASON = "会话已结束，本次确认已失效";

interface PendingPermission {
  requestId: string;
  resolve: (value: acp.RequestPermissionResponse) => void;
  timer: ReturnType<typeof setTimeout> | null;
  /** Card message id, set once `sendInterruptCard` resolves. */
  cardMessageId: string | null;
}

export interface LarkAcpClientCallbacks {
  /** Called whenever the agent emits activity — used to refresh "typing" indicator. */
  onTyping: () => Promise<void>;
}

export interface LarkAcpClientOptions {
  presenter: LarkPresenter;
  logger: LarkLogger;
  showThoughts: boolean;
  callbacks: LarkAcpClientCallbacks;
  /** Resolve a pending permission as `cancelled` after this many ms (0 = never). */
  permissionTimeoutMs: number;
}

/**
 * `acp.Client` implementation for one Feishu chat. Buffers text chunks,
 * renders permission cards via {@link LarkPresenter}, and provides agent
 * filesystem access.
 *
 * One instance per chat — it holds per-prompt state (current message id,
 * activity card id, pending permissions).
 */
export class LarkAcpClient implements acp.Client {
  private readonly presenter: LarkPresenter;
  private readonly logger: LarkLogger;
  private readonly showThoughts: boolean;
  private readonly permissionTimeoutMs: number;
  private callbacks: LarkAcpClientCallbacks;

  private chunks: string[] = [];
  private thoughtChunks: string[] = [];
  private lastTypingAt = 0;
  private currentMessageId = "";
  private currentChatId = "";

  private readonly pendingPermissions = new Map<string, PendingPermission>();

  private thinkingCardId: string | null = null;
  private thinkingCardCreating: Promise<string | null> | null = null;

  private activityCardId: string | null = null;
  private readonly toolItems = new Map<string, ToolItem>();
  private activityFlushTimer: ReturnType<typeof setTimeout> | null = null;
  private activityFlushing = false;

  constructor(opts: LarkAcpClientOptions) {
    this.presenter = opts.presenter;
    this.logger = opts.logger.child({ name: "acp-client" });
    this.showThoughts = opts.showThoughts;
    this.permissionTimeoutMs = opts.permissionTimeoutMs;
    this.callbacks = opts.callbacks;
  }

  updateCallbacks(cbs: LarkAcpClientCallbacks): void {
    this.callbacks = cbs;
  }

  /** Bind the current Feishu message context so cards reply to the right message. */
  setContext(messageId: string, chatId: string): void {
    this.currentMessageId = messageId;
    this.currentChatId = chatId;
  }

  async requestPermission(
    params: acp.RequestPermissionRequest,
  ): Promise<acp.RequestPermissionResponse> {
    if (!this.currentMessageId) {
      // No card can be sent → cannot get user consent → must reject.
      this.logger.warn(
        { tool: params.toolCall?.title ?? "unknown" },
        "no message context — cancelling permission request",
      );
      return { outcome: { outcome: "cancelled" } };
    }

    const requestId = crypto.randomUUID();

    return new Promise<acp.RequestPermissionResponse>((resolve) => {
      const pending: PendingPermission = {
        requestId,
        resolve,
        timer: null,
        cardMessageId: null,
      };
      this.pendingPermissions.set(requestId, pending);

      if (this.permissionTimeoutMs > 0) {
        pending.timer = setTimeout(
          () => this.expirePendingPermission(requestId, PERMISSION_TIMEOUT_REASON),
          this.permissionTimeoutMs,
        );
      }

      this.presenter
        .sendInterruptCard(this.currentMessageId, params, requestId, this.currentChatId)
        .then((cardMessageId) => {
          // Pending may have been resolved/cleared while we were awaiting.
          const stillPending = this.pendingPermissions.get(requestId);
          if (stillPending) stillPending.cardMessageId = cardMessageId;
        })
        .catch((err) => {
          this.logger.warn({ err, requestId }, "sendInterruptCard failed");
          this.disposePending(requestId);
          // Card never reached the user — cannot infer consent. Cancel.
          resolve({ outcome: { outcome: "cancelled" } });
        });
    });
  }

  /** Resolve a pending permission request via a card action event. */
  handleCardAction(requestId: string, optionId: string): boolean {
    const pp = this.pendingPermissions.get(requestId);
    if (!pp) return false;
    this.disposePending(requestId);
    pp.resolve({ outcome: { outcome: "selected", optionId } });
    return true;
  }

  /** Cancel all in-flight permission requests (e.g. on user `/cancel` or shutdown). */
  cancelPendingPermission(): void {
    for (const requestId of [...this.pendingPermissions.keys()]) {
      this.expirePendingPermission(requestId, PERMISSION_SHUTDOWN_REASON);
    }
  }

  /**
   * Resolve a pending permission as cancelled and patch its card to a
   * "no longer actionable" state. Used by the timeout timer and by
   * shutdown / cancellation paths.
   */
  private expirePendingPermission(requestId: string, reason: string): void {
    const pp = this.pendingPermissions.get(requestId);
    if (!pp) return;
    this.disposePending(requestId);
    pp.resolve({ outcome: { outcome: "cancelled" } });

    const cardId = pp.cardMessageId;
    if (cardId) {
      this.presenter
        .expirePermissionCard(cardId, reason)
        .catch((err) =>
          this.logger.debug({ err, cardId }, "expirePermissionCard rejected"),
        );
    }
  }

  private disposePending(requestId: string): void {
    const pp = this.pendingPermissions.get(requestId);
    if (!pp) return;
    if (pp.timer) clearTimeout(pp.timer);
    this.pendingPermissions.delete(requestId);
  }

  async sessionUpdate(params: acp.SessionNotification): Promise<void> {
    const u = params.update;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content.type === "text") {
          this.chunks.push(u.content.text);
        }
        await this.maybeSendTyping();
        return;

      case "agent_thought_chunk":
        if (u.content.type === "text" && this.showThoughts) {
          this.thoughtChunks.push(u.content.text);
          this.createThinkingCardIfNeeded().catch((err) =>
            this.logger.warn({ err }, "thinking card creation failed"),
          );
        }
        await this.maybeSendTyping();
        return;

      case "tool_call": {
        const title = u.title ?? "unknown";
        const kind = u.kind ?? "tool";
        const toolCallId = (u as Record<string, unknown>).toolCallId as string | undefined;
        const rawInput = (u as Record<string, unknown>).rawInput;
        const detail = typeof rawInput === "string" ? rawInput : undefined;
        const status = (u.status ?? "in_progress") as ToolItem["status"];
        this.upsertToolItem(toolCallId, title, kind, status, detail);
        this.refreshActivityCard();
        await this.maybeSendTyping();
        return;
      }

      case "tool_call_update": {
        const toolCallId = (u as Record<string, unknown>).toolCallId as string;
        if (u.status !== "completed" && u.status !== "failed") return;

        if (u.content) {
          for (const c of u.content) {
            if (c.type !== "diff") continue;
            const diff = c as acp.Diff;
            const lines: string[] = [`--- ${diff.path}`];
            diff.oldText?.split("\n").forEach((l) => lines.push(`- ${l}`));
            diff.newText?.split("\n").forEach((l) => lines.push(`+ ${l}`));
            this.chunks.push("\n```diff\n" + lines.join("\n") + "\n```\n");
          }
        }
        const kind = u.kind ?? "tool";
        const status = u.status as ToolItem["status"];
        this.upsertToolItem(toolCallId, u.title ?? "unknown", kind, status);
        this.refreshActivityCard();
        return;
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

  /** Drain the accumulated text reply. Resets per-prompt state. */
  async flush(): Promise<string> {
    await this.finalizeThinkingCard();
    const text = this.chunks.join("");
    this.chunks = [];
    this.lastTypingAt = 0;
    this.activityCardId = null;
    this.toolItems.clear();
    if (this.activityFlushTimer) clearTimeout(this.activityFlushTimer);
    this.activityFlushing = false;
    return text;
  }

  private async createThinkingCardIfNeeded(): Promise<void> {
    if (this.thinkingCardId) return;
    if (this.thinkingCardCreating) {
      const id = await this.thinkingCardCreating;
      if (id) this.thinkingCardId = id;
      return;
    }
    if (!this.currentMessageId) return;

    const promise = this.presenter.sendThinkingCard(this.currentMessageId);
    this.thinkingCardCreating = promise;
    try {
      const id = await promise;
      if (id) this.thinkingCardId = id;
    } finally {
      this.thinkingCardCreating = null;
    }
  }

  private async finalizeThinkingCard(): Promise<void> {
    const id = this.thinkingCardId;
    if (!id) return;
    this.thinkingCardId = null;
    const text = this.thoughtChunks.join("");
    this.thoughtChunks = [];
    await this.presenter
      .updateThinkingCard(id, text || EMPTY_THOUGHT_PLACEHOLDER, true)
      .catch((err) => this.logger.warn({ err, id }, "updateThinkingCard failed"));
  }

  private upsertToolItem(
    toolCallId: string | undefined,
    title: string,
    kind: string,
    status: ToolItem["status"],
    detail?: string,
  ): void {
    const id = toolCallId ?? `${kind}:${title}:${this.toolItems.size}`;
    const existing = this.toolItems.get(id);
    if (existing) {
      if (title !== "unknown") existing.title = title;
      if (detail !== undefined) existing.detail = detail;
      existing.status = status;
    } else {
      this.toolItems.set(id, { title, kind, status, detail });
    }
  }

  private refreshActivityCard(): void {
    if (!this.currentMessageId) return;
    if (this.activityFlushing) return;
    if (this.activityFlushTimer) clearTimeout(this.activityFlushTimer);

    this.activityFlushTimer = setTimeout(() => {
      this.activityFlushTimer = null;
      this.flushActivityCard().catch((err) =>
        this.logger.warn({ err }, "activity card flush failed"),
      );
    }, ACTIVITY_FLUSH_DEBOUNCE_MS);
  }

  private async flushActivityCard(): Promise<void> {
    this.activityFlushing = true;
    try {
      const items = [...this.toolItems.values()];
      if (this.activityCardId === null) {
        const id = await this.presenter.sendActivityCard(this.currentMessageId, items);
        if (id) this.activityCardId = id;
      } else {
        await this.presenter.updateActivityCard(this.activityCardId, items);
      }
    } finally {
      this.activityFlushing = false;
    }
  }

  private async maybeSendTyping(): Promise<void> {
    const now = Date.now();
    if (now - this.lastTypingAt < TYPING_INTERVAL_MS) return;
    this.lastTypingAt = now;
    await this.callbacks.onTyping().catch((err) =>
      this.logger.debug({ err }, "onTyping rejected"),
    );
  }
}
