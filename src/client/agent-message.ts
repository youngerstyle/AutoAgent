export type AgentMessageView =
  | { kind: "text"; rawText: string }
  | { kind: "json"; rawText: string; paragraphs: string[] };

export function buildAgentMessageView(rawText: string): AgentMessageView {
  try {
    const parsed = JSON.parse(rawText) as unknown;
    if (!isRecord(parsed) && !Array.isArray(parsed)) return { kind: "text", rawText };
    return {
      kind: "json",
      rawText,
      paragraphs: readableParagraphs(parsed)
    };
  } catch {
    return { kind: "text", rawText };
  }
}

function readableParagraphs(value: unknown): string[] {
  const paragraphs: string[] = [];
  collectReadableParagraphs(value, paragraphs);
  return [...new Set(paragraphs)];
}

function collectReadableParagraphs(value: unknown, paragraphs: string[]) {
  if (typeof value === "string") {
    const text = value.trim();
    if (isReadableParagraph(text)) paragraphs.push(text);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => collectReadableParagraphs(item, paragraphs));
    return;
  }
  if (isRecord(value)) {
    Object.values(value).forEach((item) => collectReadableParagraphs(item, paragraphs));
  }
}

function isReadableParagraph(value: string): boolean {
  if (!value) return false;
  if (/^[a-z][a-z0-9_:-]*$/i.test(value)) return false;
  return /[\u4e00-\u9fff]/.test(value) || value.length > 24 || /[。；，、！？.!?]/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
