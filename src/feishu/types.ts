/**
 * Feishu event and message types.
 * Based on Feishu Open Platform im.message.receive_v1 event schema.
 */

export interface FeishuSender {
  sender_id: { open_id: string; union_id?: string; user_id?: string };
  sender_type: string;
}

export interface FeishuMention {
  key: string;
  id: { open_id: string };
  name: string;
}

export interface FeishuMessage {
  message_id: string;
  root_id?: string;
  parent_id?: string;
  chat_id: string;
  chat_type: "p2p" | "group";
  message_type: string; // "text" | "image" | "file" | ...
  content: string; // JSON string
  mentions?: FeishuMention[];
  create_time: string;
}

export interface FeishuMessageEvent {
  sender: FeishuSender;
  message: FeishuMessage;
}

// Parsed text content
export interface TextContent {
  text: string;
}
