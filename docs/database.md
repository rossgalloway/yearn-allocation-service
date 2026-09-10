# Allocation-history database runbook

The public allocation-history REST route can serve a precomputed Postgres read model. PostgreSQL 16 is covered by the local
integration test. Runtime requests never call Envio, archive RPC, or the DOA store when
`ALLOCATION_HISTORY_SOURCE=database`.

## Prerequisites

- `ENVIO_ALLOCATION_GRAPHQL_URL` must expose `AllocationSourceEvent`. Certified mode also requires
  `VaultAccountingCheckpoint`, `VaultAccountingCheckpointFailure`, and `VaultAllocationCoverage`.
- In certified mode, each selected vault must have an immutable coverage row with `safeForTimeline: true`, every coverage gate
  true, no known gaps, and no unresolved checkpoint failure in the published range. Test-only provisional mode records these
  omissions instead of blocking activation.
- `RPC_URL_1` must support archive reads and `trace_transaction`.
- `DATABASE_URL` should be a provider-pooled Postgres connection URL. Migrations use a transaction-scoped advisory lock, so
  they are safe with transaction-mode poolers.
- DOA Redis is optional for executed history. When it is unavailable, entries remain executable-history complete and disclose
  the missing proposal enrichment in `classification.limitations`.

The Envio URL currently configured in a developer environment may still point to the legacy event-only deployment. Certified
mode fails closed in that case. For local shape testing only, set
`ALLOCATION_ALLOW_UNCERTIFIED_MATERIALIZATION=true`. The materializer will use Envio events plus archive-RPC snapshots,
activate the run as `provisional`, and record the missing coverage/checkpoint evidence under `dataQuality.limitations` and each
entry's `classification.limitations`. It never synthesizes checkpoint values: `unallocatedBps`, `unallocatedSource`, and
`unallocatedCheckpointId` remain null when exact same-block checkpoint evidence is unavailable.

## Local Postgres

Start the repository's persistent PostgreSQL 16 container and apply migrations:

```bash
bun run db:up
DATABASE_URL=postgres://yearn:yearn@127.0.0.1:55434/yearn_allocation bun run db:migrate
```

The named Docker volume survives `bun run db:down`. Use an explicit provider URL outside local development.

## Schema and activation

`allocation_history_projection` identifies one chain/vault read model. A background job builds a complete
`allocation_history_run` and its denormalized `allocation_history_entry` rows in isolation. Every chartable row stores both its
full evidence payload and its compact `chart_payload`; pure configuration/lifecycle rows keep only the full payload. Completion
validates the coverage contract, accounting checks, vault identity, block bounds, unique entry IDs, and exactly one safe-head
`current_snapshot` with its compact chart state. Chart payloads also contain interval ledgers constructed from the complete
Envio event stream before standalone deposits, withdrawals, and reports are removed from the public entry timeline. Activation
verifies every interval's node residuals and unattributed-flow total before switching the active run.
Only then does the same transaction mark the run successful and change the projection's active pointer. In explicit test mode,
the same validation and atomic activation apply, but the run may be provisional when its non-empty limitations explain the
missing certification evidence.

A failed refresh leaves the prior active run untouched. Cursors contain the database projection ID, run ID, response projection,
direction, and last keyset position, so an in-progress traversal continues against the older immutable run after a new run
activates. Chart detail links also include the run ID for the same reason.

## Initial rollout

Keep traffic on the live source while preparing Postgres:

```bash
ALLOCATION_HISTORY_SOURCE=live bun run db:migrate
ALLOCATION_HISTORY_SOURCE=live bun run allocation:backfill
```

Use `--vault=yvUSDC-1`, `--vault=yvUSDT-1`, `--vault=yvUSD`, or a vault address to run one vault. Without `--vault`, the job
attempts all three and continues after a per-vault failure.

Verify `/api/health` reports an active run with a positive entry count for all three vaults. Certified mode requires certified
runs. Explicit test mode also accepts provisional runs and reports `allowUncertifiedMaterializations: true`. Only then set:

```text
ALLOCATION_HISTORY_SOURCE=database
```

This explicit cutover prevents an empty `DATABASE_URL` deployment from taking traffic merely because Postgres was provisioned.

To populate one local test vault when the Envio deployment is event-only:

```bash
DATABASE_URL=postgres://yearn:yearn@127.0.0.1:55434/yearn_allocation \
ALLOCATION_ALLOW_UNCERTIFIED_MATERIALIZATION=true \
bun run allocation:backfill --vault=yvUSDC-1
```

The archive provider must support historical `eth_call` and `trace_transaction` across the vault's full indexed history.

## Refresh behavior

```bash
bun run allocation:refresh
```

For this test service, `refresh` is a full replay from the selected coverage boundary into a new immutable run. It is deliberately
correct before it is incremental: no partial run is visible, and a failed run cannot replace the last good one. A running job
blocks another job for the same vault. Runs older than `ALLOCATION_STALE_RUN_SECONDS` (six hours by default) are treated as
interrupted and replaced on the next attempt.

`ALLOCATION_MAX_MATERIALIZATION_EVENTS` is a safety ceiling, not a page size. Exceeding it fails the job; it never activates a
truncated history. The default is 250,000 events. Public REST pages remain limited to 100 entries and traverse larger histories
with `nextCursor`.

The prototype retains prior successful runs because issued cursors and chart detail links refer to them. Production Kong still
needs an incremental tail algorithm and a retention window tied to cursor/detail-link expiry before old runs can be deleted
safely.

## Verification

Run the normal checks plus the real-Postgres suite against an isolated test database:

```bash
bun run test
bun run lint
bunx tsc --noEmit
bun run build
DATABASE_URL=postgres://... TEST_DATABASE_URL=postgres://... bun run test:db
```

The integration suite applies migrations, exercises atomic activation, verifies cursor stability across a refresh, confirms a
failed refresh preserves the last good run, rejects concurrent jobs, and recovers an interrupted stale run. It only runs when
`DATABASE_URL` and `TEST_DATABASE_URL` are the same explicit URL.

## Multicall3 reads

The reference materializer opts compatible vault accounting and supported allocator-configuration getters into
Multicall3 `aggregate3`, grouped by chain and exact historical block, with at most 50 subcalls per aggregate.
Vault/token metadata and contract names use the same path. Trigger replays remain direct because wrapping a call changes
`msg.sender`; arbitrary callers of `readContractCalls` remain direct unless explicitly opted in. Transaction traces,
transaction lookups, block reads, and bytecode reads remain JSON-RPC methods.

On Ethereum, Base, and Katana, each eligible block group first checks for Multicall3 bytecode at that historical block.
Blocks before deployment and singleton groups use direct reads. Unsupported chains use direct reads. Deployment-check
failures and malformed/failed outer aggregates fail explicitly without automatically multiplying requests through direct
fallback. Each reverted subcall produces null; successful zero and empty return data remain distinct.

A bounded live comparison on 2026-09-10 read six getters at two historical blocks per chain. All results matched direct
reads: 12 `eth_call` methods became two aggregate `eth_call` methods plus two `eth_getCode` checks on each chain.
See `docs/coverage-review/multicall-validation.json`. These are RPC method counts, not measured provider charges.
JSON-RPC transport batching still limits each HTTP batch to 100 methods.

This change does not introduce a persistent historical RPC cache or incremental materialization. Avoid frequent full
refreshes until recurring workload and provider billing units have been measured. Public database-backed requests continue
to make no RPC calls. No rematerialization is required solely for this transport change; the next scheduled/manual run uses it.
