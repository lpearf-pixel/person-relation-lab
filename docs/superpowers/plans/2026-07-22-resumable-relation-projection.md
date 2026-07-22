# Resumable Relationship Projection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace source-wide relationship transactions with indexed, checkpointed batches that can be stopped and resumed without losing committed work.

**Architecture:** PostgreSQL stores one monotonic cursor per source and projection stage. `PgProjectionBuilder` owns a dedicated connection and source advisory lock, while focused SQL helpers atomically write one batch of data and its checkpoint. A serial repair CLI and three operator scripts provide safe pause, resume, and observable progress.

**Tech Stack:** TypeScript, Node.js 24, PostgreSQL 16, `pg`, Vitest, Docker Compose, Bash.

## Global Constraints

- Preserve all `raw.record`, `core.person`, `core.person_observation`, `relation-v2` evidence, and Docker volumes.
- Use `relation-v3` for new evidence and relationship projections.
- Keep mobile cardinality at 2–5, address at 2–10, and company at 2–5 distinct people.
- Default `PROJECTION_BATCH_SIZE` and `RELATION_BATCH_SIZE` to `2000`.
- Each data batch and its checkpoint advance must commit atomically.
- Run one projector per source through a PostgreSQL advisory lock.
- Do not infer or label a relationship as proven romance, kinship, or extramarital activity.

## File Structure

- Create `migrations/004_resumable_projection.sql`: checkpoint table and partial v3 evidence uniqueness.
- Create `src/db/projection-sql.ts`: stage definitions and bounded evidence/projection SQL generation.
- Modify `src/db/repository.ts`: connection/client interfaces used for locks and transactions.
- Rewrite `src/db/projection-builder.ts`: source lock, resumable people stage, evidence stage loop, verification.
- Create `src/db/repair-projections.ts`: serial recovery entry point for all registered sources.
- Modify `src/db/relationship-service.ts`: deduplicate old/new algorithm versions during traversal and evidence reads.
- Modify `src/server.ts`, `compose.yaml`, and `package.json`: relation batch configuration and recovery entry point.
- Create `scripts/pause-processing.sh`, `scripts/resume-processing.sh`, and `scripts/watch-processing.sh`: safe operations with `/tmp` logs.
- Modify `README.md` and `docs/progress.md`: deployment and recovery instructions.
- Modify `tests/schema.test.ts`, `tests/projector.test.ts`, `tests/relationship-service.test.ts`, and `tests/production-scripts.test.ts`; create `tests/repair-projections.test.ts`.

---

### Task 1: Durable Projection Checkpoints

**Files:**
- Create: `migrations/004_resumable_projection.sql`
- Modify: `tests/schema.test.ts`

**Interfaces:**
- Produces: `ingest.projection_checkpoint(source_file_id, stage, last_raw_record_id, processed_rows, state, updated_at, completed_at)`.
- Produces: partial unique index `relationship_evidence_v3_unique` used by `ON CONFLICT` in Task 3.

- [ ] **Step 1: Write the failing schema test**

Add a test that reads migration 004 and requires the table, state constraint, foreign key, monotonic cursor columns, and the partial `relation-v3` index:

```ts
it("adds resumable projection checkpoints and v3 evidence idempotency", async () => {
  const sql = await readFile(new URL("../migrations/004_resumable_projection.sql", import.meta.url), "utf8");
  expect(sql).toContain("CREATE TABLE IF NOT EXISTS ingest.projection_checkpoint");
  expect(sql).toContain("PRIMARY KEY (source_file_id, stage)");
  expect(sql).toContain("last_raw_record_id BIGINT NOT NULL DEFAULT 0");
  expect(sql).toContain("processed_rows BIGINT NOT NULL DEFAULT 0");
  expect(sql).toContain("'pending','running','complete','failed'");
  expect(sql).toContain("relationship_evidence_v3_unique");
  expect(sql).toContain("WHERE algorithm_version = 'relation-v3'");
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npm test -- tests/schema.test.ts`

Expected: FAIL because `migrations/004_resumable_projection.sql` does not exist.

