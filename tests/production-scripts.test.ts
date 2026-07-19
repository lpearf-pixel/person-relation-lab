import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("runs migrations from compiled JavaScript in the production image", async () => {
  const pkg = JSON.parse(await readFile("package.json", "utf8")) as { scripts: Record<string, string> };
  expect(pkg.scripts.migrate).toBe("node dist/db/migrate.js");
  expect(pkg.scripts["migrate:dev"]).toBe("tsx src/db/migrate.ts");
});
