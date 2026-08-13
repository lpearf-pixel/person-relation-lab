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

it("provides an indexed direct relationship query script", async () => {
  const script = await readFile("scripts/query-direct-relations.sh", "utf8");
  expect(script).toContain("set -Eeuo pipefail");
  expect(script).toContain('TARGET_NAME=${1:-SUWENLONG}');
  expect(script).toContain('GENDER_MODE=${4:-opposite}');
  expect(script).toContain("/tmp/person-relation-direct-relations-latest.csv");
  expect(script).toContain("JOIN target_people target ON target.id = relationship.person_a_id");
  expect(script).toContain("JOIN target_people target ON target.id = relationship.person_b_id");
  expect(script).toContain("ROW_NUMBER() OVER");
  expect(script).toContain("PARTITION BY candidate.target_id, candidate.related_id");
  expect(script).not.toContain("PARTITION BY candidate.target_id, candidate.related_id, candidate.relation_type");
  expect(script).toContain("target_person.gender <> related_person.gender");
  expect(script).toContain("gender_mode=\"$GENDER_MODE\"");
  expect(script).toContain("FROM relevant_people relevant");
  expect(script).toContain("ON observation.person_id = relevant.person_id");
  expect(script).toContain("-v target_name=\"$TARGET_NAME\"");
  expect(script).not.toContain("ON target.id = relationship.person_a_id OR");
  expect(script).not.toMatch(/\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP)\s+/i);
});

it("provides local coder wrappers that log output without executing it", async () => {
  const paths = [
    "scripts/local-coder-check.sh",
    "scripts/local-coder-task.sh",
    "scripts/ensure-dev-dependencies.sh"
  ];
  const [check, task, dependencies] = await Promise.all(paths.map((file) => readFile(file, "utf8")));
  for (const script of [check, task]) {
    expect(script).toContain("set -Eeuo pipefail");
    expect(script).toContain("./scripts/ensure-dev-dependencies.sh");
    expect(script).toContain("npm run build");
    expect(script).toContain("npm run local-coder");
    expect(script).not.toMatch(/\beval\b|git apply|source\s+\.env|docker compose exec\s+db/i);
  }
  expect(dependencies).toContain("set -Eeuo pipefail");
  expect(dependencies).toContain("node_modules/@types/node/package.json");
  expect(dependencies).toContain("node_modules/vitest/package.json");
  expect(dependencies).toContain("npm ci --include=dev");
  expect(dependencies).not.toContain("npm install");
  expect(check).toContain("/tmp/person-relation-local-coder-check-latest.log");
  expect(task).toContain("/tmp/person-relation-local-coder-task-latest.log");
  expect(task).toContain("/tmp/person-relation-local-coder-latest.md");
});
