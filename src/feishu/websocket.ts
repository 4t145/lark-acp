/**
 * Feishu WebSocket long connection.
 * Uses @larksuite/node-sdk WSClient to receive events without a public endpoint.
 */

import * as Lark from "@larksuiteoapi/node-sdk";
import type { FeishuMessageEvent } from "./types.js";

export interface FeishuWsOpts {
  appId: string;
  appSecret: string;
  onMessage: (event: FeishuMessageEvent) => void;
  onCardAction: (event: Lark.CardActionEvent) => void;
  log: (msg: string) => void;
}

export class FeishuWsConnection {
  private wsClient: Lark.WSClient;
  private opts: FeishuWsOpts;

  constructor(opts: FeishuWsOpts) {
    this.opts = opts;
    this.wsClient = new Lark.WSClient({
      appId: opts.appId,
      appSecret: opts.appSecret,
      loggerLevel: Lark.LoggerLevel.error,
    });
  }

  start(): void {
    const dispatcher = new Lark.EventDispatcher({}).register({
      "im.message.receive_v1": async (data) => {
        const event = data as unknown as FeishuMessageEvent;
        try {
          this.opts.onMessage(event);
        } catch (err) {
          this.opts.log(`[ws] error handling message event: ${String(err)}`);
        }
      },
      "card.action.trigger": async (data: Lark.RawCardActionEvent) => {
        try {
          const normalized = Lark.normalizeCardAction(data);
          if (normalized) {
            this.opts.onCardAction(normalized);
          }
        } catch (err) {
          this.opts.log(`[ws] error handling card action: ${String(err)}`);
        }
      },
    });

    this.opts.log("Connecting to Feishu via WebSocket...");
    this.wsClient.start({ eventDispatcher: dispatcher });
    this.opts.log("WebSocket connected. Listening for messages...");
  }
}
