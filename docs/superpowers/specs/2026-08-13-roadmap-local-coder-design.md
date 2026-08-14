# Product Roadmap and Local Coder Design

## Objective

Turn the completed ten-million-row import foundation into a maintainable local relationship-analysis product, while using the local `qwen2.5-coder:7b-instruct` model for bounded development assistance without exposing personal data or allowing generated code to bypass deterministic checks.

## Product principles

1. Relationship labels are evidence-backed hypotheses. The system may emit `possible_partner_association`, but never assert “lover” or “partner” as fact without an explicit human decision.
2. Missing addresses are neutral. Absence is not negative evidence and must not suppress evidence from independent channels.
3. Shared public contacts, large employers, dormitories, schools, hospitals, and other high-frequency values must be down-weighted or excluded.
4. Entity identity, raw observations, evidence, projected relationships, and human decisions remain separate layers.
5. PostgreSQL remains the source of truth. A graph engine is optional only after path-query demand and benchmarks justify it.
6. All long-running work is resumable, idempotent, observable, and safe to stop between committed batches.

## Delivery phases

### P0 — Baseline closure

- Record the verified 20,051,414 / 20,051,414 source-to-projection baseline across 11 completed sources.
- Preserve pause, resume, recovery, monitoring, and direct-query scripts.
- Add repeatable smoke checks for source completeness and stale checkpoints.

Exit: every registered source is complete, projection counts match raw counts, and `npm run verify` passes.

### P1 — Field quality

- Normalize address whitespace, administrative aliases, house/building/unit tokens, mobile formats, and company suffixes.
- Store normalized value, parser version, quality flags, and original observation reference.
- Build frequency profiles so common addresses, phones, and companies cannot create relationship explosions.

Exit: synthetic quality fixtures pass, field coverage/frequency reports are available, and normalization is versioned.

### P2 — Entity resolution

- Define deterministic exact-identifier matching and conservative multi-field matching when identifiers are absent.
- Add merge candidates, merge evidence, conflict reasons, and reversible human decisions.
- Prohibit automatic merge on name-only, address-only, or company-only matches.

Exit: benchmark fixtures meet agreed precision thresholds and every merge can be traced and reversed.

### P3 — Relationship evidence v4

- Replace fixed weights with frequency-aware evidence contributions and explicit negative/conflict evidence.
- Separate household, contact, organization, geographic, and temporal channels.
- Version scoring inputs and explanations so old results remain auditable.

Exit: relation-v4 is reproducible, resumable, benchmarked, and can run beside v3 for comparison.

### P4 — Opposite-sex relationship candidates

- Rank opposite-sex direct candidates using independent evidence, address precision, contact rarity, temporal overlap, age plausibility, and identity consistency.
- Classify review priority, not relationship truth.
- Require at least two independent strong channels before a high-priority partner candidate; company-only and address-only remain weak.

Exit: an evaluation set reports precision/recall by confidence band and false-positive reasons.

### P5 — Human review

- Provide confirm, reject, uncertain, duplicate-person, and insufficient-data decisions.
- Record reviewer, timestamp, reason code, note, algorithm version, and evidence snapshot.
- Keep inferred output separate from confirmed facts.

Exit: decisions are immutable/audited, reversible through a new decision, and reflected in queries.

### P6 — Local Web UI

- Add person search, masked profile, direct relations, evidence detail, review queue, and import health pages.
- Keep the service bound to `127.0.0.1`; mask identity and mobile values by default.
- Paginate every large list and forbid unbounded graph expansion.

Exit: browser smoke tests cover the main flows and no endpoint returns unmasked sensitive fields by default.

### P7 — Graph exploration

- Add PostgreSQL recursive path queries for two- and three-hop exploration with channel/confidence filters.
- Benchmark real query shapes before considering Neo4j or another graph projection.
- If a graph store is added, treat it as rebuildable read projection, never the source of truth.

Exit: bounded path queries meet the latency budget or an evidence-backed graph-store decision is recorded.

### P8 — Incremental recomputation

- Track affected normalized values and persons for each newly imported source.
- Recompute only impacted evidence pairs and relationship projections.
- Add algorithm-version migration jobs with independent checkpoints.

Exit: adding one file does not rescan all observations, and interruption resumes from committed checkpoints.

### P9 — Performance and operations

- Add database size, table growth, WAL/checkpoint, temporary I/O, slow query, and batch-throughput reports.
- Tune indexes, work memory, checkpoint settings, autovacuum, and batch sizes from measured workloads.
- Add export/restore verification only when backup work is resumed.

Exit: standard operational scripts diagnose stalls from one log bundle and performance budgets are documented.

### P10 — Additional mining

- Household clusters, organization networks, contact reuse anomalies, geographic movement, data-quality anomalies, and temporal changes.
- Every output includes provenance, confidence, limitations, and privacy controls.

Exit: each mining feature has a stated use case, validation set, false-positive analysis, and opt-in query/report.

## Local model integration

The local model is a development assistant. It is not used for identity matching, relationship scoring, or processing personal records.

The command-line tool has two commands:

- `check`: call Ollama tags and a minimal deterministic prompt; write a diagnostic log.
- `run <task-file> [context-file ...]`: validate every path, read only allowed text/source files within the repository, call Ollama chat, and write the response to `/tmp/person-relation-local-coder-latest.md`.

Allowed context extensions are source and documentation formats such as `.ts`, `.js`, `.json`, `.md`, `.sql`, `.sh`, `.yml`, and `.yaml`. Denied names and paths include `.env`, `data`, imports, dumps, logs, spreadsheets, and delimited data. Each file and the total request have conservative size limits. The tool never writes application files, applies patches, runs generated shell, connects to PostgreSQL, or uploads content.

Ollama URL and model are configurable with `OLLAMA_URL` and `LOCAL_CODER_MODEL`; defaults target `http://127.0.0.1:11434` and `qwen2.5-coder:7b-instruct`. Failure is isolated from the application runtime.
