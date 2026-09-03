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
- structured lifecycle and configuration operations, including their event provenance and before/after values;
- an inline DOA policy summary when exact configuration events or historical target equality support it;
- compact transaction steps with originator, traced call path, immediate vault caller, historical `DEBT_MANAGER` evidence,
  and allocator-trigger replay; and
- classification confidence, supporting evidence, and explicit limitations.

The response keeps four independent concepts separate:

- `kind` describes the whole grouped economic flow: `idle_deployment`, `strategy_reallocation`, `idle_deallocation`,
  or a pure non-debt policy/lifecycle/configuration action;
- `execution.automation` says whether the executed amount was `automatic`, `manual`, `mixed`, or `unknown`, while
  `execution.mechanism` identifies its allocator, direct role, governance, Safe, or role-manager call path and
  `execution.targetStatus` records allocator-target matching independently;
- `operations` lists exact strategy lifecycle and configuration changes without replacing a compound action's economic-flow
  kind; and
- `policy` contains a matched DOA proposal/configuration or null when policy provenance is unavailable.

Flow classification compares every strategy's archive-RPC debt in the group's immediate `before` and final `after` snapshots.
One or more increases with no decrease is idle deployment; decreases with no increase is idle deallocation; both directions in
one state-continuous group is strategy reallocation. It does not require the deposit, withdrawal, and keeper execution to share
one transaction.

The route does not expose top-level states, transitions, strategy directories, raw Envio events, or unapplied proposal rows.
Those remain normalized internally so Kong can eventually expose investigative GraphQL queries without forcing the public REST
consumer to join objects or make follow-up requests.

### Compact chart projection

`projection=chart` is a materialized subset of the full entry contract. It filters to visible `strategy_reallocation` entries
before keyset pagination. Hidden deposits, withdrawals, reports, idle deployments, and idle deallocations remain part of the
flow ledger between those visible points. The initial page returns the safe-head `currentSnapshot` separately, outside
`entries` and `limit`; cursor pages return `currentSnapshot: null`.

Each chart entry retains its after state in raw units, the three execution axes, proposal-scoped expected APR, and a run-pinned
detail link. Atomic before states, start metadata, transaction lists, operations, and classification evidence remain in the
detail projection. Derived `idleBps` and `currentDebtBps` are omitted so consumers calculate percentages from one exact set of
`totalAssets`, `totalIdle`, and `currentDebt` values. Strategy names are deduplicated into a response-level address dictionary.

`expectedAprImpact` is either an explicit unavailable reason or a DOA proposal-scoped estimate. Available values rename the
already-bps optimizer fields to `baselineAprBps` and `proposedAprBps`, with a signed `deltaAprBps`. `applied_in_entry` requires a
confirmed application block inside the entry; otherwise an attached policy is `governing_policy`. Historical target inference
remains visible through `applicationStatus`, not as a temporal relationship.

Chart `detailsHref` values include the immutable run ID. The detail route returns the full stored entry from that run, so a
later refresh cannot change the evidence behind an already-rendered chart point.

#### Interval flow ledger

The chart payload materializes an `interval` on every strategy reallocation except the oldest one. Its boundaries are the
previous visible entry's `after` state and the current entry's `after` state, identified by `fromEntryId` and `toEntryId`. The
states are not repeated inside the interval. `boundaryStates` supplies a referenced entry state that is outside the current
cursor page. The current snapshot may carry the final interval from the latest entry to the safe head; that interval uses
`toEntryId: null` and `endKind: "safe_head"`.

All flow amounts are decimal strings in raw underlying asset units. `Deposit` and `Withdraw` supply literal external flows.
`StrategyReported` gains and losses use an `accounting` source/sink because they change book value without implying an ERC-20
transfer from an external wallet; report refunds are literal external-to-idle transfers. Fee amounts remain report metadata
because Vault V3 issues fee shares rather than moving underlying out of the allocation state. `DebtUpdated` supplies derived
book-debt movements. Decreases and increases inside one execution group may be collapsed across idle into a deterministic
strategy-to-strategy flow.

The checked conservation equation applies independently to every relevant balance-bearing node (`idle` and each strategy with
a nonzero boundary balance or interval flow):

```text
opening balance
+ attributed inflows
- attributed outflows
+ unattributed inflows
- unattributed outflows
= closing balance
```

`external` and `accounting` are boundary source/sink nodes; the API does not claim to know their balances. `balanceStatus` is
`reconciled` only when every per-node final residual is zero. Any remaining evidence gap becomes an explicit
`unattributed_asset_change` against the accounting boundary, which keeps the balance equation exact but sets
`attributionStatus: "partial"`. `unattributedAmount` is the sum of those unattributed flow amounts. The materializer validates
and retains the complete equations, while the lean chart response omits successful residual rows and detailed total fields.

