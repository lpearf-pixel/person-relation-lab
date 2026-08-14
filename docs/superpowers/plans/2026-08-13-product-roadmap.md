# Person Relation Lab Product Roadmap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the field-quality, identity, evidence, review, UI, graph, incremental-processing, operations, and mining phases defined in the product roadmap as independently verifiable releases.

**Architecture:** PostgreSQL remains the authoritative layered store (`raw`, `core`, `evidence`, `projection`, `review`, `audit`). Each phase adds versioned, resumable projections and read APIs without mutating raw source observations; local Qwen tooling assists development only and never processes personal data.

**Tech Stack:** Node.js 24, TypeScript, Fastify, PostgreSQL 16, Vitest, ESLint, Docker Compose, optional Ollama with `qwen2.5-coder:7b-instruct`.

## Global Constraints

- Use macOS Bash 3.2-compatible shell scripts.
- Use synthetic test data only; never commit personal records, `.env`, imports, dumps, CSV/XLS/XLSX files, or database logs.
- Long-running database work must be idempotent, checkpointed, bounded by batch size, and safe to resume.
- Do not assert intimate relationships as facts; emit review candidates with evidence and uncertainty.
- Missing address values are neutral, and high-frequency values are down-weighted or excluded.
- Run `npm run verify` before every phase is proposed for merge.

---

### Task 1: Development rails and optional local coder

**Files:**
- Create: `AGENTS.md`
- Create: `src/tools/local-coder.ts`
- Create: `tests/local-coder.test.ts`
- Create: `scripts/local-coder-check.sh`
- Create: `scripts/local-coder-task.sh`
- Create: `docs/local-coder.md`
- Modify: `package.json`
- Modify: `tests/production-scripts.test.ts`

**Interfaces:**
- Produces: `validateContextPath(repoRoot: string, candidate: string): Promise<string>` and `buildMessages(task: string, contexts: ContextDocument[]): ChatMessage[]`.
- Produces: `npm run local-coder -- check` and `npm run local-coder -- run <task-file> [context-file ...]`.

- [x] Write tests that reject `.env`, `data/people.csv`, paths outside the repository, unsupported extensions, and oversized files.
- [x] Run `npm test -- tests/local-coder.test.ts` and confirm failure because `src/tools/local-coder.ts` does not exist.
- [x] Implement path validation, request construction, Ollama API calls, timeouts, response validation, and `/tmp` output.
- [x] Add Bash 3.2 wrappers with fixed log files and no evaluation of generated output.
- [x] Run `bash -n scripts/local-coder-check.sh scripts/local-coder-task.sh` and `npm run verify`.
- [x] Commit with `feat: add safe local coder workflow`.

### Task 2: P0 baseline closure

**Files:**
- Create: `scripts/verify-baseline.sh`
- Create: `tests/baseline-script.test.ts`
- Modify: `docs/progress.md`

**Interfaces:**
- Produces: `/tmp/person-relation-baseline-latest.log` with per-source raw/projected counts, incomplete checkpoints, active operations, and a nonzero exit code on mismatch.

- [x] Write a script contract test requiring read-only SQL and failure conditions for non-complete sources or count mismatches.
- [x] Run the focused test and confirm it fails because the script is missing.
- [x] Implement one read-only `psql` script with `ON_ERROR_STOP=1` and explicit validation.
- [x] Run shell syntax, focused tests, and `npm run verify`.
- [x] Execute it on the local database and record the verified baseline in `docs/progress.md` without personal data.
- [x] Commit with `ops: add projection baseline verification`.

### Task 3: P1 versioned field normalization and frequency profiles

**Files:**
- Create: `src/domain/address-normalizer.ts`
- Create: `src/domain/company-normalizer.ts`
- Create: `src/domain/value-quality.ts`
- Create: `tests/address-normalizer.test.ts`
- Create: `tests/company-normalizer.test.ts`
- Create: `migrations/004_normalized_value_quality.sql`
- Modify: `src/db/projection-builder.ts`

**Interfaces:**
- Produces: `normalizeAddress(value: string): NormalizedValue` and `normalizeCompany(value: string): NormalizedValue` where `NormalizedValue` contains `value`, `version`, and `flags`.
- Produces: indexed frequency rows keyed by `channel`, `normalized_hash`, and `normalizer_version`.

- [ ] Write synthetic tests for whitespace, Chinese administrative aliases, house/building/unit tokens, company suffixes, empty input, and over-broad values.
- [ ] Run focused tests and confirm missing-module failures.
- [ ] Implement pure normalizers and quality flags without fuzzy matching.
- [ ] Add migration tables/indexes and migration contract assertions.
- [ ] Add resumable frequency materialization in bounded batches.
- [ ] Run focused tests, PostgreSQL integration tests, and `npm run verify`.
- [ ] Benchmark frequency computation on synthetic data and record rows/second and temporary I/O.
- [ ] Commit with `feat: add versioned field quality profiles`.

