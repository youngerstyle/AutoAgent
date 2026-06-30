import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";

describe("health", () => {
  it("returns AutoAgent health", async () => {
    const response = await request(createApp()).get("/api/health").expect(200);

    expect(response.body).toEqual({ ok: true, name: "AutoAgent" });
  });
});
