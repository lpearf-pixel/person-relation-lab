import { expect, it, vi } from "vitest";
import { runSecondaryProcessing } from "../src/db/run-secondary-processing.js";

it("processes complete sources serially before rebuilding profiles", async () => {
  const events: string[] = [];
  const database = {
    query: vi.fn(async () => ({
      rows: [
        { id: "source-1", relative_path: "synthetic-1.csv" },
        { id: "source-2", relative_path: "synthetic-2.csv" }
      ]
    })),
    connect: vi.fn()
  };
  const builder = {
    processSource: vi.fn(async (sourceFileId: string) => {
      events.push(`source:${sourceFileId}`);
      return { processedRecords: 2 };
    })
  };
  const profiler = {
    rebuild: vi.fn(async () => {
      events.push("profiles");
      return { profiledValues: 3 };
    })
  };

  await expect(runSecondaryProcessing(database, {
    pageSize: 100,
    builderFactory: () => builder,
    profilerFactory: () => profiler
  })).resolves.toEqual({
    selectedSources: 2,
    completedSources: 2,
    processedRecords: 4,
    profiledValues: 3
  });

  expect(events).toEqual(["source:source-1", "source:source-2", "profiles"]);
  expect(database.query.mock.calls[0]?.[0]).toContain("WHERE state = 'complete'");
});
