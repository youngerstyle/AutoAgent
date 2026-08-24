# Brownfield Order Service v1

This existing Node.js 20+ service has no runtime dependencies. Start it with
`PORT=3000 DATA_FILE=./data/orders.json node server.mjs` and run its regression
suite with `npm test`.

The persisted v1 shape is `{ "schemaVersion": 1, "orders": [...] }`. Existing
clients depend on `POST /api/orders`, `GET /api/orders`, and
`GET /api/orders/:id`; upgrades must preserve those contracts and stored data.
