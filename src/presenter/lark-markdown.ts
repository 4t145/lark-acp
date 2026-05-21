/**
 * Convert agent-emitted markdown into Lark's `post` rich-text payload.
 *
 * Uses `marked.lexer()` to obtain a token tree, then walks it and emits
 * the post-element shape Lark accepts. Lists / blockquotes — which have
 * no native post tag — are delegated to the `md` tag (per the Lark docs:
 * `md` natively renders these). Tables — which `md` does not support —
 * are converted to text-aligned `code_block` paragraphs.
 *
 * Lark post payload shape per:
 * https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/im-v1/message-content-description/create_json
 */

import { marked, type Token, type Tokens } from "marked";

/** Soft cap on a single chunk's markdown source length. Lark's post body
 *  itself can be large; this keeps any single reply within IM limits and
 *  avoids one runaway code block blocking the whole reply. */
const MAX_MARKDOWN_CHUNK = 4000;

/** Lark code-block languages (case-insensitive on the wire, but the docs
 *  list them in upper case). Anything else is dropped. */
const LARK_CODE_LANGS = new Set([
  "PYTHON", "C", "CPP", "GO", "JAVA", "KOTLIN", "SWIFT", "PHP", "RUBY", "RUST",
  "JAVASCRIPT", "TYPESCRIPT", "BASH", "SHELL", "SQL", "JSON", "XML", "YAML",
  "HTML", "THRIFT",
]);

const LANG_ALIASES: Record<string, string> = {
  JS: "JAVASCRIPT",
  TS: "TYPESCRIPT",
  PY: "PYTHON",
  RB: "RUBY",
  "C++": "CPP",
  SH: "BASH",
  ZSH: "BASH",
};

type TextStyle = "bold" | "underline" | "lineThrough" | "italic";

interface PostElText {
  tag: "text";
  text: string;
  style?: TextStyle[];
}

interface PostElA {
  tag: "a";
  text: string;
  href: string;
  style?: TextStyle[];
}

interface PostElCodeBlock {
  tag: "code_block";
  language?: string;
  text: string;
}

interface PostElHr {
  tag: "hr";
}

interface PostElMd {
  tag: "md";
  text: string;
}

type PostElement = PostElText | PostElA | PostElCodeBlock | PostElHr | PostElMd;

type PostParagraph = PostElement[];

export interface PostPayload {
  title?: string;
  content: PostParagraph[];
}

/**
 * Parse `text` as markdown and return a Lark post payload. Always
 * produces a payload with at least one paragraph; an empty input
 * yields a payload with `content: [[]]` so the caller can rely on
 * structural validity.
 */
export function markdownToPost(text: string): PostPayload {
  const tokens = marked.lexer(text);
  const paragraphs: PostParagraph[] = [];
  for (const token of tokens) walkBlock(token, paragraphs);
  if (!paragraphs.length) paragraphs.push([{ tag: "text", text: "" }]);
  return { content: paragraphs };
}

/**
 * Split a markdown blob into chunks no longer than `limit` characters,
 * preferring to break on paragraph boundaries (`\n\n`) and falling back
 * to single newlines. Code-fence boundaries are preferred when they sit
 * close to the limit so we don't split a fenced block in half.
 */
export function splitMarkdown(text: string, limit = MAX_MARKDOWN_CHUNK): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > limit) {
    let splitAt = remaining.lastIndexOf("\n```\n", limit);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n\n", limit);
    if (splitAt <= 0) splitAt = remaining.lastIndexOf("\n", limit);
    if (splitAt <= 0) splitAt = limit;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n+/, "");
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

// ---- Block-level walker -----------------------------------------------------

function walkBlock(token: Token, out: PostParagraph[]): void {
  switch (token.type) {
    case "heading": {
      const inline = walkInline(token.tokens ?? []);
      out.push(applyStyleAll(inline, "bold"));
      return;
    }
    case "paragraph": {
      const inline = walkInline(token.tokens ?? []);
      if (inline.length) out.push(inline);
      return;
    }
    case "code": {
      const code = token as Tokens.Code;
      const lang = normalizeLang(code.lang);
      const block: PostElCodeBlock = lang === undefined
        ? { tag: "code_block", text: code.text }
        : { tag: "code_block", language: lang, text: code.text };
      out.push([block]);
      return;
    }
    case "hr":
      out.push([{ tag: "hr" }]);
      return;
    case "blockquote":
    case "list": {
      // The `md` tag is the only post element that natively renders lists
      // and blockquotes. Strip trailing newlines so consecutive lists don't
      // produce visible blank paragraphs.
      const text = token.raw.replace(/\s+$/, "");
      if (text) out.push([{ tag: "md", text }]);
      return;
    }
    case "table": {
      if (isTable(token)) out.push([{ tag: "code_block", text: tableToText(token) }]);
      return;
    }
    case "space":
      return;
    case "html": {
      // We don't try to interpret raw HTML — pass through as text. Lark's
      // text tag does not parse HTML, so this is rendered literally.
      const text = (token as Tokens.HTML).text.trim();
      if (text) out.push([{ tag: "text", text }]);
      return;
    }
    default: {
      const raw = (token as { raw?: string }).raw?.trim();
      if (raw) out.push([{ tag: "text", text: raw }]);
    }
  }
}