### Task 4: P2 conservative entity resolution

**Files:**
- Create: `src/domain/entity-resolution.ts`
- Create: `src/db/entity-resolution-service.ts`
- Create: `tests/entity-resolution.test.ts`
- Create: `migrations/005_entity_resolution.sql`
- Modify: `src/app.ts`

**Interfaces:**
- Produces: `evaluateEntityCandidate(left: EntityFeatures, right: EntityFeatures): EntityDecision` with `match`, `review`, or `reject` and reason codes.
- Produces: reversible merge-candidate and review-decision storage; raw observations remain unchanged.

- [ ] Write synthetic tests proving exact valid identifiers match and name-only, address-only, company-only, conflicting identifier, and implausible birthday pairs do not auto-merge.
- [ ] Run tests and confirm missing behavior failures.
- [ ] Implement deterministic rules and explanation codes.
- [ ] Add migration constraints preventing irreversible observation reassignment.
- [ ] Add paginated candidate/read/decision endpoints.
- [ ] Run focused, API, PostgreSQL, and full verification.
- [ ] Measure precision on a labeled synthetic fixture and document every false positive.
- [ ] Commit with `feat: add reversible entity resolution review`.

### Task 5: P3 frequency-aware relationship evidence v4

**Files:**
- Create: `src/domain/relation-v4.ts`
- Create: `src/db/relation-v4-projector.ts`
- Create: `tests/relation-v4.test.ts`
- Create: `migrations/006_relation_v4.sql`
- Modify: `src/db/projection-builder.ts`

**Interfaces:**
- Produces: `scoreEvidenceV4(input: EvidenceFeatures): RelationScore` with per-channel contribution, conflicts, completeness, confidence, and explanation.
- Produces: resumable `relation-v4` evidence and projection rows that coexist with v3.

- [ ] Write tests for rare/shared mobile, precise/common address, small/large company, missing address, conflicting identity, and multiple independent channels.
- [ ] Confirm tests fail before implementation.
- [ ] Implement capped frequency-aware contributions and conflict penalties.
- [ ] Add versioned storage and independent checkpoints.
- [ ] Implement v3/v4 comparison queries and aggregate drift metrics.
- [ ] Run unit, integration, full verification, and an `EXPLAIN (ANALYZE, BUFFERS)` synthetic benchmark.
- [ ] Commit with `feat: add frequency-aware relation v4`.

### Task 6: P4 opposite-sex candidate evaluation

**Files:**
- Create: `src/domain/partner-candidate.ts`
- Create: `tests/partner-candidate.test.ts`
- Create: `scripts/evaluate-partner-candidates.sh`
- Modify: `scripts/query-direct-relations.sh`

**Interfaces:**
- Produces: `classifyPartnerCandidate(input: PartnerFeatures): ReviewPriority` returning `high`, `medium`, `low`, or `excluded` plus reason codes.
- Produces: an aggregate evaluation report containing confidence-band counts and labeled precision/recall, never raw identities.

- [ ] Write tests requiring two independent strong channels for `high` and excluding company-only, address-only, same-person, identity-conflict, and implausible-age cases.
- [ ] Confirm focused tests fail.
- [ ] Implement pure classification over v4 features.
- [ ] Add bounded query/report scripts with masked output.
- [ ] Run focused tests, shell syntax, full verification, and labeled-set evaluation.
- [ ] Record thresholds and false-positive categories in the specification.
- [ ] Commit with `feat: rank partner review candidates`.

### Task 7: P5 audited human review

**Files:**
- Create: `src/db/review-service.ts`
- Create: `tests/review-service.test.ts`
- Create: `migrations/007_review_decisions.sql`
- Modify: `src/app.ts`

**Interfaces:**
- Produces: append-only decisions `confirmed`, `rejected`, `uncertain`, `duplicate_person`, and `insufficient_data` with reviewer, reason, note, algorithm version, and evidence snapshot.

- [ ] Write tests for authorization boundary, append-only history, superseding decisions, stale algorithm versions, and pagination.
- [ ] Confirm tests fail before implementation.
- [ ] Add database constraints and indexes.
- [ ] Implement service and local-only API endpoints.
- [ ] Verify inferred relations remain distinct from confirmed decisions.
- [ ] Run API, PostgreSQL, audit, and full verification.
- [ ] Commit with `feat: add audited relationship review`.

### Task 8: P6 local review UI

**Files:**
- Create: `public/review.html`
- Create: `public/review.js`
- Create: `public/review.css`
- Create: `tests/review-ui.test.ts`
- Modify: `src/app.ts`

