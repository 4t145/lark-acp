/**
 * Inbound adapter — convert a Feishu message event into an ACP ContentBlock[].
 */

import type * as acp from "@agentclientprotocol/sdk";
import type { FeishuMessageEvent, TextContent } from "../feishu/types.js";

export function feishuMessageToPrompt(event: FeishuMessageEvent): acp.ContentBlock[] {
  const { message } = event;

  if (message.message_type === "text") {
    const content = JSON.parse(message.content) as TextContent;
    // Strip @bot mentions from text (Feishu includes them inline)
    let text = content.text ?? "";
    if (message.mentions) {
      for (const m of message.mentions) {
        text = text.replace(new RegExp(`@_user_\\d+`, "g"), "").trim();
      }
    }
    text = text.trim();
    if (!text) return [];
    return [{ type: "text", text }];
  }

  // Unsupported message types — return a best-effort description
  return [{ type: "text", text: `[${message.message_type} message — text only supported]` }];
}
