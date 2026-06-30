import express from "express";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { ProviderRegistry } from "../../src/server/providers/provider-registry";
import { createProviderRouter } from "../../src/server/routes/providers";

describe("providers route", () => {
  it("adds, renames, and sets default model configs through the API", async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), "autoagent-provider-route-"));
    const registry = new ProviderRegistry({ homeDir: home, env: {}, retryCount: 0 });
    const app = express();
    app.use(express.json());
    app.use("/api/providers", createProviderRouter(registry));

    const listed = await request(app).get("/api/providers/model-configs").expect(200);
    expect(listed.body.configs).toHaveLength(2);

    const created = await request(app)
      .post("/api/providers/model-configs")
      .send({ name: "Claude 主力", provider: "anthropic", model: "claude-sonnet-test", apiKey: "secret" })
      .expect(201);
    expect(created.body.config).toMatchObject({ name: "Claude 主力", provider: "anthropic", apiKey: "********" });

    const renamed = await request(app)
      .patch(`/api/providers/model-configs/${created.body.config.id}`)
      .send({ name: "Claude 验收模型" })
      .expect(200);
    expect(renamed.body.config.name).toBe("Claude 验收模型");

    await request(app).post(`/api/providers/model-configs/${created.body.config.id}/default`).expect(200);
    const relisted = await request(app).get("/api/providers/model-configs").expect(200);
    expect(relisted.body.configs.filter((config: { isDefault: boolean }) => config.isDefault)).toHaveLength(1);
    expect(relisted.body.configs.find((config: { id: string }) => config.id === created.body.config.id)).toMatchObject({ isDefault: true });
  });
});