- [ ] **Step 3: Add the migration**

Create the table with stage and state check constraints, non-negative cursor/count checks, source foreign key with cascade, timestamps, and primary key. Add this partial unique index:

```sql
CREATE UNIQUE INDEX IF NOT EXISTS relationship_evidence_v3_unique
ON evidence.relationship_evidence(
  person_a_id, person_b_id, source_record_id, kind, algorithm_version
)
WHERE algorithm_version = 'relation-v3';
```

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- tests/schema.test.ts`

Expected: all schema tests PASS.

- [ ] **Step 5: Commit**

```bash
git add migrations/004_resumable_projection.sql tests/schema.test.ts
git commit -m "feat: add resumable projection checkpoints"
```

### Task 2: Connection Ownership, Advisory Lock, and People Cursor

**Files:**
- Modify: `src/db/repository.ts`
- Modify: `src/db/projection-builder.ts`
- Rewrite: `tests/projector.test.ts`

**Interfaces:**
- Produces: `DatabaseClient extends Queryable { release(): void }`.
- Produces: `ConnectableDatabase extends Queryable { connect(): Promise<DatabaseClient> }`.
- Produces: `PgProjectionBuilder(database, projectionBatchSize, relationBatchSize)`.
- Produces: `projectSource(sourceFileId): Promise<{ projectedRecords: number }>`.

- [ ] **Step 1: Write failing lock and people-resume tests**

Use a fake dedicated client that records SQL, returns `locked: true`, a saved people cursor of `10`, one raw row at ID `12`, then an empty page. Assert:

```ts
expect(sql).toContain("pg_try_advisory_lock");
expect(rawPageCall?.[1]).toEqual([sourceId, "10", 100]);
expect(candidateSql).toContain("ingest.projection_checkpoint");
expect(candidateSql).toContain("GREATEST(ingest.projection_checkpoint.last_raw_record_id");
expect(sql).toContain("pg_advisory_unlock");
expect(client.release).toHaveBeenCalledOnce();
```

Add a second test returning `locked: false` and assert that no raw rows are selected and the connection is released.

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test -- tests/projector.test.ts`

Expected: FAIL because the builder does not call `connect`, acquire a lock, or read a checkpoint.

- [ ] **Step 3: Add connection interfaces**

In `src/db/repository.ts`, keep `Queryable` and add:

```ts
export type DatabaseClient = Queryable & { release(): void };
export type ConnectableDatabase = Queryable & { connect(): Promise<DatabaseClient> };
```

- [ ] **Step 4: Implement source lock and people checkpoint loop**

Change the builder to require `ConnectableDatabase`. `projectSource` must:

1. call `database.connect()`;
2. call `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked`;
3. throw `projection already running for source <id>` when false;
4. read the `people` cursor from `ingest.projection_checkpoint`;
5. select raw pages after that cursor;
6. pass the page maximum ID into the candidate materialization statement;
7. upsert the `people` checkpoint in the same data-modifying statement;
8. mark `people` complete on the first empty page;
9. unlock and release in `finally`.

The checkpoint upsert must set `last_raw_record_id = GREATEST(existing, excluded)`, add the committed batch size to `processed_rows`, set state `running`, and clear `completed_at`.

- [ ] **Step 5: Verify GREEN**

Run: `npm test -- tests/projector.test.ts`

