"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const context = new AsyncLocalStorage();
// Defense in depth: even an accidental write inside an approved GET is rejected
// by PostgreSQL. Each query has its own read-only transaction; no live pool state
// is changed and ordinary requests never share the support context.
function protectPool(pool) {
  const query = pool.query.bind(pool),
    connect = pool.connect.bind(pool);
  pool.query = function (...args) {
    if (!context.getStore()) return query(...args);
    if (args.some((arg) => typeof arg === "function"))
      throw Error("Callbacks unavailable in support view");
    return (async () => {
      const client = await connect();
      try {
        await client.query("BEGIN READ ONLY");
        const result = await client.query(...args);
        await client.query("ROLLBACK");
        return result;
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    })();
  };
  pool.connect = function (...args) {
    if (context.getStore())
      throw Error("Transactions unavailable in support view");
    return connect(...args);
  };
}
module.exports = { context, protectPool };