function isTable(token: Token): token is Tokens.Table {
  return token.type === "table" && Array.isArray((token as Tokens.Table).header);
}

// ---- Inline walker ----------------------------------------------------------

function walkInline(tokens: Token[]): PostElement[] {
  const out: PostElement[] = [];
  for (const t of tokens) appendInline(t, out);
  return out;
}

function appendInline(token: Token, out: PostElement[]): void {
  switch (token.type) {
    case "text": {
      const text = token as Tokens.Text;
      if (text.tokens?.length) {
        for (const child of text.tokens) appendInline(child, out);
      } else if (text.text) {
        out.push({ tag: "text", text: text.text });
      }
      return;
    }
    case "strong": {
      const styled = applyStyleAll(walkInline(token.tokens ?? []), "bold");
      out.push(...styled);
      return;
    }
    case "em": {
      const styled = applyStyleAll(walkInline(token.tokens ?? []), "italic");
      out.push(...styled);
      return;
    }
    case "del": {
      const styled = applyStyleAll(walkInline(token.tokens ?? []), "lineThrough");
      out.push(...styled);
      return;
    }
    case "codespan": {
      // post has no inline-code element. Keep visual fidelity with backticks.
      out.push({ tag: "text", text: "`" + token.text + "`" });
      return;
    }
    case "link": {
      out.push({ tag: "a", text: token.text || token.href, href: token.href });
      return;
    }
    case "image": {
      // Agents emit URL-based images; post's `img` tag needs an uploaded
      // image_key we don't have. Render as a link so the user can still
      // reach the image.
      const label = token.text || "图片";
      out.push({ tag: "a", text: `[图片] ${label}`, href: token.href });
      return;
    }
    case "br":
      out.push({ tag: "text", text: "\n" });
      return;
    case "escape":
      out.push({ tag: "text", text: token.text });
      return;
    case "html":
      out.push({ tag: "text", text: token.text });
      return;
    default: {
      const raw = (token as { raw?: string }).raw;
      if (raw) out.push({ tag: "text", text: raw });
    }
  }
}

// ---- Helpers ----------------------------------------------------------------

function applyStyleAll(elements: PostElement[], style: TextStyle): PostElement[] {
  return elements.map((el) => addStyle(el, style));
}

function addStyle(el: PostElement, style: TextStyle): PostElement {
  if (el.tag !== "text" && el.tag !== "a") return el;
  const styles = new Set<TextStyle>(el.style ?? []);
  styles.add(style);
  return { ...el, style: [...styles] };
}

function tableToText(table: Tokens.Table): string {
  const rows = [
    table.header.map((c) => c.text),
    ...table.rows.map((r) => r.map((c) => c.text)),
  ];
  const colCount = table.header.length;
  const colWidths = new Array<number>(colCount).fill(0);
  for (const row of rows) {
    for (let i = 0; i < colCount; i++) {
      const cell = row[i] ?? "";
      const w = colWidths[i] ?? 0;
      if (cell.length > w) colWidths[i] = cell.length;
    }
  }
  const padCell = (cell: string | undefined, i: number): string =>
    (cell ?? "").padEnd(colWidths[i] ?? 0);

  const lines = rows.map((row) =>
    Array.from({ length: colCount }, (_, i) => padCell(row[i], i)).join(" | "),
  );
  const separator = colWidths.map((w) => "-".repeat(w)).join("-+-");
  lines.splice(1, 0, separator);
  return lines.join("\n");
}

function normalizeLang(lang: string | undefined): string | undefined {
  if (!lang) return undefined;
  const upper = lang.trim().toUpperCase();
  if (!upper) return undefined;
  const mapped = LANG_ALIASES[upper] ?? upper;
  return LARK_CODE_LANGS.has(mapped) ? mapped : undefined;
}
