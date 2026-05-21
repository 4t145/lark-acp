import type * as acp from "@agentclientprotocol/sdk";

/** A single tool call as rendered in the activity card. */
export interface ToolItem {
  title: string;
  kind: string;
  status: "pending" | "in_progress" | "completed" | "failed";
  detail?: string;
}

/**
 * Surface the bridge uses to render itself to the user — every visible
 * artefact (replies, reactions, permission cards, thinking card, activity
 * card) goes through this interface.
 *
 * Default implementation is `LarkCardPresenter` (Lark / Feishu interactive
 * cards). Replace for testing (record-only presenter), plain-text mode,
 * or other chat platforms in the future.
 */
export interface LarkPresenter {
  /**
   * Reply to `messageId` with plain-ish text. The presenter is free to wrap
   * it in whatever container the underlying platform needs (e.g. a markdown
   * card).
   *
   * @throws when the underlying transport rejects.
   */
  replyText(messageId: string, text: string): Promise<void>;

  /**
   * Add a "typing" / "thinking" indicator. Returns an opaque id that must
   * be passed back to {@link removeReaction}, or `null` if the indicator
   * could not be created.
   */
  addReaction(messageId: string, emoji?: string): Promise<string | null>;

  /** Remove a previously-added reaction. Best-effort. */
  removeReaction(messageId: string, reactionId: string): Promise<void>;

  /**
   * Render an ACP permission request as an interactive prompt the user can
   * resolve. The presenter must encode `requestId` and `chatId` into the
   * action payload so the bridge can match the user's response back to the
   * pending request.
   *
   * Returns the new card's id so callers can later patch it (e.g. on
   * timeout). Returns `null` if the underlying transport did not surface
   * one.
   *
   * @throws when the underlying transport rejects.
   */
  sendInterruptCard(
    messageId: string,
    params: acp.RequestPermissionRequest,
    requestId: string,
    chatId: string,
  ): Promise<string | null>;

  /** Replace a previously-sent permission card with a "resolved" confirmation. */
  updatePermissionCard(
    messageId: string,
    toolKind: string,
    toolTitle: string,
    selectedName: string,
  ): Promise<void>;

  /**
   * Replace a previously-sent permission card with a "no longer actionable"
   * notice (timeout, session ended, etc.). Best-effort.
   */
  expirePermissionCard(messageId: string, reason: string): Promise<void>;

  /** Create a "thinking" card in reply to `replyToMessageId`. Returns the
   *  new card's id (used by {@link updateThinkingCard}), or `null` on failure. */
  sendThinkingCard(replyToMessageId: string): Promise<string | null>;

  updateThinkingCard(cardMessageId: string, thoughtText: string, isDone: boolean): Promise<void>;

  /** Create the activity / tool-list card. Returns the new card's id. */
  sendActivityCard(replyToMessageId: string, items: ToolItem[]): Promise<string | null>;

  updateActivityCard(cardMessageId: string, items: ToolItem[]): Promise<void>;
}
