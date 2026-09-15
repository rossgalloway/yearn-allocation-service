# Allocation-history database runbook

Public chart and detail requests always read prepared Postgres runs. Envio, RPC and optional Redis are used only by refresh.

## Setup

```bash
bun run db:up
DATABASE_URL=postgres://yearn:yearn@127.0.0.1:55434/yearn_allocation bun run db:migrate
```

Configure the same database URL for the API and CLI, plus Envio and the selected chains' archive RPCs.
For provisional exploratory history, set `ALLOCATION_ALLOW_UNCERTIFIED_MATERIALIZATION=true` explicitly.

```bash
bun run allocation:backfill --vault=yvUSDC-1
bun run allocation:refresh --vault=yvUSDC-1
```

Both modes use one pipeline. `--chain=1` and `--vault=<address-or-label>` narrow the configured cohort.
`ALLOCATION_MAX_MATERIALIZATION_EVENTS` is a failure ceiling, not a truncation or page limit.
`ALLOCATION_MATERIALIZATION_TO_BLOCK` optionally fixes an upper block at or below chain finality and indexed progress.

## Migration and activation

Migration 0006 adds `data_quality` to each run and removes required checkpoint-specific provenance for new runs.
It does not rewrite old rows. New responses require processing version `allocation-history-v2-event-reader`.
The older flat coverage columns remain storage metadata; structured quality is the response authority for new runs.

Run candidates and prepared entries are inserted and activated transactionally. Publication validates coverage bounds,
accounting, unique entry IDs, one safe-head snapshot, and interval reconciliation. The active reference changes only after
validation. A failed refresh retains the previous run. One writer runs per vault; a stale writer is marked failed before its
replacement starts, and the old writer cannot later publish.

Run-pinned pagination and details continue against their original runs. No pruning policy is implemented here.
The run timestamp and safe-block timestamp do not change when a later refresh fails.

## Persistent finalized evidence and incremental states

The cache checks chain identity and a finalized anchor before reuse. It retains successful finalized RPC calls, traces,
transactions and derived states keyed by canonical block and relevant evidence. Failed reads remain retryable.
New checkpoint-free states use namespace `state-v2`; older cached values are not silently reinterpreted.

Refresh rereads events to detect corrections and reassembles the public projection. It reuses unchanged historical RPC
and state work; it is not a bounded incremental event reader. A full rebuild is an acceptable reference baseline.
`ALLOCATION_FORCE_STATE_REBUILD=true` bypasses the derived-state cache for comparison while preserving RPC reuse.
Compare content at identical safe blocks and source evidence, excluding run IDs, generation times and run-specific links.

## Test and preview isolation

Run database tests only with `TEST_DATABASE_URL` equal to `DATABASE_URL` and pointing at a separate test database:

```bash
DATABASE_URL=postgres://yearn:yearn@127.0.0.1:55434/yearn_allocation_reference_test \
TEST_DATABASE_URL=postgres://yearn:yearn@127.0.0.1:55434/yearn_allocation_reference_test \
bun run test:db
```

The branch preview uses its own `allocation_reference` schema for migration tracking, projections, runs and entries.
Its search path is `allocation_reference,public`; the finalized evidence/cache tables are shared with the existing local
reference to avoid duplicating several gigabytes. Published runs and active references remain isolated. This is a local
preview arrangement, not a requirement of the API contract.

`NEXT_DIST_DIR=.next-reference` isolates its Next build output from an existing server in the same checkout.
Check `/api/health`, a chart page, its next cursor and a returned `detailsHref` before sharing the preview.

## Rollback

Stop the new serving/refresh process or restore a compatible retained run. Do not reinterpret an old run's quality under a
new processing revision. Do not delete prior runs or caches as part of rollout. Unavailable history returns 404; database
failures return 503. `/api/health` separates active serving readiness from the latest refresh attempt.