**Interfaces:**
- Consumes: paginated person, relation, evidence, health, and review endpoints.
- Produces: masked person search, direct-relation detail, evidence panel, review queue, and import-health views.

- [ ] Write API/DOM contract tests for masking, pagination, empty states, errors, and decision submission.
- [ ] Confirm missing-route or missing-asset failures.
- [ ] Implement accessible pages with bounded page sizes and no third-party assets.
- [ ] Add response headers preventing caching of sensitive pages.
- [ ] Run tests, full verification, and a local browser smoke test at `127.0.0.1`.
- [ ] Commit with `feat: add local relationship review UI`.

### Task 9: P7 bounded graph exploration

**Files:**
- Create: `src/db/path-service.ts`
- Create: `tests/path-service.test.ts`
- Create: `scripts/benchmark-path-query.sh`
- Modify: `src/app.ts`

**Interfaces:**
- Produces: `findPaths(startId, endId, options)` with max depth 3, minimum confidence, allowed channels, result limit, timeout, and cycle prevention.

- [ ] Write tests for depth limits, cycles, confidence/channel filters, duplicate paths, timeout, and result limits.
- [ ] Confirm tests fail.
- [ ] Implement parameterized PostgreSQL recursive queries.
- [ ] Add local-only paginated API output with masked profiles.
- [ ] Benchmark representative two- and three-hop queries and record p50/p95.
- [ ] Decide from measured budgets whether PostgreSQL remains sufficient; document the decision before adding any graph store.
- [ ] Run full verification and commit with `feat: add bounded relationship paths`.

### Task 10: P8 incremental recomputation

**Files:**
- Create: `src/db/impact-tracker.ts`
- Create: `src/db/incremental-projector.ts`
- Create: `tests/incremental-projector.test.ts`
- Create: `migrations/008_projection_impacts.sql`
- Modify: `src/ingest/pipeline.ts`

**Interfaces:**
- Produces: affected person/value queues keyed by source and algorithm version, claimed with `FOR UPDATE SKIP LOCKED` and committed in bounded batches.

- [ ] Write tests for new source impacts, duplicate enqueue, interruption, retry, concurrent workers, and algorithm-version isolation.
- [ ] Confirm focused failures.
- [ ] Add queue schema and indexes.
- [ ] Implement transactional claim/process/complete batches.
- [ ] Wire completed imports to enqueue only affected values and people.
- [ ] Prove with query counters that one new file does not scan every observation.
- [ ] Run integration, recovery, performance, and full verification.
- [ ] Commit with `perf: add incremental relationship recomputation`.

### Task 11: P9 diagnostics and tuning

**Files:**
- Create: `scripts/collect-diagnostics.sh`
- Create: `tests/diagnostics-script.test.ts`
- Create: `docs/operations.md`
- Modify: `docker-compose.yml`

**Interfaces:**
- Produces: one redacted `/tmp/person-relation-diagnostics-latest.log` containing container resources, source/checkpoint progress, active/blocked SQL, table/index sizes, WAL/checkpoint counters, temporary I/O, and recent audit error reasons.

- [ ] Write contract tests requiring read-only SQL, redaction, timeout, fixed output, and no destructive Docker commands.
- [ ] Confirm the focused test fails because the script is absent.
- [ ] Implement the diagnostics script and document interpretation thresholds.
- [ ] Benchmark batch sizes and indexes before changing PostgreSQL settings.
- [ ] Apply measured Compose tuning and document rollback values.
- [ ] Run shell syntax, tests, full verification, and a production-sized diagnostic capture.
- [ ] Commit with `ops: add measured database diagnostics`.

### Task 12: P10 opt-in mining modules

**Files:**
- Create: `src/analysis/household-clusters.ts`
- Create: `src/analysis/contact-anomalies.ts`
- Create: `src/analysis/organization-networks.ts`
- Create: `tests/mining.test.ts`
- Modify: `src/app.ts`

**Interfaces:**
- Produces: bounded aggregate analyses with provenance, confidence, limitation codes, minimum group sizes, and masked drill-down.

- [ ] Write synthetic tests for common households, contact reuse, organization communities, missing data, and high-frequency suppression.
- [ ] Confirm tests fail before implementation.
- [ ] Implement one opt-in module at a time, starting with household clusters.
- [ ] Add aggregate-only endpoints and explicit drill-down limits.
- [ ] Create a validation set and document usefulness, false positives, and privacy impact for each module.
- [ ] Run focused, API, performance, privacy, and full verification.
- [ ] Commit each independently useful module separately.

## Release order and gates

Complete tasks in order. Tasks 3–6 change analytical meaning and require side-by-side version comparison before activation. Tasks 7–9 consume those versioned outputs and must not silently select a new algorithm. Task 10 is enabled only after correctness equivalence against a full recomputation. Task 12 remains opt-in until its validation report is accepted.
