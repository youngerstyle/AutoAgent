import { createOrderService } from "./src/app.mjs";

const port = Number(process.env.PORT ?? 3000);
const dataFile = process.env.DATA_FILE ?? new URL("./data/orders.json", import.meta.url).pathname;
const service = await createOrderService({ dataFile });
service.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ event: "listening", port }));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => service.close(() => process.exit(0)));
}
