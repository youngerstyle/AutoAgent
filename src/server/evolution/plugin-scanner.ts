import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  EvolutionArtifactKind,
  EvolutionCandidate,
  PluginArtifactManifest,
  PluginBundle,
  PluginBundleManifest,
  PluginScanFinding,
  PluginScanReport,
} from "../../shared/contracts/evolution.js";
import { workspaceEvolutionPluginBundleDirectory } from "../storage/paths.js";

const SCANNER_VERSION = "1.0.0";
const MAX_FILES = 32;
const MAX_FILE_BYTES = 256 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;
const SAFE_NODE_IMPORTS = new Set(["node:assert", "node:buffer", "node:crypto", "node:path", "node:url", "node:util"]);
const SAFE_PYTHON_IMPORTS = new Set(["collections", "dataclasses", "datetime", "decimal", "functools", "hashlib", "itertools", "json", "math", "re", "statistics", "string", "typing"]);

export interface ParsedPluginBundle {
  bundle: PluginBundle;
  scan: PluginScanReport;
  manifest: PluginArtifactManifest;
}

export function parseAndScanPluginBundle(
  raw: string,
  candidate: Pick<EvolutionCandidate, "kind" | "target" | "revision" | "contentHash" | "scope" | "riskLevel" | "sourceRefs">,
  now: () => Date = () => new Date(),
): ParsedPluginBundle {
  let bundle: PluginBundle;
  try { bundle = JSON.parse(raw) as PluginBundle; }
  catch { throw new Error("Plugin artifact must be valid JSON"); }
  const findings: PluginScanFinding[] = [];
  validateBundleShape(bundle, candidate.kind, candidate.target, findings);
  const files = Array.isArray(bundle?.files) ? bundle.files : [];
  let totalBytes = 0;
  const seen = new Set<string>();
  const fileFacts: PluginArtifactManifest["files"] = [];
  for (const file of files) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") {
      findings.push({ ruleId: "bundle.file.shape", severity: "critical", message: "Bundle file is invalid" });
      continue;
    }
    const normalized = normalizeBundlePath(file.path);
    if (!normalized || seen.has(normalized)) {
      findings.push({ ruleId: "bundle.file.path", severity: "critical", message: `Unsafe or duplicate bundle path: ${file.path}`, path: file.path });
      continue;
    }
    seen.add(normalized);
    const bytes = Buffer.byteLength(file.content, "utf8");
    totalBytes += bytes;
    if (bytes > MAX_FILE_BYTES) findings.push({ ruleId: "bundle.file.size", severity: "high", message: "Bundle file exceeds 256 KiB", path: normalized });
    fileFacts.push({ path: normalized, sha256: hash(file.content), bytes });
  }
  for (const file of files) {
    const normalized = typeof file?.path === "string" ? normalizeBundlePath(file.path) : undefined;
    if (normalized && typeof file.content === "string") scanSource(normalized, file.content, findings, seen);
  }
  if (files.length > MAX_FILES) findings.push({ ruleId: "bundle.file.count", severity: "critical", message: "Bundle contains more than 32 files" });
  if (totalBytes > MAX_TOTAL_BYTES) findings.push({ ruleId: "bundle.total.size", severity: "critical", message: "Bundle exceeds 512 KiB" });
  if (bundle?.manifest?.entrypoint && !seen.has(bundle.manifest.entrypoint)) findings.push({ ruleId: "bundle.entrypoint.missing", severity: "critical", message: "Entrypoint is missing from bundle" });
  const decision = findings.some((item) => item.severity === "critical" || item.severity === "high") ? "block" : findings.length ? "review" : "pass";
  const scan: PluginScanReport = {
    scannerRef: { id: "autoagent-plugin-scanner", version: SCANNER_VERSION, contentHash: scannerHash() },
    candidateHash: candidate.contentHash,
    decision,
    declaredCapabilities: bundle?.manifest?.permissions?.workspaceRead?.length ? ["workspace.read"] : [],
    detectedCapabilities: detectedCapabilities(files),
    findings,
    scannedAt: now().toISOString(),
  };
  return { bundle, scan, manifest: buildArtifactManifest(bundle, candidate, scan, fileFacts) };
}

