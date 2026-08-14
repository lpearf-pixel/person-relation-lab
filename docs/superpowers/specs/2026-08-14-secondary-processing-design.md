# Person Relation Lab Secondary Processing Design

## Status

Approved direction on 2026-08-14. This specification turns the verified 20,051,414-row import baseline into a versioned, resumable secondary-processing system. It does not alter raw records, delete existing people, or present inferred intimate relationships as facts.

## Objectives

1. Produce typed, versioned normalized observations from the immutable raw layer.
2. Measure the population frequency and quality of phones, addresses, and organizations before using them as relationship evidence.
3. Separate authoritative identity resolution from probabilistic merge candidates.
4. Materialize bounded pair features so relationship scoring never requires a source-wide observation self-join.
5. Keep PostgreSQL authoritative while allowing rebuildable Parquet/DuckDB analysis and an optional graph projection.
6. Preserve provenance, privacy, auditability, and stop/resume behavior at every stage.

## Non-goals

- Do not rewrite or remove `raw.record`.
- Do not destructively split or merge existing `core.person` rows in the first phase.
- Do not load all raw records into a graph database.
- Do not use a local language model to process personal records or decide relationships.
- Do not claim that `possible_partner_association` proves a romantic or intimate relationship.
- Do not introduce machine-learned relationship scoring before a reviewed labeled evaluation set exists.

## Architecture

PostgreSQL remains the source of truth. Secondary processing adds immutable/versioned analytical layers rather than changing the meaning of existing `relation-v3` rows in place.

```text
raw.record
    -> analytics.normalized_observation
    -> analytics.value_profile
    -> identity.merge_candidate / identity.conflict
    -> analytics.relationship_pair_feature
    -> projection.relationship (new algorithm version)
    -> review.decision / audit.event

analytics snapshots
    -> Parquet
    -> DuckDB reports and threshold experiments

accepted relationship projection
    -> optional graph database
```

The current `relation-v3` projection remains available as a historical baseline. The first secondary versions are named `normalizer-v1`, `pair-feature-v1`, and `relation-v4`. New scoring must be compared side by side before activation and must never update a `relation-v3` row.

## Data model

### Versioned normalized observations

Create schema `analytics` and table `analytics.normalized_observation`:

- `raw_record_id bigint`
- `person_id uuid`
- `normalizer_version text`
- `name_hash char(64)`
- `mobile_hash char(64)`
- `email_hash char(64)`
- `address_hash char(64)`
- `address_region_hash char(64)`
- `address_detail_level smallint`
- `organization_hash char(64)`
- `department_hash char(64)`
- `quality_flags text[]`
- `processed_at timestamptz`

The primary key is `(raw_record_id, normalizer_version)`. Normalized cleartext is not duplicated into this table. Operator-facing detail continues to be retrieved from the authorized raw record and masked at the output boundary.

Normalizers return a value, a version, a granularity/classification, and flags. Missing values remain null and carry a neutral missing flag; they never become empty-string hashes.

### Population value profiles

Create `analytics.value_profile` keyed by `(channel, normalized_hash, normalizer_version)` with:

- observation count
- distinct person count
- distinct source count
- first and last source/version timestamps when available
- classification: `private`, `shared_household`, `organization`, `public`, or `noisy`
- quality flags

Frequency classification is deterministic and configurable. Phase 1 measures distributions without declaring permanent thresholds. Before Phase 3, the accepted channel thresholds and hard expansion caps are stored with the algorithm configuration and covered by tests. A value above its hard cap is excluded or down-weighted, not expanded into an unbounded person-pair join; no unrecorded runtime default may change this behavior.

### Identity resolution

Create schema `identity` with append-only decision support tables:

- `identity.merge_candidate`
- `identity.conflict`
- `identity.entity_membership`
- `identity.decision`

Identity rules are:

1. A valid normalized government identifier is authoritative for automatic grouping.
2. Different valid identifiers are a hard conflict and prohibit automatic merge.
3. Name, birthday, private mobile, and email combinations create scored merge candidates only.
4. Name-only, address-only, phone-only, or organization-only matches never merge people.
5. Existing legacy `composite:` people are not silently rewritten. They receive a legacy provenance flag and are evaluated through the same candidate/conflict process.
6. Every accepted merge is reversible through versioned membership rows; observations are never reassigned destructively.

Future identifiers are keyed by normalized certificate type, nation/issuer, and certificate value. New protected identifier tokens use keyed HMAC rather than unsalted hashes. The secret is runtime-only and is never committed, logged, or sent to Ollama. Migration from the existing hash is a separately approved, resumable job because it changes identity tokens.

### Pair features

Create `analytics.relationship_pair_feature` keyed by canonical person pair and `feature_version`. It stores bounded aggregate features rather than raw values:

- shared rare private contact count
- shared exact-address and address-region counts
- shared organization and department counts
- independent evidence channel count
- distinct source count
- first/last co-observation bounds when meaningful
- population frequencies for the supporting values
- gender pair and age difference as explanatory attributes, never primary proof
- identity and data-quality conflict flags
- positive, negative, and limitation codes

