import { buildApp, type AppServices } from "./app.js";
import { discoverFiles } from "./ingest/discovery.js";
import { Pool } from "pg";
import { PgRelationshipService } from "./db/relationship-service.js";

const roots = (process.env.IMPORT_ROOTS ?? "./imports").split(",").map((item) => item.trim()).filter(Boolean);
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL, max: 10 }) : null;
const relationshipService = pool ? new PgRelationshipService(pool) : null;
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
app.addHook("onClose", async () => { await pool?.end(); });
await app.listen({ host: process.env.BIND_HOST ?? "127.0.0.1", port: Number(process.env.PORT ?? 8787) });
