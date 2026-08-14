import { createHash } from "node:crypto";
import type { SkillCapability, SkillScanFinding, SkillScanReport } from "../../shared/contracts/evolution.js";

const KNOWN_CAPABILITIES = new Set<SkillCapability>(["network", "shell", "process", "filesystem-write"]);
const SCANNER_VERSION = "1.0.0";

export function scanSkillArtifact(content: string, candidateHash: string, now: () => Date = () => new Date()): SkillScanReport {
  const declaredCapabilities = parseCapabilities(content);
  const findings: SkillScanFinding[] = [];
  const detected = new Set<SkillCapability>();
  const lines = content.split(/\r?\n/);

  inspect(lines, /[\u202A-\u202E\u2066-\u2069]/u, "SKILL_UNICODE_CONTROL", "critical", "Bidirectional control characters can conceal instructions", findings);
  inspect(lines, /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{16,}\b|\bgh[opusr]_[A-Za-z0-9]{20,}\b/i, "SKILL_EMBEDDED_SECRET", "critical", "Artifact appears to contain a credential or private key", findings);
  inspect(lines, /\bignore\s+(?:all\s+)?previous\s+instructions\b|\bdisable\s+(?:the\s+)?(?:sandbox|approval|guardrails?)\b/i, "SKILL_GOVERNANCE_BYPASS", "critical", "Artifact attempts to bypass governing instructions or controls", findings);
  inspect(lines, /\brm\s+-rf\s+(?:\/(?:\s|$)|~(?:\s|$)|\$HOME\b)|\bRemove-Item\b[^\r\n]*(?:-Recurse)[^\r\n]*(?:\$HOME|~|[A-Z]:\\)/i, "SKILL_DESTRUCTIVE_BROAD_DELETE", "critical", "Artifact contains a broad destructive filesystem command", findings);
  inspect(lines, /(?:^|[\s"'])\.\.\/(?:\.\.\/)*|(?:^|[\s"'])\.\.\\(?:\.\.\\)*/i, "SKILL_PATH_ESCAPE", "high", "Artifact references a path outside its declared workspace scope", findings);

  const network = /\b(?:curl|wget|Invoke-WebRequest|fetch\s*\(|requests\.(?:get|post)|https?:\/\/)/i;
  const shell = /```(?:bash|sh|shell|powershell|cmd)\b|\b(?:child_process|Start-Process|subprocess\.)\b/i;
  const process = /```(?:python|javascript|typescript|js|ts)\b|\b(?:eval|exec)\s*\(/i;
  const write = /\b(?:writeFile|appendFile|Set-Content|Add-Content|tee)\b|(?:^|\s)>(?:>|\s)/i;
  if (network.test(content)) detected.add("network");
  if (shell.test(content)) detected.add("shell");
  if (process.test(content)) detected.add("process");
  if (write.test(content)) detected.add("filesystem-write");

  for (const capability of detected) {
    if (!declaredCapabilities.includes(capability)) findings.push({
      ruleId: "SKILL_UNDECLARED_CAPABILITY", severity: "high",
      message: `Artifact uses ${capability} but does not declare it in frontmatter permissions`,
    });
  }
  for (const capability of declaredCapabilities.filter((item) => detected.has(item))) findings.push({
    ruleId: "SKILL_DECLARED_CAPABILITY", severity: "low", message: `Declared capability is used: ${capability}`,
  });

  const severity = new Set(findings.map((item) => item.severity));
  const decision = severity.has("critical") || severity.has("high") ? "block" : severity.has("medium") ? "review" : "pass";
  return {
    scannerRef: { id: "autoagent-skill-scanner", version: SCANNER_VERSION, contentHash: scannerHash() },
    candidateHash, decision, declaredCapabilities, detectedCapabilities: [...detected].sort(), findings,
    scannedAt: now().toISOString(),
  };
}

function parseCapabilities(content: string): SkillCapability[] {
  const frontmatter = /^---\s*\r?\n([\s\S]*?)\r?\n---/m.exec(content)?.[1] ?? "";
  const raw = /^permissions:\s*\[([^\]]*)\]\s*$/mi.exec(frontmatter)?.[1];
  if (!raw) return [];
  return [...new Set(raw.split(",").map((item) => item.trim().toLowerCase()).filter((item): item is SkillCapability => KNOWN_CAPABILITIES.has(item as SkillCapability)))].sort();
}

function inspect(lines: string[], pattern: RegExp, ruleId: string, severity: SkillScanFinding["severity"], message: string, findings: SkillScanFinding[]): void {
  lines.forEach((line, index) => { if (pattern.test(line)) findings.push({ ruleId, severity, message, line: index + 1 }); });
}
function scannerHash(): string {
  return createHash("sha256").update(`autoagent-skill-scanner:${SCANNER_VERSION}:unicode,secret,bypass,delete,path,capability,risk`, "utf8").digest("hex");
}
