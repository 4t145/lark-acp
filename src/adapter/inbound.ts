/**
 * Inbound adapter — convert a Feishu message event into ACP ContentBlock[].
 * Supports text, post (rich text), and image message types.
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { FeishuMessageEvent, FeishuMention } from "../feishu/types.js";

/** Parsed JSON payload for a plain text message. */
interface TextPayload {
  text?: string;
}

/** A single inline element within a post message paragraph. */
interface PostElement {
  tag: string;
  text?: string;
  href?: string;
  user_id?: string;
  user_name?: string;
  image_key?: string;
}

/** A paragraph is an array of inline elements. */
type PostParagraph = PostElement[];

/** Post message content structure — paragraphs are arrays of inline elements. */
interface PostPayload {
  title?: string;
  content?: PostParagraph[];
}

/** Image message content. */
interface ImagePayload {
  image_key?: string;
}

export function feishuMessageToPrompt(event: FeishuMessageEvent): acp.ContentBlock[] {
  const { message } = event;

  if (message.message_type === "text") {
    return parseTextMessage(message.content, message.mentions);
  }

  if (message.message_type === "post") {
    return parsePostMessage(message.content);
  }

  if (message.message_type === "image") {
    return parseImageMessage(message.content);
  }

  // Other unsupported types
  return [{ type: "text", text: `[${message.message_type} 消息 — 暂不支持]` }];
}

function parseTextMessage(contentStr: string, mentions?: FeishuMention[]): acp.ContentBlock[] {
  const content = JSON.parse(contentStr) as TextPayload;
  let text = content.text ?? "";

  // Strip @bot mentions from text (Feishu includes them as @_user_XXX inline)
  if (mentions) {
    for (const m of mentions) {
      text = text.replace(new RegExp(`@_user_\\d+`, "g"), "").trim();
    }
  }
  text = text.trim();
  if (!text) return [];
  return [{ type: "text", text }];
}

function parsePostMessage(contentStr: string): acp.ContentBlock[] {
  let payload: PostPayload;
  try {
    payload = JSON.parse(contentStr) as PostPayload;
  } catch {
    return [{ type: "text", text: "[富文本消息解析失败]" }];
  }

  const lines: string[] = [];

  if (payload.title) {
    lines.push(`**${payload.title}**`);
    lines.push("");
  }

  const paragraphs = payload.content;
  if (!paragraphs?.length) return [];

  for (const paragraph of paragraphs) {
    const line = paragraph
      .map((el) => elementToText(el))
      .filter(Boolean)
      .join("");
    if (line.trim()) lines.push(line);
  }

  if (!lines.length) return [];
  return [{ type: "text", text: lines.join("\n") }];
}

function elementToText(el: PostElement): string {
  switch (el.tag) {
    case "text":
      return el.text ?? "";
    case "a":
      return el.href ? `[${el.text ?? el.href}](${el.href})` : (el.text ?? "");
    case "at":
      return `@{${el.user_name ?? el.user_id ?? "unknown"}}`;
    case "img":
      return `![${el.image_key ?? "图片"}]`;
    case "media":
      return `[media: ${el.image_key ?? "unknown"}]`;
    default:
      return el.text ?? `[${el.tag}]`;
  }
}

function parseImageMessage(contentStr: string): acp.ContentBlock[] {
  let payload: ImagePayload;
  try {
    payload = JSON.parse(contentStr) as ImagePayload;
  } catch {
    payload = {};
  }
  const key = payload.image_key ?? "unknown";
  return [{ type: "text", text: `[用户发送了一张图片: ${key}]` }];
}
