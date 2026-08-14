const RULES: Array<{ name: string; pattern: RegExp }> = [
  { name: "authorization", pattern: /\b(authorization\s*[:=]\s*(?:bearer|basic)\s+)[^\s,;]+/gi },
  { name: "named-secret", pattern: /\b(api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*["']?([^\s,"';}]+)/gi },
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: "github-token", pattern: /\bgh[opusr]_[A-Za-z0-9]{20,}\b/g },
  { name: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
];

export interface RedactionResult { value: string; count: number; rules: string[] }

export function redactEvolutionText(input: string): RedactionResult {
  let value = input;
  let count = 0;
  const rules: string[] = [];
  for (const rule of RULES) {
    let matched = false;
    value = value.replace(rule.pattern, (...args: unknown[]) => {
      count += 1;
      matched = true;
      if (rule.name === "authorization") return `${String(args[1])}[REDACTED]`;
      if (rule.name === "named-secret") return `${String(args[1])}=[REDACTED]`;
      return "[REDACTED]";
    });
    if (matched) rules.push(rule.name);
  }
  return { value, count, rules };
}
