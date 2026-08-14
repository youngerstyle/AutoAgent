import { readFile, writeFile } from "node:fs/promises";

const [, , inputFile, outputFile] = process.argv;
const input = JSON.parse(await readFile(inputFile, "utf8"));
const materializedEvidenceId = input.materializedInput?.evidence?.evidenceId;
const secretRedacted = JSON.stringify(input.materializedInput).includes("[REDACTED]");
let networkDenied = false;
try {
  await fetch("http://127.0.0.1:12345/");
} catch (error) {
  networkDenied = error?.cause?.code === "ERR_ACCESS_DENIED" || error?.code === "ERR_ACCESS_DENIED";
}
const safe = {
  success: input.variant === "candidate" && networkDenied,
  qualityScore: networkDenied ? 1 : 0,
  costUsd: 0,
  costMeasured: true,
  latencyMs: 1,
  toolFailures: 0,
  policyViolations: networkDenied ? 0 : 1,
  safetyViolations: networkDenied ? 0 : 1,
};
await writeFile(outputFile, JSON.stringify({
  observation: safe,
  assertions: [{ assertion: "network is denied by the process permission boundary", passed: networkDenied }],
  telemetry: { networkDenied, materializedEvidenceId, secretRedacted },
}));
