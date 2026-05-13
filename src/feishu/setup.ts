/**
 * Interactive first-run setup — asks for Feishu App ID and App Secret,
 * then saves them to ~/.feishu-acp/config.json.
 */

import readline from "node:readline";
import { saveConfig, loadSavedConfig } from "../config.js";

function prompt(rl: readline.Interface, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, (answer) => resolve(answer.trim())));
}

export async function runSetup(storageDir: string): Promise<{ appId: string; appSecret: string }> {
  const existing = loadSavedConfig(storageDir);

  console.log(`
┌─────────────────────────────────────────┐
│         feishu-acp first-time setup     │
└─────────────────────────────────────────┘

You need a Feishu self-built app with bot capability.
Create one at: https://open.feishu.cn/app

Required permissions:
  im:message          (receive & send messages)
  im:message:send_as_bot

Event subscriptions (long connection):
  im.message.receive_v1
`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    const appId = await prompt(rl, `App ID${existing?.feishu?.appId ? ` [${existing.feishu.appId}]` : ""}: `);
    const appSecret = await prompt(rl, "App Secret: ");

    const resolvedAppId = appId || existing?.feishu?.appId || "";
    const resolvedSecret = appSecret || existing?.feishu?.appSecret || "";

    if (!resolvedAppId || !resolvedSecret) {
      throw new Error("App ID and App Secret are required");
    }

    saveConfig(storageDir, { feishu: { appId: resolvedAppId, appSecret: resolvedSecret } });
    console.log(`\n✓ Config saved to ${storageDir}/config.json\n`);

    return { appId: resolvedAppId, appSecret: resolvedSecret };
  } finally {
    rl.close();
  }
}
