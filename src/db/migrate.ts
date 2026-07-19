import { readFile } from "node:fs/promises";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  const sql = await readFile(new URL("../../migrations/001_initial.sql", import.meta.url), "utf8");
  await pool.query(sql);
  console.log("database migration complete");
} finally {
  await pool.end();
}
