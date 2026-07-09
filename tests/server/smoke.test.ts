import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp, resolveClientDir } from "../../src/server/app";

describe("health", () => {
  it("returns AutoAgent health", async () => {
    const response = await request(createApp()).get("/api/health").expect(200);

    expect(response.body).toEqual({ ok: true, name: "AutoAgent" });
  });

  it("does not choose source client files without an index entry", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoagent-client-dir-"));
    const serverDir = path.join(root, "src", "server");
    const sourceClientDir = path.join(root, "src", "client");
    const builtClientDir = path.join(root, "dist", "client");
    await mkdir(serverDir, { recursive: true });
    await mkdir(sourceClientDir, { recursive: true });
    await mkdir(builtClientDir, { recursive: true });
    await writeFile(path.join(builtClientDir, "index.html"), "<div id=\"root\"></div>", "utf8");

    expect(resolveClientDir(serverDir)).toBe(builtClientDir);
  });
});
