# Projection Consistency Repair Design

## Problem

`PgProjectionBuilder.materializeCandidates()` upserts people in a data-modifying CTE, but the observation insert joins `core.person` instead of the CTE's `RETURNING` rows. PostgreSQL statements use one snapshot, so people first created by that statement are not visible to the later table scan. Their `core.person_observation` rows are silently omitted.

`projectSource()` also reports the number of raw candidates read rather than the number of observations actually present. This allowed a recovery to report success while only 37,023 of 2,000,052 source records had observations.

## Chosen Approach

Keep the existing single-statement batch upsert, but make `observations` join `inserted_people` by `identity_key`. `INSERT ... ON CONFLICT DO UPDATE RETURNING` provides both newly inserted and existing person IDs, so every input row can be observed in the same statement without an additional round trip.

After all candidate batches and relationship materialization complete, query the actual number of `core.person_observation` rows belonging to the source. Return that verified database count as `projectedRecords`.

## Safety and Compatibility

- Existing writes remain idempotent through current conflict constraints.
- No raw records, people, observations, evidence, or relationships are deleted.
- Re-running a partially projected source fills missing observations.
- A source is marked complete only after the database count equals its raw-record count.
- Relationship evidence generation remains unchanged in this repair.

## Verification

- A regression test must assert that observation SQL consumes `inserted_people` rather than scanning `core.person`.
- A regression test must prove the returned count comes from the final database verification query, not the number of raw rows read.
- The complete lint, unit-test, and TypeScript build gate must pass.

