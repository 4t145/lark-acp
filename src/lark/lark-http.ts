import * as Lark from "@larksuiteoapi/node-sdk";
import type { LarkLogger } from "../logger/logger.js";

const REACTION_THINKING = "THINKING";

// `bot/v3/info` is the only Lark Open API the official SDK doesn't surface
// as a typed method (it has no `client.bot` namespace), so we hit it raw.
// All other endpoints below go through the SDK's typed clients.
const BOT_INFO_URL = "/open-apis/bot/v3/info";

export interface LarkHttpOptions {
    appId: string;
    appSecret: string;
    logger: LarkLogger;
}

/**
 * Thin wrapper around `@larksuiteoapi/node-sdk` that:
 *
 * - Owns one shared `Lark.Client` instance.
 * - Caches user / chat display names and the bot's own `open_id`.
 * - Exposes the few raw operations the presenter and bridge need
 *   (reply, react, PATCH a card, look up display names).
 *
 * Intentionally has **no** card-specific knowledge — presenters build
 * card payloads and pass them in.
 */
export class LarkHttpClient {
    private readonly client: Lark.Client;
    private readonly logger: LarkLogger;
    private readonly userNameCache = new Map<string, string>();
    private readonly chatNameCache = new Map<string, string>();
    private botOpenId: string | null = null;

    constructor(opts: LarkHttpOptions) {
        this.client = new Lark.Client({
            appId: opts.appId,
            appSecret: opts.appSecret,
            appType: Lark.AppType.SelfBuild,
            loggerLevel: Lark.LoggerLevel.error,
        });
        this.logger = opts.logger.child({ name: "lark-http" });
    }

    /** The underlying SDK client, exposed for callers that need to register
     *  event dispatchers (WSClient lives in `lark-ws.ts`, not here). */
    get sdk(): Lark.Client {
        return this.client;
    }

    /**
     * Fetch and cache the bot's own `open_id` from `bot/v3/info`.
     *
     * Cached forever once successful — a self-build bot's own id is
     * stable. Failures are **not** cached, so a transient outage doesn't
     * permanently break group `@bot` mention detection.
     *
     * @throws when the SDK call rejects, or when the response is missing
     *   `bot.open_id` (a malformed payload from the Lark API).
     */
    async getBotOpenId(): Promise<string> {
        if (this.botOpenId !== null) return this.botOpenId;

        const res = await this.client.request<{ bot?: { open_id?: string } }>({
            url: BOT_INFO_URL,
        });
        const openId = res?.bot?.open_id;
        if (typeof openId !== "string" || openId.length === 0) {
            throw new Error(
                `bot/v3/info returned no open_id (payload: ${JSON.stringify(res)})`,
            );
        }

        this.botOpenId = openId;
        return openId;
    }

    /** Cached user display name. Falls back to the `openId` itself on failure. */
    async getUserName(openId: string): Promise<string> {
        const cached = this.userNameCache.get(openId);
        if (cached !== undefined) return cached;

        try {
            const res = await this.client.contact.v3.user.get({
                path: { user_id: openId },
                params: { user_id_type: "open_id" },
            });
            const name = res.data?.user?.name ?? openId;
            this.userNameCache.set(openId, name);
            return name;
        } catch (err) {
            this.logger.warn({ err, openId }, "getUserName failed");
            this.userNameCache.set(openId, openId);
            return openId;
        }
    }

    /** Cached chat name (empty string for P2P / unknown). */
    async getChatName(chatId: string): Promise<string> {
        const cached = this.chatNameCache.get(chatId);
        if (cached !== undefined) return cached;

        try {
            const res = await this.client.im.v1.chat.get({
                path: { chat_id: chatId },
            });
            const name = res.data?.name ?? "";
            this.chatNameCache.set(chatId, name);
            return name;
        } catch (err) {
            this.logger.warn({ err, chatId }, "getChatName failed");
            this.chatNameCache.set(chatId, "");
            return "";
        }
    }

