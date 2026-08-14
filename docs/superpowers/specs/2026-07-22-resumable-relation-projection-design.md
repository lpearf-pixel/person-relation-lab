# Resumable Relationship Projection Design

## Context

Raw CSV/XLSX ingestion already checkpoints each sheet by source row. Person projection is idempotent but restarts its scan from the beginning. Relationship evidence and relationship projection currently run as two source-wide SQL statements. At multi-million-row scale those statements create very large temporary files, hold a transaction for hours, and lose all uncommitted relationship work when cancelled.

The repair must preserve imported raw records and committed projections while allowing an operator to pause the application, restart Docker, or reboot the host without restarting a source-wide relationship calculation.

## Goals

- Commit projection work in bounded batches.
- Resume every stage from its last committed database checkpoint.
- Make retries idempotent, including interruption immediately before or after commit.
- Replace the source-wide observation self-join with indexed equality joins for each evidence channel.
- Expose durable progress by source, stage, cursor, and processed row count.
- Prevent concurrent workers from projecting the same source.
- Preserve existing `relation-v2` data until the new calculation is verified.

## Non-goals

- Automatically assert romantic, family, or extramarital relationships.
- Delete existing `relation-v2` evidence during the upgrade.
- Introduce a message broker or graph database.
- Build a global pre-aggregated attribute graph in this change.

## Selected Approach

Use PostgreSQL-backed stage checkpoints and process one bounded source-observation batch per transaction. Evidence channels are processed independently in this order:

1. person observations
2. shared private mobile
3. same address
4. same company
5. source completion verification

This approach retains the current PostgreSQL architecture, makes interruption cheap, and avoids the operational complexity of an external job queue. A later optimization may introduce global hash-group tables without changing the checkpoint contract.

## Data Model

Add `ingest.projection_checkpoint`:

| Column | Purpose |
| --- | --- |
| `source_file_id` | Source being projected |
| `stage` | `people`, `mobile`, `address`, or `company` |
| `last_raw_record_id` | Exclusive cursor of the last committed batch |
| `processed_rows` | Cumulative source observations committed for the stage |
| `state` | `pending`, `running`, `complete`, or `failed` |
| `updated_at` | Liveness and progress timestamp |
| `completed_at` | Stage completion timestamp |

The primary key is `(source_file_id, stage)`. Cursor updates are monotonic.

Add a partial unique index for `relation-v3` evidence on:

`(person_a_id, person_b_id, source_record_id, kind, algorithm_version)`

The partial index avoids changing or deduplicating historical `relation-v2` rows while making every new evidence write retry-safe.

## Processing Model

### Source lock

Before projecting a source, the worker obtains a PostgreSQL advisory lock derived from the source UUID. If the lock is unavailable, that source is skipped rather than processed concurrently. The lock is held by a dedicated database connection for the duration of `projectSource` and released in `finally`.

### Person stage

The worker reads `raw.record` in ascending `id` order after the committed `people` cursor. A batch transaction:

1. normalizes the selected rows;
2. upserts `core.person`;
3. inserts missing `core.person_observation` and identifiers;
4. advances the `people` checkpoint to the batch's maximum raw record ID.

If the process stops before commit, all four actions roll back. If it stops after commit, the next run starts after the saved cursor.

### Evidence stages

Each evidence stage reads a bounded batch of source observations after its own cursor. The batch contains only the channel hash required by that stage.

For each distinct non-null hash in the batch, PostgreSQL uses the existing partial hash index to locate matching observations. A hash remains eligible only when its distinct-person cardinality is within the existing safety bounds:

- mobile: 2 through 5 people
- address: 2 through 10 people
- company: 2 through 5 people

Pairs are canonicalized with `LEAST(person_id)` and `GREATEST(person_id)`. Self-pairs are discarded. The source observation's raw record ID is the evidence provenance. Duplicate observations of the same pair in one batch are removed before insertion.

One batch transaction:

1. inserts `relation-v3` evidence with `ON CONFLICT DO NOTHING`;
2. identifies only pairs touched by the batch;
3. recomputes `relation-v3` scores for those pairs;
4. upserts the corresponding relationship projection;
5. advances that channel's checkpoint.

