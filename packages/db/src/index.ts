import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export type DbClient = ReturnType<typeof createDb>["db"];
export type SqlClient = ReturnType<typeof createDb>["sql"];

export function createDb(url: string) {
  const sql = postgres(url, {
    max: 10,
    prepare: false,
  });
  const db = drizzle(sql, { schema, casing: "snake_case" });
  return { db, sql };
}

export { schema };
export * from "./schema/index.js";
