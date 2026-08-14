import { buildApp, type AppServices } from "./app.js";
import { discoverFiles } from "./ingest/discovery.js";
import { Pool } from "pg";
import { PgRelationshipService } from "./db/relationship-service.js";
import { PgImportSink, PgSourceRegistry } from "./db/repository.js";
import { importFile } from "./ingest/pipeline.js";
import { AutoImportWorker } from "./ingest/worker.js";
import { PgProjectionBuilder } from "./db/projection-builder.js";

const roots = (process.env.IMPORT_ROOTS ?? "./imports").split(",").map((item) => item.trim()).filter(Boolean);
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 10 }) : null;
const relationshipService = pool ? new PgRelationshipService(pool) : null;
const scanIntervalMs = Number(process.env.SCAN_INTERVAL_MS ?? 30_000);
const projectionBuilder = pool ? new PgProjectionBuilder(
  pool,
  Number(process.env.PROJECTION_BATCH_SIZE ?? 2_000),
  Number(process.env.RELATION_BATCH_SIZE ?? 2_000)
) : null;
const worker = pool ? new AutoImportWorker(
  roots,
  new PgSourceRegistry(pool),
  async (path, sourceFileId) => {
    const result = await importFile(path, sourceFileId, new PgImportSink(pool), Number(process.env.IMPORT_BATCH_SIZE ?? 2_000));
    await projectionBuilder?.projectSource(sourceFileId);
    return result;
  },
  { settleMs: Number(process.env.FILE_SETTLE_MS ?? 60_000) }
) : null;
const services: AppServices = {
  async listImports() {
    if (pool) {
      const status = await pool.query(`SELECT DISTINCT ON (approved_root, relative_path)
        relative_path AS path, state, size_bytes AS size FROM ingest.source_file
        ORDER BY approved_root, relative_path, discovered_at DESC`);
      return { roots, files: status.rows.map((row) => ({ path: String(row.path), state: String(row.state), size: Number(row.size) })) };
    }
    const files = [];
    for (const root of roots) {
      try {
        for (const file of await discoverFiles(root)) files.push({ path: file.relativePath, state: "discovered", size: file.size });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return { roots, files };
  },
  async queryRelationship(personA, personB) { return relationshipService?.query(personA, personB) ?? null; }
};

const app = buildApp(services);
let scanning = false;
const scan = async () => {
  if (!worker || scanning) return;
  scanning = true;
  try { await worker.scan(); } catch (error) { app.log.error(error, "automatic import scan failed"); }
  finally { scanning = false; }
};
const timer = worker && scanIntervalMs > 0 ? setInterval(() => void scan(), scanIntervalMs) : null;
if (timer) timer.unref();
void scan();
app.addHook("onClose", async () => { if (timer) clearInterval(timer); await pool?.end(); });
await app.listen({ host: process.env.BIND_HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 8787) });
