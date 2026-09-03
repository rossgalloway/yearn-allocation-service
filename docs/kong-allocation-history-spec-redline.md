# Vault Allocation History — Proposed Redline of Kong #396

Source: [Vault Allocation History — Spec (Re-spec of Kong #396)](https://hackmd.io/@murderteeth/rJkQlX-AWx)

Clean version: [Proposed Kong allocation history specification](https://artifacts.yearn.dev/1y/6532c957e3ef76e6d1313e4f6984efca.md)

This document keeps the complete original spec and shows the proposed changes from the allocation-history prototype.

- ~~Struck-through text~~ is removed or replaced.
- **Updated:** text is the proposed replacement.
- **Added:** text is a new requirement.
- In code blocks, `-` is removed and `+` is added.

This is a proposal for discussion. It is not the final Kong implementation plan.

## 1. Goal

Provide Kong API consumers with a vault-scoped allocation timeline that explains how debt was distributed across strategies over time, and what kind of activity produced each change. ~~Consumers render charts/panels directly from the response, with no event replay or archive RPC calls of their own.~~

**Updated:** Kong builds one enriched and validated allocation model. GraphQL exposes flexible normalized data and detailed evidence. REST exposes fast, precomputed entries for charts and websites. Neither consumer needs to replay events or make archive RPC calls.

**Added:** Envio owns blockchain indexing. Kong reads indexed data from Envio, performs RPC enrichment, and uses the same materialized data for GraphQL and REST.

## 2. Consumers

- **Primary:** yearn.fi (allocation flow chart, reallocation panel)
- **Secondary:** other Kong API clients
- **Added:** GraphQL consumers that need detailed states, actions, policies, events, and execution evidence

## 3. Required outputs

For a given `(chainId, vault)`:

- **Vault metadata** — name, symbol, asset, decimals
- **Strategy directory** — every strategy ever interacted with, plus current activity status
- ~~**Allocation states** — block-end snapshots of debt distribution~~
- **Updated: Allocation states** — exact snapshots immediately before and after each action, plus the latest safe snapshot
- ~~**Allocation transitions** — what changed between consecutive states, classified by intent, with actor metadata and `effects[]` for mixed same-block activity~~
- **Updated: Atomic transitions** — transaction- or event-level changes with source-event references
- **Added: Allocation actions** — one or more related transitions grouped into one economic action, with a before state, after state, operations, execution evidence, and transactions
- ~~**DOA annotations** on transitions where a matched proposal explains the change~~
- **Updated: Allocation policies** — DOA target policies with explicit relationships to one or more actions
- ~~**Pending DOA proposals** with status (`pending` / `unmatched` / `stale`)~~
- **Updated: Unapplied policies** with evidence-based status such as `unmatched` or `superseded`; age alone does not make a policy stale
- ~~**Raw source events** (optional, debug only)~~
- **Updated: Raw source events** available through GraphQL for investigation, but not included in the normal REST response
- **Added: Execution provenance** — automation, mechanism, target match, actor, call path, role evidence, and limitations
- **Added: Reconciled allocation intervals** — raw-unit flows between chart points, including explicit unattributed changes
- **Added: Coverage and data quality** — certification, known gaps, and unavailable evidence

~~Response uses the `VaultAllocationTimeline` schema (see Appendix).~~

**Updated:** Kong stores a normalized allocation model for GraphQL and derives denormalized REST entry and chart projections from the same materialization run. See the Appendix.

## 4. Timeline format

The output is an **event series**, not a timeseries. Rendering contract:

- ~~States are sampled only at blocks where relevant events fired. No samples for inactive blocks.~~
- **Updated:** Historical states are sampled at action boundaries: immediately before the first action transaction and after the last action transaction. Atomic event-block states may also be retained for GraphQL. No samples are required for inactive blocks.
- A vault with no activity for 30 days has zero state samples for that span.
- **Values are constant between consecutive states (step-function semantics).** Between state N and state N+1, the allocation is whatever state N held. State N+1 changes it.
- The live-tail state ends the series at "now." Its `blockNumber` / `blockTimestamp` come from the latest safe block used to compute it, not from response-generation time.
- Consumers wanting evenly-spaced x-axis samples must resample/interpolate themselves. The API does not produce uniform samples.
- **Added:** One allocation action may span several transactions and blocks. Time proximity alone is not enough to group them.
- **Added:** REST returns newest entries first by default and supports oldest-first traversal. GraphQL controls order through query arguments.
- **Added:** A chart interval starts at one visible action's after state and ends at the next visible action's after state. Activity hidden from the public chart remains part of the interval accounting.

Without this contract, a chart renderer assuming timeseries semantics will draw incorrect plots.

## 5. Classification kinds

~~`doa_execution`, `allocator_execution`, `manual_debt_update`, `manual_config_change`, `report_only_state_change`, `strategy_lifecycle_change`, `bad_debt_purchase`, `current_live_tail`, `unknown`.~~

**Updated:** The top-level action kind describes the economic result:

`policy_application`, `idle_deployment`, `idle_deallocation`, `strategy_reallocation`, `unattributed_debt_update`, `configuration_change`, `strategy_lifecycle_change`, `bad_debt_purchase`, `current_snapshot`, `unknown`.

~~Classification is DOA-aware: a transition matching a DOA proposal AND containing an on-chain debt update is `doa_execution`. Actor classification runs per-effect within a transition.~~

**Updated:** Execution provenance is separate from the action kind:

- `execution.automation`: `automatic`, `manual`, `mixed`, `unknown`, or not applicable
- `execution.mechanism`: `allocator_keeper`, `direct_vault_role`, `governance_safe`, `governance`, `role_manager`, `mixed`, or `unknown`
- `execution.targetStatus`: `matched`, `overridden`, `unavailable`, `not_applicable`, or `mixed`

Actor classification and evidence run per transaction. A policy relationship is separate from both the economic kind and execution provenance.

## 6. Invariants

- ~~On-chain events are canonical truth. DOA records are annotations only; a DOA record alone never produces an executed state.~~
- **Updated:** Envio-indexed on-chain events are canonical execution evidence. Archive RPC reads are canonical snapshot evidence. DOA records are optional policy data and never create executed state by themselves.
- ~~Historical states reconcile to on-chain truth: `sum(strategy.currentDebt) + totalIdle ≈ totalAssets` at the relevant block. Bps computed from raw integers, not pre-rounded.~~
- **Updated:** Every published snapshot reconciles exactly: `sum(strategy.currentDebt) = totalDebt` and `totalDebt + totalIdle = totalAssets`. Bps are computed from raw integers, not pre-rounded.
- Strategy directory at any historical block includes all strategies ever seen up to that block, including revoked-with-nonzero-debt.
- ~~State and transition IDs are deterministic, derivable from `(chainId, vault, blockNumber)`.~~
- **Updated:** State, transition, action, policy, and interval IDs are deterministic. Action IDs include the chain, vault, and action block range or equivalent stable transaction identity.
- Multiple relevant events in the same block collapse into one block-end state, with `effects[]` capturing each contributing event/transaction.
- **Added:** Related transitions may form one multi-block action only when state continuity and execution evidence support the grouping.
- Frontend is render-only: response must not require archive RPC, event replay, or knowledge of internal storage.
- **Added:** Every tracked idle and strategy node in a chart interval must reconcile independently. Unknown balancing changes remain explicit `unattributed_asset_change` flows.
- **Added:** Only an exact same-block Envio checkpoint that agrees with the RPC totals may populate `unallocatedBps`. Missing evidence is `null`, not zero.
- **Added:** GraphQL and REST are projections of the same materialization run and must not classify or reconstruct the same action differently.

## 7. Architecture

### 7.1 Data sources

- ~~**Envio (self-hosted)** — event logs + transaction-level data (`tx.from`, `tx.to`, function selector). Connection details, schema, and query interface — see §12 (TBD).~~
- **Updated: Envio** — the only blockchain indexer. Kong reads a complete normalized event interface through Envio GraphQL. Each event includes decoded arguments, source contract, vault, block and transaction ordering, transaction hash, and strategy address when relevant. Envio also exposes coverage, accounting checkpoints, known gaps, and unresolved checkpoint failures.
- **Added:** `Deposit` and `Withdraw` are context events. They help explain debt changes but do not normally create allocation actions by themselves.
- **Added:** Envio must normalize legacy and shared-allocator event shapes, including vault-specific allocator assignment and strategy-ratio changes.
- ~~**DOA proposal source** — see §12 (TBD). Needs a defined contract before implementation.~~
- **Updated: DOA policy source** — optional policy targets, APR estimates, explanations, publication time, and immutable source identity. Its availability does not control whether executed history can update.
- ~~**Archive RPC** — viem clients constructed inside the refresh script for state reconciliation multicalls (`vault.totalAssets`, `vault.totalDebt`, `vault.totalIdle`, `vault.strategies(s)`, allocator ratios). RPC URLs provisioned per chain as GitHub Actions secrets.~~
- **Updated: Archive RPC** — historical snapshot reads at action boundaries, allocator configuration, `shouldUpdateDebt` replay, and transaction traces. Required calls include `vault.totalAssets`, `vault.totalDebt`, `vault.totalIdle`, `vault.strategies(strategy)`, and shared allocator `getStrategyConfig(vault,strategy)`.
- **Added: Current RPC** — latest safe block, current allocation, vault metadata, strategy names, and current strategy status. The archive provider may also serve these reads.

### 7.2 Storage

~~One Redis key per vault:~~

- ~~`allocation-history:{chainId}:{vaultLower}:blob`~~

~~Blob extends `VaultAllocationTimeline` (Appendix) with internal cursors that the route strips on read:~~

```diff
- type AllocationHistoryBlob = VaultAllocationTimeline & {
-   lastProcessedBlock: number
-   lastProcessedDoaTimestamp: number  // unix seconds
- }
+ type AllocationMaterializationRun = {
+   id: string
+   chainId: number
+   vaultAddress: `0x${string}`
+   generatedAt: number
+   safeBlock: number
+   coverage: AllocationDataQuality
+   status: 'running' | 'succeeded' | 'failed'
+ }
```

~~The trailing entry of `states` is the live tail when present (`stateGranularity: 'latest'`); the trailing entry of `transitions` is the live tail when present (`kind: 'current_live_tail'`). Two cursors because on-chain events and DOA records run on different clocks.~~

**Updated:** Store normalized states, atomic transitions, grouped actions, policies, source evidence, and data quality for GraphQL. Store full-entry and compact-chart REST projections from the same run. Activate all projections together only after validation.

**Added:** REST cursors pin the immutable run, direction, projection, and last keyset position. A refresh cannot change an in-progress traversal.

**Added:** The prototype stores completed REST projections in Postgres but builds much of the normalized model in memory. Kong should persist the normalized model if GraphQL must query it without repeating Envio and RPC work.

### 7.3 Refresh jobs ~~— GitHub Actions~~

~~Two scheduled workflows:~~

- ~~**Full rebuild — weekly.** Rebuilds blob from each vault's `inceptBlock`. Validates that incremental output matches a from-scratch rebuild.~~
- ~~**Incremental — hourly.** Reads events strictly newer than `lastProcessedBlock` and DOA proposals strictly newer than `lastProcessedDoaTimestamp`. Materializes new states, runs DOA processing (matching + aging), updates watermarks, writes blob.~~

**Updated:** Use a background Kong materialization job with two modes:

- **Backfill:** reads complete Envio history, enriches it through RPC, validates it, and creates a new immutable run.
- **Incremental refresh:** updates an immutable historical prefix plus a mutable recent tail, then creates and activates a consistent new run.

~~Both call the same shared `refresh(vault, mode: 'full' | 'incremental')` function.~~

**Updated:** Both modes use the same ingestion, enrichment, grouping, classification, policy, and validation functions.

~~Concurrency: GH Actions `concurrency:` blocks with `cancel-in-progress: false`. If hourly fires while weekly is running, hourly queues until weekly completes.~~

**Updated:** Only one materialization may run for a vault at a time. A failed or interrupted run never replaces the last successful run. A full rebuild must produce the same result as incremental processing for the same safe block and source revisions.

**Added:** The current prototype refresh performs a complete replay. Incremental tail processing and old-run retention must be completed before broad production use.

### 7.4 Vault list

Queried at job start:

```sql
SELECT
  chain_id,
  address,
  defaults->>'inceptBlock' AS incept_block
FROM thing
WHERE label = 'vault'
  AND (defaults->>'v3')::boolean = true
  AND defaults->>'origin' = 'yearn';
```

**Added:** The prototype rollout is limited to Ethereum `yvUSDC-1`, `yvUSDT-1`, and `yvUSD`. This is a testing limit, not the final Kong scope.

### 7.5 GraphQL endpoint

**Added:** Kong GraphQL reads the normalized active materialization run. It exposes paginated connections for strategies, states, grouped actions, atomic transitions, policies, intervals, and source events. Detailed trace, role, trigger-replay, grouping, and classification evidence is available when requested.

**Added:** GraphQL may be slower and more flexible than REST, but it must not run a separate history reconstruction. Normal GraphQL reads should not repeat Envio ingestion or archive RPC enrichment.

### 7.6 REST endpoint

Lives at `packages/web/app/api/rest/views/allocation-history/[chainId]/[address]/route.ts`. Behaves like other Kong REST endpoints:

- ~~Reads `allocation-history:{chainId}:{vaultLower}:blob`, strips internal cursor fields, returns the result~~
- **Updated:** Reads the active immutable materialization run from Kong storage and returns a keyset-paginated, denormalized `entries` array
- **Added:** `projection=chart` returns only chart-relevant economic actions, a separate current snapshot, expected APR information when available, and reconciled interval flows
- **Added:** `/entries/:entryId?runId=...` returns the full evidence-rich entry for a chart item
- Same `Cache-Control` posture as existing REST routes (`max-age=900, s-maxage=900, stale-while-revalidate=600`)
- **Added:** Provisional test data is marked clearly and uses `Cache-Control: no-store`; production Kong remains certified-only by default
- CORS headers
- ~~Validates params, returns 400 on invalid, 404 on missing cache~~
- **Updated:** Validates parameters and cursors, returns 400 on invalid input, and returns 404 when the requested vault, run, or entry is not materialized
- **Added:** Defaults to newest-first order, supports oldest-first order, and returns an opaque cursor pinned to the run and projection

### 7.7 Code layout

~~All under `packages/web/app/api/rest/views/allocation-history/`:~~

- ~~`[chainId]/[address]/route.ts` — REST endpoint~~
- ~~`refresh.ts` — shared refresh function (`refresh(vault, mode)`)~~
- ~~`materialize.ts` — archive multicall + state construction at a block~~
- ~~`classify.ts` — transition classifier, DOA-aware finalization~~
- ~~`doa.ts` — DOA processing (matching, aging, status)~~
- ~~`envio.ts` — Envio query helpers (TBD)~~
- ~~`redis.ts` — blob read/write helpers~~
- ~~`shape.ts` — derive public response from blob~~
- ~~`types.ts` — shared types~~
- ~~`*.spec.ts` — tests alongside~~

**Updated:** Exact Kong paths should follow existing Kong conventions. Keep these responsibilities separate:

- Envio client and complete pagination
- RPC state reads, traces, and trigger replay
- Normalized allocation model and validation
- Atomic transition construction and multi-transaction action grouping
- Policy matching
- Interval-flow reconciliation
- Materialization storage and activation
- GraphQL resolvers
- REST full-entry and chart projections
- Tests for pure processing, database activation, GraphQL, and REST contracts

~~GH Actions workflow at `.github/workflows/allocation-history.yml` invokes the refresh via a bun-executed entrypoint.~~

**Updated:** Kong's normal job system should invoke the materializer. Deployment details should follow Kong's existing operational model.

## 8. Constants

~~In `packages/web/app/api/rest/views/allocation-history/doa.ts`:~~

- ~~`maxDoaProposalPublishingLagHours = 24` — DOA may publish a proposal record up to this long after the corresponding on-chain execution.~~
- ~~`expectedDoaProposalExecutionWindowHours = 72` — A fresh DOA proposal is expected to execute on-chain within this window.~~
- ~~`staleDoaProposalThresholdDays = 30` — Past this age, an unmatched DOA proposal is considered stale.~~

**Updated:** Do not use elapsed-time constants to decide whether a policy was applied or became stale. Policy status is based on on-chain configuration evidence and whether a newer policy superseded it.

**Added:** A short execution-grouping time window may be supporting evidence, but never sufficient evidence. The prototype uses one hour together with matching call paths, allocator configuration, roles, and state continuity.

## 9. DOA processing

~~Single shared pure function `processDoa(proposals, transitions, now)`:~~

- ~~**Matching:** for each unmatched proposal, find candidate transitions in the past `maxDoaProposalPublishingLagHours`. Signals (strongest first):~~
  1. ~~Same `(chainId, vault)`~~
  2. ~~Allocator `UpdateStrategyDebtRatios` target ratios match proposal target ratios~~
  3. ~~Co-occurring `DebtUpdated` direction matches proposal targets~~
  4. ~~Transaction path matches DOA keeper/applicator address set~~
  5. ~~Event timestamp near proposal timestamp~~
- ~~**Aging:** for each unmatched proposal, status from `now - proposal_time`:~~
  - ~~`pending` if `≤ expectedDoaProposalExecutionWindowHours`~~
  - ~~`unmatched` if `≤ staleDoaProposalThresholdDays`~~
  - ~~`stale` otherwise (also stale if superseded by a newer proposal targeting the same set, or removed from upstream)~~
- ~~**Late-arrival re-match:** when new DOA records appear, transitions within the `maxDoaProposalPublishingLagHours` window are re-classified — already-stored `manual_debt_update` / `allocator_execution` transitions can be upgraded to `doa_execution`.~~

**Updated:** One shared policy processor builds allocation policies and their relationships to actions:

1. Match the same `(chainId, vault)` and normalized strategy target set.
2. Mark policy application `confirmed` only when an indexed allocator configuration event exactly matches the targets.
3. Mark it `inferred_from_historical_config` when an archive-RPC configuration read exactly matches but the indexed application event is unavailable.
4. Treat keeper identity, debt direction, and timestamp proximity only as supporting evidence. They never confirm policy application alone.
5. Keep an applied policy active until a newer policy supersedes it. One policy may govern many later keeper actions.
6. Keep unapplied policies `unmatched` or `superseded`. Do not make them stale only because time passed.
7. Reprocess affected policy relationships when late Envio or DOA data arrives.

Both incremental and full refreshes call this function unchanged.

## 10. State materialization

~~Per relevant block:~~

**Updated:** Per atomic event block and grouped-action boundary:

1. **Candidate strategy universe** — all ever-seen strategies up to and including the block. Sources: `StrategyChanged`, `DebtUpdated`, `DebtPurchased`, `StrategyReported`, `UpdatedMaxDebtForStrategy`, default queue events, allocator ratio events. Do not drop revoked strategies; they may still hold non-zero debt and are needed for reconciliation.
2. ~~**Allocator resolution** — debt allocator at the block from `NewDebtAllocator` history at or before that block.~~
   **Updated:** Resolve the allocator from `NewDebtAllocator` and `UpdateDebtAllocator` history, confirmed by historical RPC when available.
3. ~~**Archive multicall at `blockNumber`:**~~
   **Updated: Archive reads at `N - 1` and `N`, or before the first and after the last block of a grouped action:**
   - `vault.totalAssets()`
   - ~~`vault.totalDebt()` (fall back to summing strategy debts if not exposed)~~
   - **Updated:** `vault.totalDebt()`; validate it against the sum of strategy debt
   - ~~`vault.totalIdle()` (fall back to `max(totalAssets - totalDebt, 0)`; flag as computed in logs)~~
   - **Updated:** `vault.totalIdle()`; do not silently synthesize a missing value for a published snapshot
   - `vault.strategies(s)` for each candidate strategy
   - ~~allocator `getStrategyTargetRatio(s)` and `getStrategyMaxRatio(s)` if allocator exists at the block~~
   - **Updated:** shared allocator `getStrategyConfig(vault,s)` if an allocator exists at the block; decode membership, target ratio, and maximum ratio
4. **Bps from raw integers.** If `totalAssets == 0`, bps are 0; raw debts kept.
5. **Added: Checkpoint provenance.** Populate `unallocatedBps` only when an exact same-block Envio checkpoint is canonical, reconciled, and byte-for-byte equal to the RPC totals.
6. **Added: Execution evidence.** Read transaction traces, historical role evidence, and allocator `shouldUpdateDebt` results needed for later grouping and classification.
7. **Added: Validation.** Require strategy-debt sum to equal total debt and total debt plus total idle to equal total assets before publication.

After all historical block-end states, materialize a live-tail state at the latest safe block using the same multicall set. Skip live-tail if it duplicates the last historical block.

**Added:** REST exposes this live tail as a separate `currentSnapshot`. GraphQL retains it as a state with `stateGranularity: 'latest'`.

## 11. Required event sources

Envio must expose these for every Kong-supported chain:

- ~~**V3 vault:** `DebtUpdated`, `StrategyReported`, `StrategyChanged`, `UpdatedMaxDebtForStrategy`, `DebtPurchased`, `UpdateDefaultQueue`, `UpdateUseDefaultQueue`, `RoleSet`, `RoleStatusChanged`, `UpdateRoleManager`, `UpdateAccountant`~~
- **Updated: V3 vault:** `Deposit`, `Withdraw`, `DebtUpdated`, `StrategyReported`, `StrategyChanged`, `UpdatedMaxDebtForStrategy`, `DebtPurchased`, `UpdateDefaultQueue`, `UpdateUseDefaultQueue`, `RoleSet`, `RoleStatusChanged`, `UpdateRoleManager`, `UpdateAccountant`
- **Debt manager factory:** `NewDebtAllocator`
- **Added: Vault allocator assignment:** `UpdateDebtAllocator` or the equivalent event for the deployed vault version
- ~~**Debt allocator:** `UpdateStrategyDebtRatios`, `UpdateKeeper`, `GovernanceTransferred`~~
- **Updated: Debt allocator:** both `UpdateStrategyDebtRatio` and `UpdateStrategyDebtRatios` contract variants, `UpdateKeeper`, `GovernanceTransferred`
- **Added: Validation entities:** `VaultAllocationCoverage`, `VaultAccountingCheckpoint`, and `VaultAccountingCheckpointFailure`, or equivalent normalized Envio entities

If Envio coverage is partial, indexing the missing events upstream is a prerequisite to this work.

**Added:** The prototype may use explicitly marked provisional data for testing. Production Kong must not silently accept incomplete event or checkpoint coverage.

## 12. TBDs ~~(block implementation)~~

- ~~**Envio interface** — connection (GraphQL? direct Postgres?), schema, auth, network access from the GH Actions runner. Owner: ?~~
- **Updated: Envio interface** — GraphQL is the proposed Kong input. Finalize the normalized event, coverage, checkpoint, pagination, authentication, and network contract between Envio and Kong.
- ~~**Envio coverage** — confirm every event in §11 is indexed across all six chains; backfill missing ones if not.~~
- **Updated: Envio coverage** — add the §11 context and shared-allocator events, certify each supported chain, and backfill missing history before production activation.
- ~~**DOA proposal interface** — confirm doa type inteface~~

```diff
- type DoaAnnotation = {
-   sourceKey: string
-   proposalTimestamp: number
-   optimizerCurrentApr: number | null
-   optimizerProposedApr: number | null
-   explain: string | null
-   strategyTargets: Array<{
-     strategyAddress: `0x${string}`
-     currentRatioBps: number | null
-     targetRatioBps: number | null
-     currentApr?: number | null
-     targetApr?: number | null
-   }>
-   matchReason: string
- }
+ type AllocationPolicy = {
+   id: string
+   source: 'doa'
+   sourceKey: string
+   publishedAt: number
+   baselineAprBps: number | null
+   proposedAprBps: number | null
+   explain: string | null
+   targets: AllocationPolicyTarget[]
+   application: PolicyApplication
+ }
```

- ~~**Address labels** — per-chain keeper/applicator addresses for actor classification~~
- **Updated: Actor evidence** — define how Kong obtains keeper labels, Safe and relayer identities, historical vault role masks, and allocator address history for every chain.
- **Added: Kong GraphQL schema** — finalize connections, pagination, authorization, and rate limits for normalized states, actions, policies, events, traces, roles, and intervals.
- **Added: Normalized storage** — decide which normalized Envio and RPC evidence Kong persists so GraphQL does not repeat expensive enrichment work.
- **Added: Incremental materialization** — define the immutable historical prefix, mutable tail, reclassification window, cursor lifetime, and old-run retention policy.
- **Added: Unlimited max debt** — define a safe GraphQL and REST representation for `uint256.max` without JavaScript number loss.

## 13. Acceptance

Feature is complete when:

1. ~~`GET /api/rest/views/allocation-history/:chainId/:address` returns a `VaultAllocationTimeline` derived from the cached blob.~~
   **Updated:** Kong materializes one validated normalized history and serves it through GraphQL plus the full-entry and chart REST projections.
2. All invariants in §6 hold.
3. All event sources in §11 are reflected in classification and state.
4. ~~DOA records are returned as annotations or as `pendingDoaProposals` per §9; no DOA record creates an executed state.~~
   **Updated:** DOA records create policies and evidence-based relationships to actions. No DOA record creates executed state.
5. ~~Hourly incremental and weekly full rebuild produce equivalent output for the same `(chainId, vault)`. Drift between them is a bug.~~
   **Updated:** Incremental and full materialization produce equivalent normalized and projected output for the same `(chainId, vault, safeBlock, source revisions)`. Drift is a bug.
6. **Added:** Every action has a clear whole-group before and after state. Multi-transaction grouping discloses its evidence and limitations.
7. **Added:** Economic kind, automation, mechanism, allocator-target match, and policy relationship are independent fields.
8. **Added:** Every published state satisfies the exact accounting identities. Every chart interval balances each tracked strategy and idle node.
9. **Added:** REST requests use only materialized storage and do not call Envio, RPC, or DOA services at request time.
10. **Added:** GraphQL and REST resolve from the same materialization run and agree on shared state, action, policy, and evidence fields.
11. **Added:** Failed or incomplete materialization never replaces the last successful active run.
12. **Added:** Production data fails closed when Envio coverage, checkpoint evidence, archive RPC reads, or accounting validation is incomplete.

## Appendix — Type definitions

All timestamps are unix seconds, UTC.

The original appendix is replaced by a normalized model plus REST projections. The complete original definitions appear as removed lines below; proposed definitions appear as added lines.

```diff
- type VaultAllocationTimeline = {
-   schemaVersion: 1
-   generatedAt: number
-   vault: VaultAllocationVault
-   strategies: AllocationHistoryStrategy[]
-   states: AllocationState[]
-   transitions: AllocationTransition[]
-   pendingDoaProposals?: DoaProposal[]
-   events?: AllocationSourceEvent[]
- }
-
- type VaultAllocationVault = {
-   chainId: number
-   address: `0x${string}`
-   name: string | null
-   symbol: string | null
-   assetAddress: `0x${string}` | null
-   assetSymbol: string | null
-   assetDecimals: number | null
- }
-
- type AllocationHistoryStrategy = {
-   address: `0x${string}`
-   name: string | null
-   status: 'active' | 'inactive' | 'unknown'
- }
-
- type AllocationState = {
-   id: string
-   stateGranularity: 'block_end' | 'latest'
-   blockNumber: number
-   blockTimestamp: number
-   transactionHash: `0x${string}` | null
-   totalAssets: string
-   totalDebt: string
-   totalIdle: string | null
-   unallocatedBps: number
-   sourceEventIds: string[]
-   strategies: AllocationStateStrategy[]
- }
-
- type AllocationStateStrategy = {
-   strategyAddress: `0x${string}`
-   currentDebt: string
-   currentDebtBps: number
-   maxDebt: string | null
-   maxDebtBps: number | null
-   targetDebtRatioBps: number | null
-   maxDebtRatioBps: number | null
-   activation: number | null
-   lastReport: number | null
- }
-
- type AllocationTransitionKind =
-   | 'doa_execution'
-   | 'allocator_execution'
-   | 'manual_debt_update'
-   | 'manual_config_change'
-   | 'report_only_state_change'
-   | 'strategy_lifecycle_change'
-   | 'bad_debt_purchase'
-   | 'current_live_tail'
-   | 'unknown'
-
- type ActorClassification = {
-   address: `0x${string}` | null
-   role:
-     | 'doa_keeper'
-     | 'debt_allocator_keeper'
-     | 'governance'
-     | 'management'
-     | 'role_manager'
-     | 'vault_role_holder'
-     | 'unknown'
-   label: string | null
- }
-
- type AllocationTransitionEffect = {
-   kind: AllocationTransitionKind
-   sourceEventIds: string[]
-   transactionHash: `0x${string}`
-   transactionFrom: `0x${string}` | null
-   transactionTo: `0x${string}` | null
-   inputSelector: `0x${string}` | null
-   actor: ActorClassification
- }
-
- type AllocationTransition = {
-   id: string
-   kind: AllocationTransitionKind
-   fromStateId: string | null
-   toStateId: string
-   blockNumber: number
-   blockTimestamp: number
-   transactionHashes: `0x${string}`[]
-   effects: AllocationTransitionEffect[]
-   doa?: DoaAnnotation
- }
-
- type AllocationSourceEvent = {
-   id: string                         // `${chainId}:${transactionHash}:${logIndex}`
-   sourceAddress: `0x${string}`       // vault, debt allocator, manager, etc.
-   sourceLabel: 'vault' | 'debtAllocator' | 'debtManagerFactory' | 'unknown'
-   eventName: string
-   signature: `0x${string}`
-   blockNumber: number
-   blockTimestamp: number
-   transactionHash: `0x${string}`
-   transactionIndex: number
-   logIndex: number
-   transactionFrom: `0x${string}` | null
-   transactionTo: `0x${string}` | null
-   inputSelector: `0x${string}` | null  // first 4 bytes, e.g. 0x12345678
-   strategyAddress?: `0x${string}` | null
-   args: Record<string, unknown>
- }
-
- type DoaAnnotation = {
-   sourceKey: string
-   proposalTimestamp: number
-   optimizerCurrentApr: number | null
-   optimizerProposedApr: number | null
-   explain: string | null
-   strategyTargets: Array<{
-     strategyAddress: `0x${string}`
-     currentRatioBps: number | null
-     targetRatioBps: number | null
-     currentApr?: number | null
-     targetApr?: number | null
-   }>
-   matchReason: string
- }
-
- type DoaProposal = DoaAnnotation & {
-   status: 'pending' | 'unmatched' | 'stale'
- }
+ type Address = `0x${string}`
+ type Hash = `0x${string}`
+
+ // Shared normalized model used by GraphQL and REST materialization.
+ type VaultAllocationModel = {
+   schemaVersion: 2
+   generatedAt: number
+   runId: string
+   dataQuality: AllocationDataQuality
+   vault: VaultAllocationVault
+   strategies: AllocationHistoryStrategy[]
+   states: AllocationState[]
+   actions: AllocationAction[]
+   transitions: AllocationTransition[]
+   policies: AllocationPolicy[]
+   intervals: AllocationInterval[]
+   events: AllocationSourceEvent[]
+ }
+
+ type AllocationDataQuality = {
+   certification: 'certified' | 'provisional'
+   coverageStartBlock: number
+   validatedThroughBlock: number
+   safeBlock: number
+   coverageRevision: string
+   limitations: string[]
+ }
+
+ type VaultAllocationVault = {
+   chainId: number
+   address: Address
+   name: string | null
+   symbol: string | null
+   assetAddress: Address | null
+   assetSymbol: string | null
+   assetDecimals: number | null
+ }
+
+ type AllocationHistoryStrategy = {
+   address: Address
+   name: string | null
+   status: 'active' | 'inactive' | 'unknown'
+   statusReadAtBlock: number
+ }
+
+ type AllocationState = {
+   id: string
+   stateGranularity: 'block_end' | 'action_before' | 'action_after' | 'latest'
+   blockNumber: number
+   blockTimestamp: number
+   source: 'archive_rpc'
+   totalAssets: string
+   totalDebt: string
+   totalIdle: string | null
+   unallocatedBps: number | null
+   unallocatedSource: 'envio_same_block_checkpoint' | null
+   unallocatedCheckpointId: string | null
+   allocatorAddress: Address | null
+   sourceEventIds: string[]
+   strategies: AllocationStateStrategy[]
+   accountingChecks: {
+     strategyDebtSumEqualsTotalDebt: boolean
+     totalAssetsEqualsDebtPlusIdle: boolean | null
+   }
+ }
+
+ type AllocationStateStrategy = {
+   strategyAddress: Address
+   currentDebt: string
+   currentDebtBps: number
+   maxDebt: string | null
+   maxDebtBps: number | null
+   targetDebtRatioBps: number | null
+   maxDebtRatioBps: number | null
+   allocatorAdded: boolean | null
+   activation: number | null
+   lastReport: number | null
+ }
+
+ type AllocationTransitionKind =
+   | 'allocator_execution'
+   | 'deposit_driven_debt_update'
+   | 'withdrawal_driven_debt_update'
+   | 'manual_debt_update'
+   | 'manual_config_change'
+   | 'report_only_state_change'
+   | 'strategy_lifecycle_change'
+   | 'bad_debt_purchase'
+   | 'vault_deposit'
+   | 'vault_withdrawal'
+   | 'unknown'
+
+ type AllocationActionKind =
+   | 'policy_application'
+   | 'idle_deployment'
+   | 'idle_deallocation'
+   | 'strategy_reallocation'
+   | 'unattributed_debt_update'
+   | 'configuration_change'
+   | 'strategy_lifecycle_change'
+   | 'bad_debt_purchase'
+   | 'current_snapshot'
+   | 'unknown'
+
+ type ActorClassification = {
+   address: Address | null
+   role:
+     | 'doa_keeper'
+     | 'debt_allocator_keeper'
+     | 'governance'
+     | 'management'
+     | 'role_manager'
+     | 'vault_role_holder'
+     | 'unknown'
+   label: string | null
+ }
+
+ type AllocationTransaction = {
+   transactionHash: Hash
+   blockNumber: number
+   blockTimestamp: number
+   originator: ActorClassification
+   transactionTarget: Address | null
+   inputSelector: Hash | null
+   callPath: Address[]
+   traceStatus: 'available' | 'unavailable'
+   immediateVaultCaller: Address | null
+   authorization: {
+     role: 'DEBT_MANAGER'
+     roleMask: string | null
+     confirmedAtBlock: boolean | null
+   }
+   sourceEventIds: string[]
+   triggerReplays: AllocatorTriggerReplay[]
+   vaultActivities: VaultActivity[]
+ }
+
+ type AllocationTransition = {
+   id: string
+   kind: AllocationTransitionKind
+   fromStateId: string | null
+   toStateId: string
+   blockNumber: number
+   blockTimestamp: number
+   transactionHash: Hash
+   sourceEventIds: string[]
+   operationIds: string[]
+ }
+
+ type AllocationOperation = {
+   id: string
+   kind:
+     | 'strategy_added'
+     | 'strategy_retired'
+     | 'max_debt_updated'
+     | 'allocator_strategy_configured'
+     | 'vault_configuration_updated'
+   source: 'envio_event' | 'archive_rpc_diff'
+   sourceEventIds: string[]
+   subjectAddress: Address | null
+   changes: Array<{ field: string; before: unknown; after: unknown }>
+ }
+
+ type AllocationExecution = {
+   automation: 'automatic' | 'manual' | 'mixed' | 'unknown' | null
+   mechanism:
+     | 'allocator_keeper'
+     | 'direct_vault_role'
+     | 'governance_safe'
+     | 'governance'
+     | 'role_manager'
+     | 'mixed'
+     | 'unknown'
+     | null
+   targetStatus: 'matched' | 'overridden' | 'unavailable' | 'not_applicable' | 'mixed' | null
+   transactions: AllocationTransaction[]
+ }
+
+ type AllocationAction = {
+   id: string
+   kind: AllocationActionKind
+   startBlock: number
+   endBlock: number
+   startTimestamp: number
+   endTimestamp: number
+   beforeStateId: string | null
+   afterStateId: string
+   transitionIds: string[]
+   operationIds: string[]
+   policyRelationship: AllocationPolicyRelationship | null
+   execution: AllocationExecution
+   classification: {
+     confidence: 'high' | 'medium' | 'low'
+     evidence: string[]
+     limitations: string[]
+   }
+ }
+
+ type AllocationPolicyTarget = {
+   strategyAddress: Address
+   currentRatioBps: number | null
+   targetRatioBps: number | null
+   maxRatioBps: number | null
+   currentAprBps: number | null
+   targetAprBps: number | null
+ }
+
+ type PolicyApplication =
+   | {
+       status: 'confirmed'
+       blockNumber: number
+       transactionHash: Hash
+       sourceEventIds: string[]
+     }
+   | {
+       status: 'inferred_from_historical_config'
+       blockNumber: null
+       transactionHash: null
+       sourceEventIds: []
+     }
+   | {
+       status: 'unmatched' | 'superseded'
+       blockNumber: null
+       transactionHash: null
+       sourceEventIds: []
+     }
+
+ type AllocationPolicy = {
+   id: string
+   source: 'doa'
+   sourceKey: string
+   publishedAt: number
+   baselineAprBps: number | null
+   proposedAprBps: number | null
+   explain: string | null
+   targets: AllocationPolicyTarget[]
+   application: PolicyApplication
+ }
+
+ type AllocationPolicyRelationship = {
+   policyId: string
+   relationship: 'applied_in_action' | 'governing_policy' | 'historical_target_match'
+ }
+
+ type AllocatorTriggerReplay = {
+   strategyAddress: Address
+   allocatorAddress: Address
+   readAtBlock: number
+   status: 'matched' | 'not_matched' | 'unavailable'
+   expectedDebt: string
+   recommendedDebt: string | null
+   absoluteDifference: string | null
+   matchTolerance: string
+ }
+
+ type VaultActivity = {
+   kind: 'deposit' | 'withdrawal'
+   assets: string
+   shares: string
+   transactionHash: Hash
+   sourceEventId: string
+   participants: Address[]
+ }
+
+ type AllocationNode =
+   | { type: 'idle' }
+   | { type: 'strategy'; address: Address; name: string | null }
+   | { type: 'external' }
+   | { type: 'accounting' }
+
+ type AllocationFlow = {
+   source: AllocationNode
+   target: AllocationNode
+   amount: string
+   kind:
+     | 'idle_deployment'
+     | 'idle_deallocation'
+     | 'strategy_reallocation'
+     | 'deposit'
+     | 'withdrawal'
+     | 'reported_gain'
+     | 'reported_loss'
+     | 'refund'
+     | 'unattributed_asset_change'
+   attribution: 'observed_event' | 'derived_from_debt_updates' | 'unattributed'
+ }
+
+ type AllocationInterval = {
+   id: string
+   fromEntryId: string
+   toEntryId: string | null
+   endKind: 'allocation_entry' | 'safe_head'
+   startStateId: string
+   endStateId: string
+   flows: AllocationFlow[]
+   reconciliation: {
+     openingTotalAssets: string
+     closingTotalAssets: string
+     balanceStatus: 'reconciled' | 'incomplete'
+     attributionStatus: 'complete' | 'partial'
+     unattributedAmount: string
+     residuals: AllocationNodeResidual[]
+   }
+ }
+
+ type AllocationNodeResidual = {
+   node: AllocationNode
+   openingBalance: string
+   attributedInflows: string
+   attributedOutflows: string
+   unattributedInflows: string
+   unattributedOutflows: string
+   closingBalance: string
+   residualAmount: string
+ }
+
+ type AllocationSourceEvent = {
+   id: string
+   chainId: number
+   vaultAddress: Address
+   sourceAddress: Address
+   sourceLabel: 'vault' | 'debtAllocator' | 'debtManagerFactory' | 'unknown'
+   eventName: string
+   signature: Hash
+   blockNumber: number
+   blockTimestamp: number
+   transactionHash: Hash
+   transactionIndex: number
+   logIndex: number
+   transactionFrom: Address | null
+   transactionTo: Address | null
+   inputSelector: Hash | null
+   strategyAddress: Address | null
+   args: Record<string, unknown>
+ }
+
+ // Denormalized REST projection. Full entry fields may be expanded without
+ // changing the normalized GraphQL model.
+ type VaultAllocationRestResponse = {
+   schemaVersion: 2
+   projection: 'full'
+   generatedAt: number
+   direction: 'asc' | 'desc'
+   dataQuality: AllocationDataQuality
+   vault: VaultAllocationVault
+   entries: AllocationRestEntry[]
+   pagination: AllocationPagination
+ }
+
+ type VaultAllocationChartResponse = {
+   schemaVersion: 2
+   projection: 'chart'
+   generatedAt: number
+   direction: 'asc' | 'desc'
+   dataQuality: AllocationDataQuality
+   vault: VaultAllocationVault
+   currentSnapshot: AllocationChartEntry
+   entries: AllocationChartEntry[]
+   pagination: AllocationPagination
+ }
+
+ type AllocationRestEntry = AllocationAction & {
+   before: AllocationState | null
+   after: AllocationState
+   transitions: AllocationTransition[]
+   operations: AllocationOperation[]
+   policy: AllocationPolicy | null
+   detailsAvailable: true
+ }
+
+ type AllocationChartEntry = {
+   id: string
+   kind: 'idle_deployment' | 'idle_deallocation' | 'strategy_reallocation' | 'current_snapshot'
+   startBlock: number
+   endBlock: number
+   before: AllocationState | null
+   after: AllocationState
+   execution: AllocationExecution
+   expectedAprImpact: ExpectedAprImpact
+   interval: AllocationInterval | null
+   detailsAvailable: boolean
+   detailsHref: string | null
+ }
+
+ type ExpectedAprImpact =
+   | {
+       status: 'available'
+       source: 'doa'
+       scope: 'proposal'
+       baselineAprBps: number
+       proposedAprBps: number
+       deltaAprBps: number
+       policyId: string
+       relationship: AllocationPolicyRelationship['relationship']
+     }
+   | { status: 'unavailable'; reason: string }
+
+ type AllocationPagination = {
+   limit: number
+   nextCursor: string | null
+   hasMore: boolean
+ }
```
