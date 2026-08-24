import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createStore } from "./store.mjs";

export async function createOrderService({ dataFile }) {
  const store = await createStore(dataFile);
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { ok: true });
      if (request.method === "GET" && url.pathname === "/api/orders") return json(response, 200, { orders: store.list() });
      if (request.method === "POST" && url.pathname === "/api/orders") {
        const body = await readJson(request);
        if (typeof body.customer !== "string" || !body.customer.trim() || !Number.isFinite(body.amount) || body.amount <= 0) {
          return json(response, 400, { error: "customer and positive amount are required" });
        }
        const order = await store.insert({
          id: randomUUID(),
          customer: body.customer.trim(),
          amount: body.amount,
          status: "pending",
          createdAt: new Date().toISOString(),
        });
        return json(response, 201, { order });
      }
      const match = request.method === "GET" && url.pathname.match(/^\/api\/orders\/([^/]+)$/);
      if (match) {
        const order = store.find(decodeURIComponent(match[1]));
        return order ? json(response, 200, { order }) : json(response, 404, { error: "order not found" });
      }
      return json(response, 404, { error: "not found" });
    } catch (error) {
      return json(response, error?.code === "INVALID_JSON" ? 400 : 500, { error: error?.message ?? "internal error" });
    }
  });
}

async function readJson(request) {
  let source = "";
  for await (const chunk of request) source += chunk;
  try {
    return JSON.parse(source || "{}");
  } catch {
    const error = new Error("invalid JSON");
    error.code = "INVALID_JSON";
    throw error;
  }
}

function json(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}
