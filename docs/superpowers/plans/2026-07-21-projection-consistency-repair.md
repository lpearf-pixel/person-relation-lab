# Projection Consistency Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ensure first-pass person observations are never omitted and `projectSource()` reports the database-verified projection count.

**Architecture:** Continue using the existing PostgreSQL CTE batch materializer. Connect observation creation to the person upsert's `RETURNING` relation, then run a source-scoped count after relationship materialization and expose that count to callers.

**Tech Stack:** TypeScript, Node.js 24, PostgreSQL 16, Vitest, Docker Compose

## Global Constraints

- Do not delete or rewrite raw imported data.
- Preserve idempotent recovery for partially projected sources.
- Do not change relationship classification behavior in this repair.
- A completion count must reflect committed `core.person_observation` rows.

---

### Task 1: Add projection consistency regression coverage

**Files:**
- Modify: `tests/projector.test.ts`

**Interfaces:**
- Consumes: `PgProjectionBuilder.projectSource(sourceFileId: string)`
- Produces: assertions for the person-returning join and verified result count

- [ ] **Step 1: Write a failing test**

Configure the query mock to return one raw page, an empty page, relationship results, and a final `{ projected_records: "7" }` verification row. Assert the method returns `{ projectedRecords: 7 }`. Inspect the `jsonb_to_recordset` SQL and require `JOIN inserted_people p USING(identity_key)` while rejecting `JOIN core.person p USING(identity_key)`.

- [ ] **Step 2: Verify the test fails for the expected reason**

Run: `npm test -- tests/projector.test.ts`

Expected: the current implementation returns `{ projectedRecords: 1 }` and its SQL scans `core.person`.

### Task 2: Repair observation materialization and completion reporting

**Files:**
- Modify: `src/db/projection-builder.ts`
- Test: `tests/projector.test.ts`

**Interfaces:**
- Consumes: `inserted_people(id, identity_key)` from the existing CTE
- Produces: `projectSource(sourceFileId): Promise<{ projectedRecords: number }>` based on a committed database count

- [ ] **Step 1: Implement the smallest repair**

Change the observation source to `FROM input i JOIN inserted_people p USING(identity_key)`. After relationship materialization, execute a source-scoped count joining `core.person_observation` to `raw.record`, parse the PostgreSQL bigint string safely, and return it.

- [ ] **Step 2: Verify focused tests pass**

Run: `npm test -- tests/projector.test.ts`

Expected: all projector tests pass.

- [ ] **Step 3: Run the full quality gate**

Run: `npm run verify`

Expected: lint, all unit tests, and TypeScript build pass.

- [ ] **Step 4: Commit and publish**

Commit the design, plan, test, and implementation with an explicit projection-consistency message and push the current branch to GitHub.

