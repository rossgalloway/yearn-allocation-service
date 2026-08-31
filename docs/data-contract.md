# Allocation data contract

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
