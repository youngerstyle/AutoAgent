import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

export async function createStore(dataFile) {
  let state;
  try {
    state = JSON.parse(await readFile(dataFile, "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    state = { schemaVersion: 1, orders: [] };
  }
  if (state.schemaVersion !== 1 || !Array.isArray(state.orders)) throw new Error("Unsupported order store");

  return {
    list: () => state.orders.map((order) => structuredClone(order)),
    find: (id) => {
      const order = state.orders.find((candidate) => candidate.id === id);
      return order ? structuredClone(order) : undefined;
    },
    async insert(order) {
      state.orders.push(structuredClone(order));
      await persist(dataFile, state);
      return structuredClone(order);
    },
  };
}

async function persist(dataFile, state) {
  await mkdir(path.dirname(dataFile), { recursive: true });
  const temporary = `${dataFile}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temporary, dataFile);
}
