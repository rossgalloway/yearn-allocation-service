# Allocation data contract

This service currently has two REST read models:

- `/api/allocations` preserves the earlier executed-versus-optimizer overlay contract described below.
- `/api/rest/views/allocation-history/:chainId/:address` is the Kong allocation-history prototype. Its version 2 public
  response is a chart-ready `entries` collection rather than a normalized state/event graph.

## Allocation-history REST projection

Each public history entry embeds everything needed for website hydration:

- its logical action kind and whole-group block/timestamp range;
- complete archive-RPC `before` and `after` allocation snapshots;
- strategy metadata and calculated debt/ratio changes;
- an inline DOA policy summary when exact configuration events or historical target equality support it;
- compact transaction steps with originator, traced call path, immediate vault caller, historical `DEBT_MANAGER` evidence,
  and allocator-trigger replay; and
- classification confidence, supporting evidence, and explicit limitations.

The route does not expose top-level states, transitions, strategy directories, raw Envio events, or unapplied proposal rows.
Those remain normalized internally so Kong can eventually expose investigative GraphQL queries without forcing the public REST
consumer to join objects or make follow-up requests.

Standalone deposit/withdrawal context, report-only accounting changes, and pure debt updates that only service withdrawals are
excluded from the default REST entries. Withdrawal context never overrides stronger intent evidence: allocator execution,
historically confirmed `DEBT_MANAGER` calls, bad-debt handling, and configuration/lifecycle actions remain visible and retain
their inline `vaultActivities`. A `current_snapshot` entry supplies the safe-block allocation without claiming that all drift
since the previous action was one execution.

The prototype computes entries on demand and caches them for 15 minutes. Kong should materialize immutable completed entries
ahead of requests and serve them through CDN caching; raw GraphQL investigation may remain slower.

For this prototype, `limit` is applied after REST filtering and multi-step grouping. Each request scans at most the latest 100
raw transition blocks; `pagination.hasMore` remains true when older raw history or additional qualifying entries exist. Kong's
materialized implementation should paginate completed public entries directly rather than repeat this bounded scan behavior.

## Inputs

The service combines two authorities without conflating them.

The issue #52 Allocation History contract from `yearn-envio` supplies executed state:

- `AllocationSourceEvent`
- `VaultAccountingCheckpoint`
- `VaultAccountingCheckpointFailure`
- `VaultAllocationCoverage`

DOA Redis keys under `doa:optimizations:<chainId>:<revision>` supply optimizer intent:

- included strategies and their current/target ratios;
- current and proposed APR estimates;
- explanation text; and
- the immutable source revision or matched timestamp behind the `latest` alias.

The response keeps these surfaces under separate `executed` and `optimizer` envelopes.

## Indexed state processing

For every vault, the service starts at `coverageStartBlock`, orders events by block number, transaction index, log index, and event ID, then applies them before producing each block-end accounting checkpoint state.

State-changing events currently handled:

| Event | Indexed effect |
| --- | --- |
| `DebtUpdated` | Sets the strategy's current debt to `newDebt`. |
| `StrategyReported` | Sets the strategy's current debt to `currentDebt`. |
| `StrategyChanged` | Applies the VaultV3 enum: `0` activates and `1` revokes/reset the strategy. |
| `UpdatedMaxDebtForStrategy` | Updates the strategy's absolute max debt. |
| `UpdateStrategyDebtRatio(s)` | Updates allocator target ratio metadata. |
| `DebtPurchased` | Context only. VaultV3 emits the exact `DebtUpdated` transition immediately before it, so it is not applied twice. |

Every rendered ratio uses the same-block checkpoint `totalAssets` denominator. Indexed idle capital uses checkpoint `totalIdle` directly. The service does not normalize strategy ratios to force a 10,000-bps sum.

## Completeness

A response is complete only when all of the following hold:

1. The selected immutable coverage row has `safeForTimeline: true`.
2. No unresolved checkpoint failure exists inside the published range.
3. At least one checkpoint state was produced.
4. Every returned checkpoint has a verified canonical block, a valid accounting identity, valid decimal totals, and valid normalized event payloads.
5. Replayed per-strategy current debt sums exactly to the checkpoint's indexed `totalDebt`.
6. The request stays inside the configured replay-event limit.

Draft coverage may be exposed only through the explicit service-level research switch. It always remains provisional and uncached.

## DOA enrichment

DOA `currentResidualBps` and `targetResidualBps` mean only that the optimizer payload omitted part of the 10,000-bps
vault composition. They do not establish idle capital or why a strategy was omitted.

For each timestamped DOA record, the service selects the last certified indexed state at or before that timestamp.
That state owns `allocationSnapshot.currentBps` and `allocationSnapshot.unallocatedBps`. DOA continues to own
`targetBps`, APRs, and explanation text. Strategies absent from DOA have `optimizerScope: "unknown"` and a null target.

When a certified indexed state is unavailable, the raw DOA record is still returned, but `allocationSnapshot.complete`
is false, the snapshot strategy list is empty, and unallocated values remain null.

## Pagination

`/api/allocations` returns chronological states. The first page contains the newest `limit` states while retaining ascending order. If `pagination.hasMore` is true, pass `pagination.nextBeforeBlock` back as `beforeBlock` to request the prior page.

The processor always replays from the coverage start, even for older pages, so page boundaries cannot silently reset strategy state.
