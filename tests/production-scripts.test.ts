import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("runs migrations from compiled JavaScript in the production image", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> };
  expect(pkg.scripts.migrate).toBe("node dist/db/migrate.js");
  expect(pkg.scripts["migrate:dev"]).toBe("tsx src/db/migrate.ts");
  expect(pkg.scripts["repair:projections"]).toBe("node dist/db/repair-projections.js");
});

it("provides safe pause, resume and monitoring scripts with tmp logs", async () => {
  const paths = [
    "scripts/pause-processing.sh",
    "scripts/resume-processing.sh",
    "scripts/watch-processing.sh"
  ];
  const [pause, resume, watch] = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  for (const script of [pause, resume, watch]) {
    expect(script).toContain("set -Eeuo pipefail");
    expect(script).toContain("/tmp/person-relation-");
    expect(script).toContain("docker compose");
    expect(script).not.toMatch(/down\s+-v|volume\s+rm|DROP TABLE|TRUNCATE|DELETE FROM raw\.record/i);
  }
  expect(pause).toContain("docker compose stop app");
  expect(pause).toContain("/tmp/person-relation-pause-latest.log");
  expect(resume).toContain("npm run migrate");
  expect(resume).toContain("npm run repair:projections");
  expect(resume).toContain("/tmp/person-relation-resume-latest.log");
  expect(watch).toContain("ingest.projection_checkpoint");
  expect(watch).toContain("/tmp/person-relation-watch-latest.log");
});
