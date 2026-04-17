// Decorates Fastify with `app.db` (Drizzle client) and `app.sql` (raw
// `postgres` driver) so route handlers can query both.

import fp from "fastify-plugin";
import { createDb, type DbClient, type SqlClient } from "@oddzilla/db";

declare module "fastify" {
  interface FastifyInstance {
    db: DbClient;
    sql: SqlClient;
  }
}

export default fp<{ databaseUrl: string }>(async (app, opts) => {
  const { db, sql } = createDb(opts.databaseUrl);
  app.decorate("db", db);
  app.decorate("sql", sql);
  app.addHook("onClose", async () => {
    await sql.end();
  });
});