export async function materializePluginBundle(workspaceRoot: string, parsed: ParsedPluginBundle): Promise<void> {
  const root = workspaceEvolutionPluginBundleDirectory(workspaceRoot, parsed.manifest.contentHash);
  for (const file of parsed.bundle.files) {
    const relative = normalizeBundlePath(file.path);
    if (!relative) throw new Error("Plugin bundle path failed materialization validation");
    const target = path.resolve(root, relative);
    if (!target.startsWith(`${path.resolve(root)}${path.sep}`)) throw new Error("Plugin bundle escaped artifact root");
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, { encoding: "utf8", mode: 0o600, flag: "wx" }).catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || await readFile(target, "utf8") !== file.content) throw error;
    });
  }
}

function validateBundleShape(bundle: PluginBundle, kind: EvolutionArtifactKind, target: string, findings: PluginScanFinding[]): void {
  const manifest = bundle?.manifest as PluginBundleManifest | undefined;
  if (bundle?.schemaVersion !== 1 || !manifest) {
    findings.push({ ruleId: "bundle.schema", severity: "critical", message: "Plugin bundle schemaVersion must be 1" });
    return;
  }
  if (!["plugin", "harness"].includes(kind) || manifest.kind !== kind || manifest.id !== target || manifest.apiVersion !== "autoagent.plugin/v1") findings.push({ ruleId: "manifest.identity", severity: "critical", message: "Manifest identity, kind, or API version does not match Candidate" });
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")) findings.push({ ruleId: "manifest.version", severity: "high", message: "Plugin version must use semantic versioning" });
  if (!normalizeBundlePath(manifest.entrypoint ?? "") || ![".mjs", ".py"].includes(path.posix.extname(String(manifest.entrypoint)))) findings.push({ ruleId: "manifest.entrypoint", severity: "critical", message: "Entrypoint must be a safe .mjs or .py path" });
  if (!manifest.description?.trim() || manifest.description.length > 500) findings.push({ ruleId: "manifest.description", severity: "high", message: "Manifest description is missing or too long" });
  if (!manifest.permissions || !Array.isArray(manifest.permissions.workspaceRead) || manifest.permissions.workspaceRead.length > 32 || manifest.permissions.workspaceRead.some((value) => !safeWorkspacePattern(value))) findings.push({ ruleId: "manifest.permissions", severity: "critical", message: "Only up to 32 safe workspaceRead patterns are supported" });
  if (!manifest.contributions || !Array.isArray(manifest.contributions.tools) || !Array.isArray(manifest.contributions.guardrails)) findings.push({ ruleId: "manifest.contributions", severity: "critical", message: "Manifest contributions are invalid" });
  else {
    if (manifest.contributions.tools.length > 16 || manifest.contributions.guardrails.length > 16) findings.push({ ruleId: "manifest.contribution_count", severity: "critical", message: "A bundle may contribute at most 16 tools and 16 guardrails" });
    const toolNames = new Set<string>();
    for (const tool of manifest.contributions.tools) {
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(tool?.name ?? "") || toolNames.has(tool.name) || !tool.description?.trim() || !validInputSchema(tool.inputSchema)) findings.push({ ruleId: "manifest.tool", severity: "critical", message: `Invalid or duplicate tool contribution: ${tool?.name ?? "unknown"}` });
      toolNames.add(tool?.name);
    }
    const guardNames = new Set<string>();
    for (const guard of manifest.contributions.guardrails) {
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(guard?.name ?? "") || guardNames.has(guard.name) || !["pre_tool", "post_tool"].includes(guard.phase) || !Array.isArray(guard.tools) || !guard.tools.length || guard.tools.length > 32 || guard.tools.some((item) => typeof item !== "string" || !/^(?:\*|[a-zA-Z][a-zA-Z0-9_-]{0,63})$/.test(item))) findings.push({ ruleId: "manifest.guardrail", severity: "critical", message: `Invalid or duplicate guardrail contribution: ${guard?.name ?? "unknown"}` });
      guardNames.add(guard?.name);
    }
    if (kind === "plugin" && manifest.contributions.tools.length === 0) findings.push({ ruleId: "manifest.plugin.empty", severity: "critical", message: "Plugin must contribute at least one tool" });
    if (kind === "harness" && manifest.contributions.guardrails.length === 0) findings.push({ ruleId: "manifest.harness.empty", severity: "critical", message: "Harness must contribute at least one guardrail" });
  }
  if (manifest.lifecycle?.activation !== "onDemand" || !Number.isInteger(manifest.lifecycle?.invokeTimeoutMs) || manifest.lifecycle.invokeTimeoutMs < 100 || manifest.lifecycle.invokeTimeoutMs > 15_000) findings.push({ ruleId: "manifest.lifecycle", severity: "high", message: "Lifecycle must use onDemand and a 100-15000ms invocation timeout" });
}