    /**
     * Reply to `messageId` with an interactive card payload (already serialised
     * to a JS object by the caller).
     *
     * Returns the new card message's `message_id` if the SDK surfaces it.
     *
     * @throws when the underlying SDK call rejects.
     */
    async replyCard(messageId: string, card: object): Promise<string | null> {
        const res = await this.client.im.message.reply({
            path: { message_id: messageId },
            data: {
                content: JSON.stringify(card),
                msg_type: "interactive",
                reply_in_thread: false,
            },
        });
        return res.data?.message_id ?? null;
    }

    /**
     * Reply to `messageId` with a `post` rich-text payload. The body is
     * the inner content (`{ title?, content }`); we wrap it in the
     * required `{ zh_cn: ... }` envelope before serialising.
     *
     * @throws when the underlying SDK call rejects.
     */
    async replyPost(messageId: string, post: object): Promise<string | null> {
        const res = await this.client.im.message.reply({
            path: { message_id: messageId },
            data: {
                content: JSON.stringify({ zh_cn: post }),
                msg_type: "post",
                reply_in_thread: false,
            },
        });
        return res.data?.message_id ?? null;
    }

    /** Send a fresh interactive card to a chat (no reply context). */
    async sendCardToChat(chatId: string, card: object): Promise<string | null> {
        const res = await this.client.im.message.create({
            params: { receive_id_type: "chat_id" },
            data: {
                receive_id: chatId,
                content: JSON.stringify(card),
                msg_type: "interactive",
            },
        });
        return res.data?.message_id ?? null;
    }

    /** PATCH an existing interactive message with a new card payload. */
    async patchCard(messageId: string, card: object): Promise<void> {
        await this.client.im.v1.message.patch({
            path: { message_id: messageId },
            data: { content: JSON.stringify(card) },
        });
    }

    /** Add an emoji reaction. Returns the reaction id (needed to remove it). */
    async addReaction(
        messageId: string,
        emoji: string = REACTION_THINKING,
    ): Promise<string | null> {
        try {
            const res = await this.client.im.messageReaction.create({
                path: { message_id: messageId },
                data: { reaction_type: { emoji_type: emoji } },
            });
            return res.data?.reaction_id ?? null;
        } catch (err) {
            this.logger.warn({ err, messageId }, "addReaction failed");
            return null;
        }
    }

    async removeReaction(messageId: string, reactionId: string): Promise<void> {
        try {
            await this.client.im.messageReaction.delete({
                path: { message_id: messageId, reaction_id: reactionId },
            });
        } catch (err) {
            this.logger.debug(
                { err, messageId, reactionId },
                "removeReaction best-effort failed",
            );
        }
    }

    /**
     * Download a user-sent image attached to a message and return its raw
     * bytes plus content-type.
     *
     * Uses `im.messageResource.get` (the only resource endpoint that works
     * for user uploads — `im.image.get` is restricted to the bot's own
     * uploads per Lark docs).
     *
     * @throws when the SDK call rejects or the stream cannot be drained.
     */
    async downloadMessageImage(
        messageId: string,
        imageKey: string,
    ): Promise<{ bytes: Buffer; mimeType: string }> {
        const res = await this.client.im.messageResource.get({
            path: { message_id: messageId, file_key: imageKey },
            params: { type: "image" },
        });

        const chunks: Buffer[] = [];
        for await (const chunk of res.getReadableStream()) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
        }
        const bytes = Buffer.concat(chunks);

        const headers = res.headers as Record<string, string | string[] | undefined> | undefined;
        const raw = headers?.["content-type"];
        const headerValue = Array.isArray(raw) ? raw[0] : raw;
        // strip charset / boundary suffix, e.g. "image/png; charset=utf-8"
        const mimeType = headerValue?.split(";")[0]?.trim() || sniffImageMime(bytes);

        return { bytes, mimeType };
    }
}

// Magic-byte sniff for the MIME types Lark accepts (per `im.image.create`
// docs: JPEG, PNG, WEBP, GIF, TIFF, BMP, ICO). Falls back to PNG — a safe
// default that every ACP-aware agent renderer must accept.
function sniffImageMime(buf: Buffer): string {
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return "image/png";
    }
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        return "image/jpeg";
    }
    if (buf.length >= 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
        return "image/gif";
    }
    if (
        buf.length >= 12 &&
        buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
        buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
    ) {
        return "image/webp";
    }
    if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
        return "image/bmp";
    }
    return "image/png";
}
