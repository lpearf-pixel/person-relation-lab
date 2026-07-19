import Fastify, { type FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { z } from "zod";

export type ImportStatus = { roots: string[]; files: Array<{ path: string; state: string; size: number }> };
export type RelationshipResponse = {
  relationType: string; confidence: number; completeness: number; evidence: string[]; disclaimer: string;
};
export type AppServices = {
  listImports(): Promise<ImportStatus>;
  queryRelationship(personA: string, personB: string): Promise<RelationshipResponse | null>;
};

const Query = z.object({ personA: z.string().trim().min(1), personB: z.string().trim().min(1) })
  .refine((value) => value.personA !== value.personB, "people must be different");

export function buildApp(services: AppServices): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  app.get("/", async (_request, reply) => reply.type("text/html; charset=utf-8").send(await asset("index.html")));
  app.get("/app.js", async (_request, reply) => reply.type("text/javascript; charset=utf-8").send(await asset("app.js")));
  app.get("/styles.css", async (_request, reply) => reply.type("text/css; charset=utf-8").send(await asset("styles.css")));
  app.get("/api/v1/health", async () => ({ status: "ok" }));
  app.get("/api/v1/imports/status", async () => services.listImports());
  app.post("/api/v1/relations/query", async (request, reply) => {
    const parsed = Query.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", details: parsed.error.issues });
    const result = await services.queryRelationship(parsed.data.personA, parsed.data.personB);
    if (!result) return reply.code(404).send({ error: "relationship_not_found" });
    return result;
  });
  return app;
}

async function asset(name: string): Promise<string> {
  return readFile(new URL(`../public/${name}`, import.meta.url), "utf8");
}
