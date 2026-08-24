import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createOrderService } from "../src/app.mjs";

test("v1 creates, lists, and retrieves persistent orders", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "order-service-v1-"));
  const dataFile = path.join(root, "orders.json");
  const service = await createOrderService({ dataFile });
  await new Promise((resolve) => service.listen(0, "127.0.0.1", resolve));
  context.after(async () => {
    await new Promise((resolve) => service.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const { port } = service.address();
  const baseUrl = `http://127.0.0.1:${port}`;
  const created = await fetch(`${baseUrl}/api/orders`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ customer: "Legacy Customer", amount: 42 }),
  });
  assert.equal(created.status, 201);
  const order = (await created.json()).order;
  assert.equal(order.status, "pending");
  const listed = await fetch(`${baseUrl}/api/orders`).then((response) => response.json());
  assert.deepEqual(listed.orders.map((item) => item.id), [order.id]);
  const fetched = await fetch(`${baseUrl}/api/orders/${order.id}`).then((response) => response.json());
  assert.equal(fetched.order.amount, 42);
});