Candidate generation starts from eligible normalized values. It refuses to expand values whose distinct-person frequency exceeds the configured bound. Repeated copies of one source observation do not add independent-channel weight.

## Relationship scoring

The first secondary relationship version remains rules-first and explainable.

- Rare private contact plus detailed residential address may produce a high-priority household or possible-partner review candidate.
- Organization evidence can corroborate another private channel but cannot independently create a partner candidate.
- Missing address is neutral.
- Public or high-frequency phones, addresses, and organizations contribute no positive partner evidence.
- Opposite recorded gender may be a query filter, but it is not evidence that a relationship exists.
- Age difference is descriptive and may produce a limitation flag; it does not establish or disprove intimacy.
- A result includes confidence, completeness, feature version, algorithm version, evidence summary, limitation codes, and review status.

No inferred candidate becomes `confirmed` without an explicit `review.decision`.

## Processing and recovery

Migration `005_secondary_processing_foundation.sql` adds a generic versioned processing checkpoint rather than extending the fixed `people/mobile/address/company` checkpoint contract. A checkpoint is keyed by pipeline name, pipeline version, source file, and stage. It records the last committed raw record ID, processed count, state, timestamps, and last safe error.

Each worker:

1. takes a pipeline/source advisory lock;
2. reads a bounded keyset page ordered by `raw_record_id`;
3. writes derived rows and advances the checkpoint in one transaction;
4. commits before reading the next page;
5. can be stopped between committed batches and resumed without replay side effects.

Frequency aggregation and pair materialization run after normalized-observation coverage is verified. They use bounded hash buckets or key ranges and their own checkpoints. No phase executes a single transaction over an entire source.

## Storage strategy

Existing raw and projection tables are not repartitioned during the first secondary-processing release. New high-volume tables may use hash partitioning only after a representative `EXPLAIN (ANALYZE, BUFFERS)` benchmark demonstrates a benefit for actual query patterns.

PostgreSQL stores authoritative data and decisions. Parquet snapshots contain only explicitly selected, masked or hashed analytical columns and include the producing version and timestamp. DuckDB consumes those snapshots for population reports and offline threshold experiments. Neither Parquet nor DuckDB becomes an authoritative write path.

An optional graph projection contains only accepted derived nodes and edges:

- nodes: person, phone token, address token, organization token;
- edges: uses contact, observed at address, works at organization, and versioned relationship candidate;
- no raw record payloads or clear identifiers.

The graph is rebuildable from PostgreSQL and is introduced only after bounded two/three-hop PostgreSQL benchmarks establish a real need.

## Privacy and access

- Raw identifiers and contact values remain local and are not committed or included in test fixtures.
- API, CSV, and report outputs mask identity and contact fields by default.
- HMAC and encryption secrets are centrally configured as runtime secrets.
- Operational logs contain IDs, counts, stages, durations, and error codes, not record payloads.
- Synthetic fixtures are used for all automated tests and local-coder prompts.

## Delivery phases

### Phase 1: field quality foundation

- Implement versioned address and organization normalizers.
- Add normalized observations, value profiles, and resumable checkpoints.
- Produce aggregate coverage/frequency reports without raw identities.
- Keep current identity membership and `relation-v3` unchanged.

### Phase 2: identity candidates and conflicts

- Add certificate-type-aware identifier normalization.
- Audit legacy composite identities.
- Generate reversible merge candidates and hard conflicts.
- Require reviewed decisions before entity membership changes.

### Phase 3: pair features and relationship v4

- Materialize bounded pair features from eligible values.
- Add explainable frequency-aware scoring.
- Compare `relation-v3` and the new version by confidence band and false-positive reason.
- Activate the new version only after evaluation acceptance.

### Phase 4: analytical and graph projections

- Export masked/versioned Parquet snapshots.
- Add DuckDB aggregate reports.
- Benchmark PostgreSQL path queries.
- Add a graph projection only if the benchmarked use cases justify it.

## Verification and acceptance

Every phase must pass unit, migration-contract, idempotency, interruption/resume, privacy, and full repository verification tests.

Phase 1 acceptance requires:

- normalized coverage equals the selected raw-record coverage;
- rerunning the same version produces no duplicate derived rows;
- missing address remains null and neutral;
- public/high-frequency values are classified without pair expansion;
- checkpoints resume after an injected interruption;
- reports contain aggregates only;
- `npm run verify` passes.

Production-scale execution first runs in report-only mode. It must provide batch duration, rows per second, table growth, WAL growth, temporary I/O, and estimated completion time before relationship v4 processing is enabled.

## Rollback

Rollback stops the secondary workers and deactivates the new algorithm version. Because raw data, existing people, and `relation-v3` are not mutated, derived rows for an unaccepted version can remain for diagnosis or be removed later through a separately approved version-scoped cleanup. No rollback command deletes Docker volumes or raw records.