Expected: lock, resume, candidate materialization, and release tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/repository.ts src/db/projection-builder.ts tests/projector.test.ts
git commit -m "feat: resume person projection from database cursor"
```

### Task 3: Bounded Evidence and Relationship Batches

**Files:**
- Create: `src/db/projection-sql.ts`
- Modify: `src/db/projection-builder.ts`
- Modify: `tests/projector.test.ts`

**Interfaces:**
- Produces: `RELATION_STAGES`, a readonly definition for `mobile`, `address`, and `company`.
- Produces: `relationshipBatchSql(stage): string`.
- Consumes: the partial v3 uniqueness index from Task 1.

- [ ] **Step 1: Write failing SQL-shape and stage-resume tests**

Require three independently checkpointed stages and assert each generated statement contains:

```ts
expect(sql).toContain("ORDER BY o.raw_record_id LIMIT $3");
expect(sql).toContain("JOIN core.person_observation matched");
expect(sql).toContain("LEAST(source.person_id, matched.person_id)");
expect(sql).toContain("GREATEST(source.person_id, matched.person_id)");
expect(sql).toContain("algorithm_version = 'relation-v3'");
expect(sql).toContain("ON CONFLICT (person_a_id, person_b_id, source_record_id, kind, algorithm_version)");
expect(sql).toContain("INSERT INTO projection.relationship");
expect(sql).toContain("INSERT INTO ingest.projection_checkpoint");
expect(sql).not.toContain("source_people");
```

Assert the builder reads the saved cursor for every stage, passes `RELATION_BATCH_SIZE`, repeats while `processed_rows > 0`, and marks a stage complete only after an empty batch.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- tests/projector.test.ts`

Expected: FAIL because relationship SQL is still source-wide and no per-channel cursor exists.

- [ ] **Step 3: Implement focused SQL generation**

Define exact metadata:

```ts
export const RELATION_STAGES = [
  { stage: "mobile", column: "mobile_hash", kind: "shared_private_mobile", channel: "contact", weight: 45, maxPeople: 5, explanation: "归一化私人联系方式相同" },
  { stage: "address", column: "address_hash", kind: "same_address", channel: "household", weight: 35, maxPeople: 10, explanation: "非空归一化地址相同" },
  { stage: "company", column: "company_hash", kind: "same_company", channel: "organization", weight: 15, maxPeople: 5, explanation: "归一化单位相同" }
] as const;
```

Generate one SQL statement with these CTEs: `batch`, `eligible_hash`, `matches`, `inserted_evidence`, `affected_pairs`, `scores`, `classified`, `projected`, and `checkpointed`. The final result returns `COUNT(batch)::text AS processed_rows` and `MAX(raw_record_id)::text AS last_raw_record_id`. Identifiers come only from trusted stage metadata; all runtime values use parameters.

- [ ] **Step 4: Replace source-wide relationship calls**

Remove `PAIRS`, `RELATIONSHIP_EVIDENCE_SQL`, and `RELATIONSHIP_PROJECTION_SQL`. For each `RELATION_STAGES` entry:

1. load its saved cursor;
2. execute `relationshipBatchSql(stage)` with source ID, cursor, and relation batch size;
3. continue from returned maximum raw ID while processed rows are positive;
4. mark the stage complete after an empty batch;
5. on a stage SQL error, set that stage checkpoint to `failed` without advancing its cursor, then rethrow;
6. emit a structured `console.info` record after every committed batch and completed stage.

- [ ] **Step 5: Verify GREEN and regression constraints**

Run: `npm test -- tests/projector.test.ts tests/relations.test.ts`

