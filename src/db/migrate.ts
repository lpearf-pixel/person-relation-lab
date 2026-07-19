import { readFile, readdir } from "node:fs/promises";
import { Pool } from "pg";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  await pool.query("CREATE TABLE IF NOT EXISTS public.schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())");
  const directory = new URL("../../migrations/", import.meta.url);
  const files = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
  for (const name of files) {
    const applied = await pool.query("SELECT 1 FROM public.schema_migration WHERE name = $1", [name]);
    if (applied.rowCount) continue;
    await pool.query(await readFile(new URL(name, directory), "utf8"));
    await pool.query("INSERT INTO public.schema_migration(name) VALUES ($1)", [name]);
  }
  console.log("database migration complete");
} finally {
  await pool.end();
}
