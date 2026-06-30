import { mkdtemp, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readJson, writeJson } from "../../src/server/storage/json";

describe("json storage", () => {
  it("supports concurrent writes to the same json path without leaving temp files", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "autoagent-json-"));
    const filePath = path.join(dir, "state.json");

    await Promise.all(Array.from({ length: 20 }, (_, index) => writeJson(filePath, { index })));

    const value = await readJson<{ index: number }>(filePath, { index: -1 });
    expect(value.index).toBeGreaterThanOrEqual(0);
    expect(value.index).toBeLessThan(20);
    await expect(readdir(dir)).resolves.toEqual(["state.json"]);
  });
});