Expected: all projection tests PASS; cardinality and classification tests remain PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/projection-sql.ts src/db/projection-builder.ts tests/projector.test.ts
git commit -m "feat: batch relationship projection by resumable stage"
```

### Task 4: Completion Verification and Version-Safe Reads

**Files:**
- Modify: `src/db/projection-builder.ts`
- Modify: `src/db/repository.ts`
- Modify: `src/db/relationship-service.ts`
- Modify: `tests/projector.test.ts`
- Modify: `tests/postgres.test.ts`
- Modify: `tests/relationship-service.test.ts`

**Interfaces:**
- Produces: completion verification requiring raw/observation equality and four completed checkpoints.
- Produces: `FIND_PATHS_SQL` with one active edge per person pair and relation type, preferring `relation-v3`.

- [ ] **Step 1: Write failing completion tests**

Test that `projectSource` rejects these results:

```ts
{ raw_records: "200", projected_records: "199", completed_stages: "4" }
{ raw_records: "200", projected_records: "200", completed_stages: "3" }
```

Require an error containing `projection incomplete`. Test success only for `{ raw_records: "200", projected_records: "200", completed_stages: "4" }`.

- [ ] **Step 2: Write failing version-preference tests**

Assert `FIND_PATHS_SQL` uses `ROW_NUMBER() OVER (...)`, orders `relation-v3` before `relation-v2`, and includes only rank 1. Assert evidence detail lookup filters by the selected relationship's `algorithm_version`.

- [ ] **Step 3: Run tests and verify RED**

Run: `npm test -- tests/projector.test.ts tests/postgres.test.ts tests/relationship-service.test.ts`

Expected: FAIL because completion checks only observation count and path SQL exposes both versions.

- [ ] **Step 4: Implement strict completion and version preference**

After all stage loops, query raw count, observation count, and count of completed checkpoints in `('people','mobile','address','company')`. Throw without changing `source_file.state` unless counts match exactly and completed stage count is four.

Wrap the current relationship edge source in a ranked CTE partitioned by canonical pair and `relation_type`; order `CASE algorithm_version WHEN 'relation-v3' THEN 0 WHEN 'relation-v2' THEN 1 ELSE 2 END`, then `updated_at DESC`. Build recursive edges only from rank 1. Join evidence details on both pair endpoints and matching algorithm version.

- [ ] **Step 5: Verify GREEN**

Run: `npm test -- tests/projector.test.ts tests/postgres.test.ts tests/relationship-service.test.ts`

Expected: all targeted tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/projection-builder.ts src/db/repository.ts src/db/relationship-service.ts tests/projector.test.ts tests/postgres.test.ts tests/relationship-service.test.ts
git commit -m "fix: verify projection completion and prefer v3 edges"
```

### Task 5: Serial Recovery Entry Point and Runtime Configuration

**Files:**
- Create: `src/db/repair-projections.ts`
- Create: `tests/repair-projections.test.ts`
- Modify: `src/server.ts`
- Modify: `compose.yaml`
- Modify: `package.json`

**Interfaces:**
- Produces: `repairRegisteredSources(database, options): Promise<RepairSummary>`.
- Produces: command `npm run repair:projections` executing `node dist/db/repair-projections.js`.

- [ ] **Step 1: Write failing repair selection test**

Given registered sources with missing observations or incomplete projection checkpoints, assert the repair function calls `projectSource` once per source in discovery order, continues past already consistent sources, and stops on the first failed source with a non-zero CLI exit.

- [ ] **Step 2: Run test and verify RED**

Run: `npm test -- tests/repair-projections.test.ts`

Expected: FAIL because the repair module does not exist.

- [ ] **Step 3: Implement the serial repair module**

Select every registered source for which either raw/observation counts differ or fewer than four stages are complete. Process one source at a time with `PgProjectionBuilder`. Log `RECOVERY_SOURCE_START`, committed batch events from the builder, `RECOVERY_SOURCE_COMPLETE`, and a final summary. On error, rely on the builder's stage-level failure marker, insert `projection_failed` into `audit.event`, log the error, and set `process.exitCode = 1`.

- [ ] **Step 4: Wire batch configuration**

Pass `Number(process.env.RELATION_BATCH_SIZE ?? 2_000)` from both `src/server.ts` and the repair CLI. Add `RELATION_BATCH_SIZE: ${RELATION_BATCH_SIZE:-2000}` to `compose.yaml`. Add:

```json
"repair:projections": "node dist/db/repair-projections.js"
```

- [ ] **Step 5: Verify GREEN**

Run: `npm test -- tests/repair-projections.test.ts tests/projector.test.ts && npm run build`