The projection update uses touched pairs even when evidence already exists, so replaying a batch repairs a previously missing projection without creating duplicate evidence.

### Stage completion

When no row remains after a stage cursor, that checkpoint becomes `complete`. A source is marked complete only when:

- raw-record count equals person-observation count;
- all four projection stages are complete;
- no stage checkpoint is stale or failed.

Existing source state is never trusted as the sole completion signal.

## Algorithm Version Compatibility

New writes use `relation-v3`. Historical `relation-v2` rows remain available during repair. Relationship reads prefer the highest supported algorithm version for an identical pair/type so old and new projections do not create duplicate traversal edges.

After all registered sources pass verification, a separate, explicit cleanup operation may mark `relation-v2` projections as `superseded`. Cleanup is not part of automatic resume and does not delete evidence.

## Pause, Resume, and Monitoring

Add operator scripts:

- `scripts/pause-processing.sh`: stops the app, cancels only known projection SQL, waits for rollback, and leaves PostgreSQL running.
- `scripts/resume-processing.sh`: applies migrations, builds/starts the app, and resumes incomplete stages.
- `scripts/watch-processing.sh`: prints per-source/stage cursor progress, active SQL, blockers, WAL/temp deltas, and container resource use.

Each script writes a timestamped log and updates a stable `/tmp/person-relation-*-latest.log` path. Scripts must never remove volumes or imported data.

The app logs one structured event per committed batch and one event per completed stage. Progress is therefore visible before a whole source completes.

## Failure Handling

- Cancellation: the active batch rolls back; committed checkpoints remain valid.
- Container restart: the worker reacquires the source lock and continues from checkpoints.
- Duplicate invocation: the advisory lock permits only one projector for a source.
- Invalid source row: normalization remains defensive; invalid optional values become null rather than aborting the source.
- SQL failure: the source remains incomplete, the checkpoint remains at the previous committed cursor, and an audit event records stage and reason.
- Checkpoint/data mismatch: completion verification fails closed and does not mark the source complete.

## Configuration

Use separate bounded settings:

- `PROJECTION_BATCH_SIZE`, default `2000`, for people.
- `RELATION_BATCH_SIZE`, default `2000`, for each evidence channel.

No global `work_mem` increase is required for correctness. Per-transaction settings may be evaluated later using measured `EXPLAIN (ANALYZE, BUFFERS)` output.

## Test Strategy

Unit and SQL-shape tests must cover:

- a second run begins after the saved people cursor;
- each evidence channel has an independent cursor;
- checkpoint advancement is in the same transaction as data writes;
- interruption before commit does not advance progress;
- replay does not duplicate `relation-v3` evidence;
- replay repairs a missing relationship projection;
- cardinality safety bounds remain unchanged;
- advisory locking prevents concurrent projection of one source;
- completion requires exact raw/observation equality and all stages complete;
- relationship reads prefer `relation-v3` over duplicate `relation-v2` edges;
- pause/resume/monitor scripts do not remove volumes and write `/tmp` logs.

The full lint, test, TypeScript build, and production-image migration checks must pass before publishing.

## Rollout

1. Stop the app and cancel the current source-wide relationship query while leaving PostgreSQL running.
2. Deploy the migration and resumable projector.
3. Start one recovery worker with conservative batch sizes.
4. Verify checkpoints advance and PostgreSQL temporary writes fall substantially.
5. Allow the worker to repair every registered source.
6. Verify per-source raw/observation equality and completed stages.
7. Start normal directory scanning.
8. Consider `relation-v2` supersession only after all verification succeeds.

## Acceptance Criteria

- Killing the projector during a batch loses at most that one batch.
- Restarting continues after the last committed cursor without rescanning completed relationship batches.
- Progress changes are visible at least once per committed batch.
- The current source-wide relationship SQL is no longer executed.
- Repeated recovery produces no duplicate `relation-v3` evidence.
- No pause, resume, migration, or recovery path deletes raw records or Docker volumes.
