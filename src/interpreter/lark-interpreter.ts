/**
 * Lark message interpreter — translate a Lark / Feishu message event into
 * the ACP `ContentBlock[]` shape an agent expects as its prompt.
 *
 * Content shapes are based on the Lark Open Platform docs:
 * https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message/events/message_content
 */

import type * as acp from "@agentclientprotocol/sdk";
import type * as Lark from "@larksuiteoapi/node-sdk";
import type { LarkLogger } from "../logger/logger.js";

type LarkRawMention = NonNullable<Lark.RawMessageEvent["message"]["mentions"]>[number];

/**
 * Downloads a user-uploaded image referenced by `image_key` from a given
 * message. Implemented by {@link LarkHttpClient.downloadMessageImage} —
 * we accept just this minimal interface so the interpreter stays
 * decoupled from the HTTP client.
 */
export interface ImageDownloader {
  downloadMessageImage(
    messageId: string,
    imageKey: string,
  ): Promise<{ bytes: Buffer; mimeType: string }>;
}

export interface LarkInterpreterOptions {
  downloader: ImageDownloader;
  logger: LarkLogger;
}

// ---- Post message element types (matched to Lark docs) ----

interface PostElText {
  tag: "text";
  text: string;
  un_escape?: boolean;
  style?: ("bold" | "underline" | "lineThrough" | "italic")[];
}

interface PostElA {
  tag: "a";
  text?: string;
  href?: string;
  style?: string[];
}

interface PostElAt {
  tag: "at";
  user_id: string;
  user_name?: string;
  style?: string[];
}

interface PostElImg {
  tag: "img";
  image_key: string;
}

interface PostElMedia {
  tag: "media";
  file_key?: string;
  image_key?: string;
}

interface PostElEmotion {
  tag: "emotion";
  emoji_type: string;
}

interface PostElCodeBlock {
  tag: "code_block";
  language?: string;
  text: string;
}

interface PostElHr {
  tag: "hr";
}

type PostElement =
  | PostElText
  | PostElA
  | PostElAt
  | PostElImg
  | PostElMedia
  | PostElEmotion
  | PostElCodeBlock
  | PostElHr;

type PostParagraph = PostElement[];

interface PostPayload {
  title?: string;
  content?: PostParagraph[];
}

interface TextPayload {
  text?: string;
}

interface ImagePayload {
  image_key?: string;
}

interface FilePayload {
  file_key?: string;
  file_name?: string;
}

interface AudioPayload {
  file_key?: string;
  duration?: number;
}

interface MediaPayload {
  file_key?: string;
  image_key?: string;
  file_name?: string;
  duration?: number;
}

interface StickerPayload {
  file_key?: string;
}

interface ShareChatPayload {
  chat_id?: string;
}

interface ShareUserPayload {
  user_id?: string;
}

interface LocationPayload {
  name?: string;
  longitude?: string;
  latitude?: string;
}

// ---- Public API ----

/**
 * Translate a Lark inbound message event into the ACP `ContentBlock[]`
 * an agent expects as its prompt.
 *
 * Image messages and inline `<img>` tags inside `post` rich-text are
 * downloaded via {@link ImageDownloader} and embedded as base64
 * `ImageContent`. Other media types (file / audio / video / sticker) are
 * rendered as descriptive text — the agent learns about the attachment
 * but doesn't get the bytes.
 */
export async function larkMessageToPrompt(
  event: Lark.RawMessageEvent,
  opts: LarkInterpreterOptions,
): Promise<acp.ContentBlock[]> {
  const { message } = event;

  switch (message.message_type) {
    case "text":
      return parseText(message.content, message.mentions);
    case "post":
      return parsePost(message.content, message.message_id, opts);
    case "image":
      return parseImage(message.content, message.message_id, opts);
    case "file":
      return parseFile(message.content);
    case "audio":
      return parseAudio(message.content);
    case "media":
      return parseMedia(message.content);
    case "sticker":
      return parseSticker(message.content);
    case "share_chat":
      return parseShareChat(message.content);
    case "share_user":
      return parseShareUser(message.content);
    case "location":
      return parseLocation(message.content);
    case "merge_forward":
      return [{ type: "text", text: "[合并转发消息 — 请通过工具调用获取子消息]" }];
    default:
      return [{ type: "text", text: `[${message.message_type} 消息 — 暂不支持]` }];
  }
}

// ---- Private parsers ----

function parseText(raw: string, mentions?: LarkRawMention[]): acp.ContentBlock[] {
  const payload = safeParse<TextPayload>(raw);
  let text = payload?.text ?? "";

  if (mentions) {
    for (const m of mentions) {
      const key = m.key ?? "@_user_";
      const name = m.name ?? m.id?.open_id ?? key;
      text = text.replace(
        new RegExp(escapeRegExp(key), "g"),
        `@{${name}}`,
      );
    }
  }
  text = text.trim();
  if (!text) return [];
  return [{ type: "text", text }];
}

