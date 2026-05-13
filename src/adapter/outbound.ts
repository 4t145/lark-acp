/**
 * Outbound adapter — format ACP reply text for Feishu.
 * Feishu plain text messages support Unicode but not Markdown natively,
 * so we keep the text as-is (code blocks, diffs are readable in monospace).
 */

const MAX_MESSAGE_LENGTH = 4000; // Feishu text message limit

export function formatForFeishu(text: string): string {
  return text.trim();
}

/** Split long responses into chunks that fit within Feishu's limit. */
export function splitText(text: string, limit = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    // Try to split at a newline boundary
    let splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}