Standalone deposit/withdrawal context, report-only accounting changes, and pure debt updates that only service withdrawals are
excluded from the default REST entries. Withdrawal context never overrides stronger intent evidence: allocator execution,
historically confirmed `DEBT_MANAGER` calls, bad-debt handling, and configuration/lifecycle actions remain visible and retain
their inline `vaultActivities`. A `current_snapshot` entry supplies the safe-block allocation without claiming that all drift
since the previous action was one execution.

The Postgres materializer now computes the filtered and grouped entries ahead of requests. It writes a complete immutable run,
validates certification and accounting at the persistence boundary, and changes the active-run pointer in the same transaction.
The REST handler performs a keyset query only; raw GraphQL investigation may remain slower.

The default `live` source retains the earlier bounded, request-time implementation for local shape testing. It is not an
automatic fallback from database mode and continues to reject uncertified Envio coverage. The database materializer has an
explicit test-only exception: `ALLOCATION_ALLOW_UNCERTIFIED_MATERIALIZATION=true` may activate an event/RPC-derived run with
`dataQuality.certification: "provisional"`. Its non-empty limitations travel with the response and every entry, and the REST
handler sends `Cache-Control: no-store`.

### Materialized-run semantics

- A failed or interrupted refresh never changes the active run.
- A cursor pins a succeeded run, so activation of a newer run cannot reorder an existing traversal.
- The test-service refresh is currently a full replay and full immutable replacement, not an incremental tail update.
- Previously successful runs are retained because deleting one would invalidate outstanding cursors. A production retention
  policy must be tied to an explicit cursor lifetime.
- The materialization event ceiling fails the run instead of producing a partial response.
- The public `limit` is independent of materialization completeness and accepts 1–100 entries.
- A provisional run is accepted only by the explicit test switch and must persist at least one limitation explaining why it is
  uncertified. It never supplies missing checkpoint-owned values.

## Inputs

The service combines two authorities without conflating them.

The issue #52 Allocation History contract from `yearn-envio` supplies executed state:

- `AllocationSourceEvent`
- `VaultAccountingCheckpoint`
- `VaultAccountingCheckpointFailure`
- `VaultAllocationCoverage`

DOA Redis keys under `doa:optimizations:<chainId>:<revision>` may supply optimizer intent:

- included strategies and their current/target ratios;
- current and proposed APR estimates;
- explanation text; and
- the immutable source revision or matched timestamp behind the `latest` alias.

The `/api/allocations` response keeps these surfaces under separate `executed` and `optimizer` envelopes. In the allocation
history materializer, DOA is optional enrichment: its failure cannot prevent certified executed history from advancing, and
persisted entries explicitly disclose when proposal enrichment was unavailable.

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

Every rendered indexed ratio uses the same-block checkpoint `totalAssets` denominator. For allocation-history REST snapshots,
archive RPC owns the before/after accounting read, but `unallocatedBps` is populated only when an Envio checkpoint exists at
that exact block and its canonical totals exactly match the RPC read. Otherwise `unallocatedBps`, `unallocatedSource`, and
`unallocatedCheckpointId` are null. The service does not borrow another snapshot's idle value or normalize strategy ratios to
force a 10,000-bps sum.

## Completeness

A response is complete only when all of the following hold:

1. The selected immutable coverage row has `safeForTimeline: true`.
2. No unresolved checkpoint failure exists inside the published range.
3. At least one checkpoint state was produced.
4. Every returned checkpoint has a verified canonical block, a valid accounting identity, valid decimal totals, and valid normalized event payloads.
5. Replayed per-strategy current debt sums exactly to the checkpoint's indexed `totalDebt`.
6. The request stays inside the configured replay-event limit.

Draft request-time coverage may be exposed only through the explicit service-level research switch. Separately, the test-only
database materializer may construct provisional event/RPC coverage when coverage or checkpoint entities are unavailable. Both
surfaces remain uncached and identify their limitations; neither converts unavailable `unallocatedBps` into zero.

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

`/api/rest/views/allocation-history/:chainId/:address` defaults to `direction=desc` and keyset-paginates the already materialized
entries by `(endBlock, id)`. `direction=asc` walks chronologically. When `pagination.nextCursor` is non-null, the client must
send it back with the same direction and response projection. Cursors are opaque, versioned, bound to one response
projection/materialization run, and rejected when malformed, direction- or projection-mismatched, out of Postgres bigint
range, or no longer retained.
