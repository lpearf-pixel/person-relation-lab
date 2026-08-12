# Stale Projection Checkpoint Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover sources whose legacy `people` checkpoint is complete even though some raw records have no person observation, without deleting data or restarting completed work after an interruption.

**Architecture:** The projector validates observation coverage after acquiring the source advisory lock. A stale completed `people` checkpoint atomically resets all four source checkpoints once; subsequent runs recognize the running repair and continue from its committed cursor. People pages select only raw records without an observation, while relationship stages replay idempotently from zero so newly recovered observations contribute evidence.

**Tech Stack:** TypeScript, Node.js 24, PostgreSQL 16, Vitest, Docker Compose.

## Global Constraints

- Preserve every `raw.record`, `core.person`, `core.person_observation`, evidence row, relationship row, and Docker volume.
- Never infer completion from checkpoint state alone; raw and observation counts must match.
- Reset relationship cursors only once when a stale completed people checkpoint is detected.
- Every people batch and checkpoint advance remains one PostgreSQL statement.
- Repeated recovery and interrupted recovery remain idempotent.

---

### Task 1: Reproduce Legacy Checkpoint Pollution

**Files:**
- Modify: `tests/projector.test.ts`

**Interfaces:**
- Produces: regression coverage for `raw > projected` with four completed stages.

- [x] Add a projector test in which the preflight reports a completed stale people checkpoint, then assert that all four checkpoints are invalidated and only raw rows without observations are selected.
- [x] Add a resume test in which the people checkpoint is already running and assert that it is not reset to zero a second time.
- [x] Run `npm test -- tests/projector.test.ts` and confirm the new tests fail for missing preflight repair behavior.

### Task 2: Implement One-Time Self-Healing Recovery

**Files:**
- Modify: `src/db/projection-builder.ts`

**Interfaces:**
- Produces: `preparePeopleStage(client, sourceFileId)` preflight.
- Consumes: existing stage checkpoint table and advisory source lock.

- [x] Add a preflight query that compares raw and observation counts and reads the people checkpoint state.
- [x] When coverage is incomplete and the people checkpoint is `complete`, atomically reset `people`, `mobile`, `address`, and `company` cursors and states.
- [x] Change people pagination to use `NOT EXISTS` against `core.person_observation`, so the repair reads and writes only missing observations.
- [x] Keep a running or failed people cursor unchanged on later invocations so interrupted repairs resume.
- [x] Run the focused projector and repair tests until green.

### Task 3: Verification and Delivery

**Files:**
- Modify: `README.md`
- Modify: `docs/progress.md`

**Interfaces:**
- Produces: operator-visible explanation of automatic stale-checkpoint repair.

- [x] Document that `resume-processing.sh` automatically invalidates stale completed checkpoints and does not delete existing data.
- [x] Run `npm run verify`.
- [x] Run `bash -n scripts/pause-processing.sh scripts/resume-processing.sh scripts/watch-processing.sh`.
- [ ] Commit the tested patch, push `codex/resumable-projection`, and update PR #1.