Expected: tests PASS and TypeScript build exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/db/repair-projections.ts tests/repair-projections.test.ts src/server.ts compose.yaml package.json
git commit -m "feat: add serial resumable projection recovery"
```

### Task 6: Safe Pause, Resume, and Monitoring Scripts

**Files:**
- Create: `scripts/pause-processing.sh`
- Create: `scripts/resume-processing.sh`
- Create: `scripts/watch-processing.sh`
- Modify: `tests/production-scripts.test.ts`

**Interfaces:**
- Produces: `./scripts/pause-processing.sh` with `/tmp/person-relation-pause-latest.log`.
- Produces: `./scripts/resume-processing.sh` with `/tmp/person-relation-resume-latest.log`.
- Produces: `./scripts/watch-processing.sh [seconds]` with `/tmp/person-relation-watch-latest.log`.

- [ ] **Step 1: Write failing script safety tests**

Read all three scripts as text. Require `set -Eeuo pipefail`, `/tmp/person-relation-`, `docker compose`, and stable latest-log paths. Assert none contains `down -v`, `volume rm`, `DROP TABLE`, `TRUNCATE`, or `DELETE FROM raw.record`. Require pause to call `docker compose stop app`, resume to run migration then `repair:projections`, and monitor to query `ingest.projection_checkpoint`.

- [ ] **Step 2: Run test and verify RED**

Run: `npm test -- tests/production-scripts.test.ts`

Expected: FAIL because the scripts do not exist.

- [ ] **Step 3: Implement pause script**

The script must stop `app`, cancel only active SQL containing known projection markers (`relation-v2`, `relation-v3`, `projection_checkpoint`, or the legacy observation self-join), poll `pg_stat_activity` until those statements disappear, print source and checkpoint status, and leave `db` running.

- [ ] **Step 4: Implement resume script**

The script must ensure `db` is healthy, keep `app` stopped, build the image, run migrations, run `npm run repair:projections` in one foreground container, verify every registered source, then start `app`. A failed or interrupted repair must not start the app automatically.

- [ ] **Step 5: Implement monitor script**

Every configured interval, print timestamp, source states, projection checkpoints, raw/observation/evidence/relationship totals, active SQL duration and blockers, PostgreSQL temp/WAL counters, and `docker stats --no-stream`. `Ctrl+C` must stop only the monitor.

- [ ] **Step 6: Make scripts executable and verify GREEN**

Run:

```bash
chmod +x scripts/pause-processing.sh scripts/resume-processing.sh scripts/watch-processing.sh
npm test -- tests/production-scripts.test.ts
bash -n scripts/pause-processing.sh scripts/resume-processing.sh scripts/watch-processing.sh
```

Expected: tests PASS and Bash syntax check exits 0.

- [ ] **Step 7: Commit**

```bash
git add scripts tests/production-scripts.test.ts
git commit -m "feat: add safe projection operations scripts"
```

### Task 7: Documentation and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `docs/progress.md`

**Interfaces:**
- Consumes: all commands and environment variables from Tasks 1–6.
- Produces: one operator workflow for upgrade, pause, resume, monitor, and log handoff.

- [ ] **Step 1: Update operator documentation**

Document this sequence:

```bash
git pull --ff-only origin main
./scripts/pause-processing.sh
./scripts/resume-processing.sh
```

Document a second terminal running `./scripts/watch-processing.sh 30`, the three latest log paths under `/tmp`, checkpoint semantics, safe interruption behavior, and the prohibition on `docker compose down -v`.

- [ ] **Step 2: Run focused safety checks**

Run:

```bash
rg -n "source_people|CROSS JOIN LATERAL" src/db/projection-builder.ts src/db/projection-sql.ts
rg -n "down -v|volume rm|DROP TABLE|TRUNCATE|DELETE FROM raw.record" scripts
```

Expected: both commands return no matches.

- [ ] **Step 3: Run the complete quality gate**

Run: `npm run verify`

Expected: ESLint exits 0, all Vitest tests pass, and TypeScript build exits 0.

- [ ] **Step 4: Run production artifact checks**

Run:

```bash
docker compose build app
docker compose run --rm --no-deps app sh -c "npm run migrate && test -f dist/db/repair-projections.js"
```

Expected: image builds, migration reports completion, and compiled recovery entry point exists. If Docker is unavailable in the development environment, record this exact unexecuted gate for the user's local deployment script and do not claim it passed.

- [ ] **Step 5: Commit documentation**

```bash
git add README.md docs/progress.md
git commit -m "docs: document resumable projection operations"
```

- [ ] **Step 6: Final branch verification**

Run:

```bash
git status --short
git log --oneline origin/main..HEAD
npm run verify
```

Expected: worktree is clean, commits are limited to this feature, and the full quality gate passes again.
