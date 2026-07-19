import { buildApp, type AppServices } from "./app.js";
import { discoverFiles } from "./ingest/discovery.js";
import { Pool } from "pg";
import { PgRelationshipService } from "./db/relationship-service.js";
import { PgImportSink, PgSourceRegistry } from "./db/repository.js";
import { importFile } from "./ingest/pipeline.js";
import { AutoImportWorker } from "./ingest/worker.js";

const roots = (process.env.IMPORT_ROOTS ?? "./imports").split(",").map((item) => item.trim()).filter(Boolean);
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 10 }) : null;
const relationshipService = pool ? new PgRelationshipService(pool) : null;
const scanIntervalMs = Number(process.env.SCAN_INTERVAL_MS ?? 30_000);
const worker = pool ? new AutoImportWorker(
  roots,
  new PgSourceRegistry(pool),
  (path, sourceFileId) => importFile(path, sourceFileId, new PgImportSink(pool), Number(process.env.IMPORT_BATCH_SIZE ?? 2_000)),
  { settleMs: Number(process.env.FILE_SETTLE_MS ?? 60_000) }
) : null;
const services: AppServices = {
  async listImports() {
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