function scanSource(file: string, content: string, findings: PluginScanFinding[], bundleFiles: Set<string>): void {
  const rules: Array<[string, RegExp, string]> = [
    ["code.dynamic", /\b(?:eval\s*\(|new\s+Function\b|WebAssembly\b|process\.binding\b|process\._linkedBinding\b)/, "Dynamic or native code execution is forbidden"],
    ["code.require", /\brequire\s*\(/, "CommonJS require is forbidden"],
    ["code.process", /(?:node:)?(?:child_process|worker_threads|cluster|vm|inspector|wasi)/, "Process, worker, VM, inspector, or WASI access is forbidden"],
    ["code.python_process", /\b(?:subprocess|multiprocessing|ctypes)\b|\bos\.system\s*\(/, "Python process and native escape APIs are forbidden"],
    ["code.network", /(?:node:)?(?:https?|net|tls|dns|dgram|http2)\b/, "Network access is forbidden"],
    ["code.secret", /-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{16,}\b|\b(?:api[_-]?key|password|secret)\s*[:=]\s*["'][^"']{8,}/i, "Embedded credential is forbidden"],
    ["code.governance", /ignore\s+(?:all\s+)?previous\s+instructions|disable\s+(?:the\s+)?(?:sandbox|approval|guardrails?)/i, "Governance bypass instruction is forbidden"],
  ];
  for (const [ruleId, pattern, message] of rules) {
    const match = pattern.exec(content);
    if (match) findings.push({ ruleId, severity: "critical", message, path: file, line: lineAt(content, match.index) });
  }
  if (path.posix.extname(file) === ".py") {
    for (const match of content.matchAll(/^\s*(?:from\s+([A-Za-z_][\w.]*)\s+import|import\s+([A-Za-z_][\w.]*))/gm)) {
      const moduleName = (match[1] ?? match[2] ?? "").split(".")[0]!;
      if (!SAFE_PYTHON_IMPORTS.has(moduleName)) findings.push({ ruleId: "code.python_import", severity: "critical", message: `Python import is not allowlisted: ${moduleName}`, path: file, line: lineAt(content, match.index ?? 0) });
    }
    return;
  }
  for (const match of content.matchAll(/(?:import\s+(?:[^"']+?\s+from\s+)?|import\s*\()(["'])([^"']+)\1/g)) {
    const specifier = match[2]!;
    if (specifier.startsWith("./") || specifier.startsWith("../")) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), specifier));
      if (resolved.startsWith("../") || resolved === ".." || !bundleFiles.has(resolved)) findings.push({ ruleId: "code.relative_import", severity: "critical", message: `Relative import escapes the bundle or is undeclared: ${specifier}`, path: file, line: lineAt(content, match.index ?? 0) });
    } else if (!SAFE_NODE_IMPORTS.has(specifier)) findings.push({ ruleId: "code.import", severity: "critical", message: `Import is not allowlisted: ${specifier}`, path: file, line: lineAt(content, match.index ?? 0) });
  }
  if (/import\s*\((?!\s*["'])/.test(content)) findings.push({ ruleId: "code.dynamic_import", severity: "critical", message: "Dynamic non-literal import is forbidden", path: file });
}

function buildArtifactManifest(bundle: PluginBundle, candidate: Pick<EvolutionCandidate, "kind" | "target" | "revision" | "contentHash" | "scope" | "riskLevel" | "sourceRefs">, scanner: PluginScanReport, files: PluginArtifactManifest["files"]): PluginArtifactManifest {
  const manifest = bundle?.manifest;
  return {
    schemaVersion: 1, kind: candidate.kind as "plugin" | "harness", name: candidate.target,
    version: manifest?.version ?? String(candidate.revision), apiVersion: "autoagent.plugin/v1",
    entrypoint: manifest?.entrypoint ?? "", contentHash: candidate.contentHash, scope: structuredClone(candidate.scope),
    riskLevel: "critical", sourceRefs: structuredClone(candidate.sourceRefs),
    permissions: structuredClone(manifest?.permissions ?? { workspaceRead: [] }),
    contributions: structuredClone(manifest?.contributions ?? { tools: [], guardrails: [] }),
    lifecycle: structuredClone(manifest?.lifecycle ?? { activation: "onDemand", invokeTimeoutMs: 5_000 }),
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    compatibility: { runtime: "autoagent", manifestVersion: 1, hostApi: "autoagent.plugin/v1" }, scanner,
  };
}

export function normalizePluginBundlePath(value: string): string | undefined {
  if (!value || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) return undefined;
  const normalized = path.posix.normalize(value);
  if (normalized === "." || normalized === ".." || normalized.startsWith("../") || normalized !== value) return undefined;
  return normalized;
}
function normalizeBundlePath(value: string): string | undefined { return normalizePluginBundlePath(value); }
function safeWorkspacePattern(value: string): boolean {
  if (!value || value.includes("\\") || value.includes("\0") || path.posix.isAbsolute(value)) return false;
  const base = value.endsWith("/**") ? value.slice(0, -3) : value;
  return Boolean(base) && !base.includes("*") && path.posix.normalize(base) === base && base !== ".." && !base.startsWith("../") && !base.startsWith(".autoagent");
}
function validInputSchema(value: unknown): value is Record<string, unknown> {
  return validSchemaNode(value, 0, true);
}
function validSchemaNode(value: unknown, depth: number, root = false): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || depth > 8) return false;
  const schema = value as Record<string, unknown>;
  const allowedKeys = new Set(["type", "description", "properties", "required", "additionalProperties", "items", "enum", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"]);
  if (Object.keys(schema).some((key) => !allowedKeys.has(key))) return false;
  if (typeof schema.description === "string" && schema.description.length > 500) return false;
  if (!["object", "string", "number", "integer", "boolean", "array"].includes(String(schema.type)) || (root && schema.type !== "object")) return false;
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.length > 32 || schema.enum.some((item) => !["string", "number", "boolean"].includes(typeof item)))) return false;
  for (const key of ["minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems"] as const) if (schema[key] !== undefined && (!Number.isFinite(schema[key]) || Number(schema[key]) < 0)) return false;
  if (schema.type === "object") {
    if (schema.additionalProperties !== false || !schema.properties || typeof schema.properties !== "object" || Array.isArray(schema.properties)) return false;
    const properties = schema.properties as Record<string, unknown>;
    if (Object.keys(properties).length > 64 || Object.keys(properties).some((key) => !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(key)) || !Object.values(properties).every((item) => validSchemaNode(item, depth + 1))) return false;
    if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((item) => typeof item !== "string" || !(item in properties)) || new Set(schema.required).size !== schema.required.length)) return false;
  } else if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) return false;
  if (schema.type === "array") {
    if (!validSchemaNode(schema.items, depth + 1)) return false;
  } else if (schema.items !== undefined) return false;
  return true;
}
function detectedCapabilities(files: PluginBundle["files"]): string[] {
  const source = files.map((file) => file?.content ?? "").join("\n");
  return [/(?:node:)?fs\b/.test(source) ? "filesystem" : undefined, /requestCapability/.test(source) ? "broker" : undefined].filter((value): value is string => Boolean(value));
}
function lineAt(content: string, index: number): number { return content.slice(0, index).split(/\r?\n/).length; }
function hash(value: string): string { return createHash("sha256").update(value, "utf8").digest("hex"); }
function scannerHash(): string { return hash(`autoagent-plugin-scanner:${SCANNER_VERSION}:bundle,path,import,dynamic,network,process,secret,governance`); }