async function parsePost(
  raw: string,
  messageId: string,
  opts: LarkInterpreterOptions,
): Promise<acp.ContentBlock[]> {
  const payload = safeParse<PostPayload>(raw);
  if (!payload) return [{ type: "text", text: "[富文本消息解析失败]" }];

  const blocks: acp.ContentBlock[] = [];
  const lineBuffer: string[] = [];

  const flushLines = (): void => {
    if (!lineBuffer.length) return;
    const text = lineBuffer.join("\n").trim();
    lineBuffer.length = 0;
    if (text) blocks.push({ type: "text", text });
  };

  if (payload.title) {
    lineBuffer.push(`**${payload.title}**`, "");
  }

  const paragraphs = payload.content;
  if (!paragraphs?.length) {
    flushLines();
    return blocks;
  }

  for (const para of paragraphs) {
    if (!para.length) {
      lineBuffer.push("");
      continue;
    }

    const first = para[0];
    if (first?.tag === "code_block") {
      const lang = first.language ?? "";
      lineBuffer.push(`\`\`\`${lang}\n${first.text}\n\`\`\``);
      continue;
    }
    if (first?.tag === "hr") {
      lineBuffer.push("---");
      continue;
    }

    const lineParts: string[] = [];
    for (const el of para) {
      if (el.tag === "img") {
        // Cut the current text run, emit the image as its own block, then
        // continue accumulating text after the image.
        if (lineParts.length) {
          lineBuffer.push(lineParts.join(""));
          lineParts.length = 0;
        }
        flushLines();
        const imageBlock = await tryDownloadImage(messageId, el.image_key, opts);
        blocks.push(imageBlock);
        continue;
      }
      const rendered = elementToText(el);
      if (rendered) lineParts.push(rendered);
    }
    if (lineParts.length) lineBuffer.push(lineParts.join(""));
  }

  flushLines();
  return blocks;
}

async function parseImage(
  raw: string,
  messageId: string,
  opts: LarkInterpreterOptions,
): Promise<acp.ContentBlock[]> {
  const payload = safeParse<ImagePayload>(raw);
  const key = payload?.image_key;
  if (!key) return [{ type: "text", text: "[图片消息缺少 image_key]" }];
  return [await tryDownloadImage(messageId, key, opts)];
}

function parseFile(raw: string): acp.ContentBlock[] {
  const p = safeParse<FilePayload>(raw);
  const name = p?.file_name ?? "未命名";
  const key = p?.file_key ?? "unknown";
  return [{ type: "text", text: `[文件: ${name} (file_key=${key})]` }];
}

function parseAudio(raw: string): acp.ContentBlock[] {
  const p = safeParse<AudioPayload>(raw);
  const dur = p?.duration ? `${p.duration}ms` : "未知时长";
  const key = p?.file_key ?? "unknown";
  return [{ type: "text", text: `[音频: ${dur} (file_key=${key})]` }];
}

function parseMedia(raw: string): acp.ContentBlock[] {
  const p = safeParse<MediaPayload>(raw);
  const name = p?.file_name ?? "未命名";
  const dur = p?.duration ? `${p.duration}ms` : "未知时长";
  const key = p?.file_key ?? "unknown";
  return [{ type: "text", text: `[视频: ${name} ${dur} (file_key=${key})]` }];
}

function parseSticker(raw: string): acp.ContentBlock[] {
  const p = safeParse<StickerPayload>(raw);
  const key = p?.file_key ?? "unknown";
  return [{ type: "text", text: `[表情包 (file_key=${key})]` }];
}

function parseShareChat(raw: string): acp.ContentBlock[] {
  const p = safeParse<ShareChatPayload>(raw);
  const id = p?.chat_id ?? "unknown";
  return [{ type: "text", text: `[群名片: chat_id=${id}]` }];
}

function parseShareUser(raw: string): acp.ContentBlock[] {
  const p = safeParse<ShareUserPayload>(raw);
  const id = p?.user_id ?? "unknown";
  return [{ type: "text", text: `[个人名片: user_id=${id}]` }];
}

function parseLocation(raw: string): acp.ContentBlock[] {
  const p = safeParse<LocationPayload>(raw);
  const name = p?.name ?? "未命名地点";
  const lat = p?.latitude ?? "?";
  const lon = p?.longitude ?? "?";
  return [{ type: "text", text: `[位置: ${name} (${lat}, ${lon})]` }];
}

// ---- Element renderers ----

function elementToText(el: PostElement): string {
  switch (el.tag) {
    case "text": {
      let t = el.text;
      if (el.style?.length) {
        for (const st of el.style) {
          switch (st) {
            case "bold": t = `**${t}**`; break;
            case "italic": t = `*${t}*`; break;
            case "underline": t = `<u>${t}</u>`; break;
            case "lineThrough": t = `~~${t}~~`; break;
          }
        }
      }
      return t;
    }
    case "a": {
      const label = el.text ?? el.href ?? "";
      return el.href ? `[${label}](${el.href})` : label;
    }
    case "at":
      return `@{${el.user_name ?? el.user_id}}`;
    case "media":
      return `[视频/文件: ${el.file_key ?? el.image_key ?? "unknown"}]`;
    case "emotion":
      return `:${el.emoji_type}:`;
    case "img":
    case "code_block":
    case "hr":
      return ""; // handled at paragraph / block level
  }
}

// ---- Helpers ----

async function tryDownloadImage(
  messageId: string,
  imageKey: string,
  opts: LarkInterpreterOptions,
): Promise<acp.ContentBlock> {
  try {
    const { bytes, mimeType } = await opts.downloader.downloadMessageImage(messageId, imageKey);
    return {
      type: "image",
      data: bytes.toString("base64"),
      mimeType,
    };
  } catch (err) {
    opts.logger.warn(
      { err, messageId, imageKey },
      "downloadMessageImage failed — falling back to text placeholder",
    );
    return { type: "text", text: `[图片下载失败: ${imageKey}]` };
  }
}

function safeParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
