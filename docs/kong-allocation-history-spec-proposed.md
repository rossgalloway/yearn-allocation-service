# Vault Allocation History: Proposed Kong Specification

Based on: [Original Kong allocation history spec](https://hackmd.io/@murderteeth/rJkQlX-AWx)

This document presents the proposed specification with all changes applied.

## 1. Goal

Provide Kong API consumers with a vault-scoped allocation timeline that explains how debt was distributed across strategies over time, and what kind of activity produced each change.

Kong builds one enriched and validated allocation model. GraphQL exposes flexible normalized data and detailed evidence. REST exposes a fast, precomputed chart response for websites. Neither consumer needs to replay events or make archive RPC calls.

Envio owns blockchain indexing. Kong reads indexed data from Envio, performs RPC enrichment, and uses the same materialized data for GraphQL and REST.

## 2. Consumers

- **Primary:** yearn.fi (allocation flow chart, reallocation panel)
- **Secondary:** other Kong API clients
- GraphQL consumers that need detailed states, actions, policies, events, and execution evidence

## 3. Required outputs

For a given `(chainId, vault)`:

- **Vault metadata** — name, symbol, asset, decimals
- **Strategy directory** — every strategy seen during the materialized history, plus its status at the latest safe block
- **Allocation states** — exact snapshots immediately before and after each action, plus the latest safe snapshot
- **Atomic transitions** — transaction- or event-level changes with source-event references
- **Allocation actions** — one or more related transitions grouped into one economic action, with a before state, after state, operations, execution evidence, and transactions
- **Allocation policies** — DOA target policies with explicit relationships to one or more actions
- **Unapplied policies** with evidence-based status such as `unmatched` or `superseded`; age alone does not make a policy stale
- **Raw source events** available through GraphQL for investigation, but not included in the normal REST response
- **Execution provenance** — automation, mechanism, target match, actor, call path, role evidence, and limitations
- **Reconciled allocation intervals** — raw-unit flows between chart points, including explicit unattributed changes
- **Coverage and data quality** — certification, known gaps, and unavailable evidence

Kong stores a normalized allocation model for GraphQL and derives the REST chart projection from the same materialization run. A denormalized full REST projection is an optional extension. See the Appendix.

## 4. Timeline format

The output is an **event series**, not a timeseries. Rendering contract:

- Historical states are sampled at action boundaries: immediately before the first action transaction and after the last action transaction. Atomic event-block states may also be retained for GraphQL. No samples are required for inactive blocks.
- A vault with no activity for 30 days has zero state samples for that span.
- **Values are constant between consecutive states (step-function semantics).** Between state N and state N+1, the allocation is whatever state N held. State N+1 changes it.
- The live-tail state ends the series at "now." Its `blockNumber` / `blockTimestamp` come from the latest safe block used to compute it, not from response-generation time.
- Consumers wanting evenly-spaced x-axis samples must resample/interpolate themselves. The API does not produce uniform samples.
- One allocation action may span several transactions and blocks. Time proximity alone is not enough to group them.
- REST returns newest entries first by default and supports oldest-first traversal. GraphQL controls order through query arguments.
- A chart interval starts at one visible action's after state and ends at the next visible action's after state. Activity hidden from the public chart remains part of the interval accounting.

Without this contract, a chart renderer assuming timeseries semantics will draw incorrect plots.

## 5. Classification kinds

The top-level action kind describes the economic result:

`policy_application`, `idle_deployment`, `idle_deallocation`, `strategy_reallocation`, `unattributed_debt_update`, `configuration_change`, `strategy_lifecycle_change`, `bad_debt_purchase`, `current_snapshot`, `unknown`.

Execution provenance is separate from the action kind:

- `execution.automation`: `automatic`, `manual`, `mixed`, `unknown`, or not applicable
- `execution.mechanism`: `allocator_keeper`, `direct_vault_role`, `governance_safe`, `governance`, `role_manager`, `mixed`, or `unknown`
- `execution.targetStatus`: `matched`, `overridden`, `unavailable`, `not_applicable`, or `mixed`

Actor classification and evidence run per transaction. A policy relationship is separate from both the economic kind and execution provenance.

Useful presentation labels can be derived without adding more action kinds:

- **Target maintenance:** an automatic `strategy_reallocation` executed by an allocator keeper under a matched governing policy.
- **Allocator override:** a manual or otherwise non-policy `strategy_reallocation` whose allocator targets were overridden or unavailable.

Pure withdrawal-driven debt updates are context, not standalone allocation actions. They remain available as atomic transitions and contribute to interval accounting. This filter must not hide manual emergency deallocations, governance or administrator actions, bad-debt purchases, configuration changes, or strategy lifecycle changes; those remain grouped actions in GraphQL and, when enabled, the optional full REST projection.

## 6. Invariants

- Envio-indexed on-chain events are canonical execution evidence. Archive RPC reads are canonical snapshot evidence. DOA records are optional policy data and never create executed state by themselves.
- Every published snapshot reconciles exactly: `sum(strategy.currentDebt) = totalDebt` and `totalDebt + totalIdle = totalAssets`. Bps are computed from raw integers, not pre-rounded.
- The top-level strategy directory contains every strategy seen during the materialized history and reports status at the latest safe block. Each historical state uses the strategy universe known at that block, including revoked strategies with nonzero debt.
- State, transition, action, policy, and interval IDs are deterministic. Action IDs include the chain, vault, and action block range or equivalent stable transaction identity.
- Multiple relevant events in the same block collapse into one block-end state, with `effects[]` capturing each contributing event/transaction.
- Related transitions may form one multi-block action only when state continuity and execution evidence support the grouping.
- Frontend is render-only: response must not require archive RPC, event replay, or knowledge of internal storage.
- Every tracked idle and strategy node in a chart interval must reconcile independently. Unknown balancing changes remain explicit `unattributed_asset_change` flows.
- Missing values are `null`, not zero. Kong never invents a ratio when its required source evidence is unavailable.
- GraphQL and REST are projections of the same materialization run and must not classify or reconstruct the same action differently.

For every idle or strategy node in an interval:

```text
opening balance
+ attributed inflows
- attributed outflows
+ unattributed balancing inflows
- unattributed balancing outflows
= closing balance
```

`unattributedAmount` is the sum of the absolute amounts of all `unattributed_asset_change` flows. Deposits, withdrawals, and report refunds are literal flows through the `external` boundary. Reported gains and losses are accounting changes through the `accounting` boundary; they do not imply a token transfer. External and accounting boundaries do not have opening or closing balances.

## 7. Architecture

### 7.1 Data sources

- **Envio** — the only blockchain indexer. Kong reads a complete normalized event interface through Envio GraphQL. Each event includes decoded arguments, source contract, vault, block and transaction ordering, transaction hash, and strategy address when relevant. Envio also exposes indexing coverage and known gaps.
- `Deposit` and `Withdraw` are context events. They help explain debt changes but do not normally create allocation actions by themselves.
- Envio must normalize legacy and shared-allocator event shapes, including vault-specific allocator assignment and strategy-ratio changes.
- **DOA policy source** — optional policy targets, APR estimates, explanations, publication time, and immutable source identity. Its availability does not control whether executed history can update.
- **Archive RPC** — historical snapshot reads at action boundaries, allocator configuration, `shouldUpdateDebt` replay, and transaction traces. Required calls include `vault.totalAssets`, `vault.totalDebt`, `vault.totalIdle`, `vault.strategies(strategy)`, and shared allocator `getStrategyConfig(vault,strategy)`.
- **Current RPC** — latest safe block, current allocation, vault metadata, strategy names, and current strategy status. The archive provider may also serve these reads.

### 7.2 Storage

```typescript
type AllocationMaterializationRun = {
  id: string
  chainId: number
  vaultAddress: `0x${string}`
  generatedAt: number
  safeBlock: number
  coverage: AllocationDataQuality
  status: 'running' | 'succeeded' | 'failed'
}
```

Store normalized states, atomic transitions, grouped actions, policies, source evidence, and data quality for GraphQL. Store the compact REST chart projection from the same run. A full REST projection may be added as described in the REST addendum. Activate all enabled projections together only after validation.

REST cursors pin the immutable run, direction, projection, and last keyset position. A refresh cannot change an in-progress traversal.

Kong must persist the normalized model so GraphQL can query it without repeating Envio ingestion or RPC enrichment.

### 7.3 Refresh jobs

Use a background Kong materialization job with two modes:

- **Backfill:** reads complete Envio history, enriches it through RPC, validates it, and creates a new immutable run.
- **Incremental refresh:** updates an immutable historical prefix plus a mutable recent tail, then creates and activates a consistent new run.

Both modes use the same ingestion, enrichment, grouping, classification, policy, and validation functions.

Only one materialization may run for a vault at a time. A failed or interrupted run never replaces the last successful run. A full rebuild must produce the same result as incremental processing for the same safe block and source revisions.

An initial implementation may use complete replay, but production operation requires incremental tail processing and an explicit old-run retention policy.

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

The Kong implementation should discover supported Yearn V3 vaults through the vault list rather than hardcode a test-vault list.

### 7.5 GraphQL endpoint

Kong GraphQL reads the normalized active materialization run. It exposes paginated connections for strategies, states, grouped actions, atomic transitions, policies, intervals, and source events. Detailed trace, role, trigger-replay, grouping, and classification evidence is available when requested.

GraphQL must allow a client to select a materialization by `runId` and a grouped action by its stable action `id`. This is the drill-down path from a REST chart entry.

GraphQL may be slower and more flexible than REST, but it must not run a separate history reconstruction. Normal GraphQL reads should not repeat Envio ingestion or archive RPC enrichment.

### 7.6 REST endpoint

The required REST surface is the public chart response:

```text
GET /api/rest/views/allocation-history/:chainId/:address?projection=chart
```

It reads the active immutable materialization run from Kong storage. A REST request never calls Envio or RPC. Query parameters are:

- `limit`: number of returned entries; defaults to 25 and is limited to 1–100
- `direction`: `desc` for newest first (the default) or `asc` for oldest first
- `cursor`: opaque keyset cursor returned by the previous page; it is tied to the run, direction, and projection

`projection=chart` is the small public website response. It returns only visible strategy reallocations, a separate current snapshot on the first page, expected APR information when available, and reconciled intervals containing all hidden activity between visible points. It removes repeated states, names, percentages, transaction evidence, operations, and detailed residual equations. Those details remain in the normalized model used by GraphQL.

The chart response includes the immutable materialization `runId` and stable action IDs. A client can use those values to request detailed data through GraphQL. No separate REST detail route is required.

Each chart entry `id` is the corresponding grouped action ID. Interval `fromEntryId` and `toEntryId` values use those same IDs. The `runId` is selected with the active materialization and adds no Envio or RPC work at request time.

#### Optional full REST projection

Kong may also provide this response mode if existing REST consumers need complete denormalized entries without GraphQL:

```text
GET /api/rest/views/allocation-history/:chainId/:address?projection=full
```

Each full entry embeds its whole-action before and after states, calculated changes, grouped transitions, operations, execution information, classification, and matched policy when available. This projection is optional and does not replace flexible investigation through GraphQL.

The REST endpoint otherwise behaves like existing Kong endpoints:

- Same `Cache-Control` posture as existing REST routes (`max-age=900, s-maxage=900, stale-while-revalidate=600`)
- Provisional test data is marked clearly and uses `Cache-Control: no-store`; production Kong remains certified-only by default
- CORS headers
- Validates parameters and cursors, returns 400 on invalid input, and returns 404 when the requested vault, run, or entry is not materialized
- Uses Kong's normal response compression when required by payload size and existing deployment conventions

### 7.7 Code layout

Exact Kong paths should follow existing Kong conventions. Keep these responsibilities separate:

- Envio client and complete pagination
- RPC state reads, traces, and trigger replay
- Normalized allocation model and validation
- Atomic transition construction and multi-transaction action grouping
- Policy matching
- Interval-flow reconciliation
- Materialization storage and activation
- GraphQL resolvers
- REST chart projection and optional full-entry projection
- Tests for pure processing, database activation, GraphQL, and REST contracts

Kong's normal job system should invoke the materializer. Deployment details should follow Kong's existing operational model.

## 8. Constants

Do not use elapsed-time constants to decide whether a policy was applied or became stale. Policy status is based on on-chain configuration evidence and whether a newer policy superseded it.

A configurable execution-grouping time window may be supporting evidence, but never sufficient evidence. Grouping also requires compatible call paths, allocator configuration, roles, and state continuity.

## 9. DOA processing

One shared policy processor builds allocation policies and their relationships to actions:

1. Match the same `(chainId, vault)` and normalized strategy target set.
2. Mark policy application `confirmed` only when an indexed allocator configuration event exactly matches the targets.
3. Mark it `inferred_from_historical_config` when an archive-RPC configuration read exactly matches but the indexed application event is unavailable.
4. Treat keeper identity, debt direction, and timestamp proximity only as supporting evidence. They never confirm policy application alone.
5. Keep an applied policy active until a newer policy supersedes it. One policy may govern many later keeper actions. A policy relationship is `applied_in_action` when the action applies the configuration and `governing_policy` when a later action executes under that configuration.
6. Keep unapplied policies `unmatched` or `superseded`. Do not make them stale only because time passed.
7. Reprocess affected policy relationships when late Envio or DOA data arrives.

Both incremental and full refreshes call this function unchanged.

## 10. State materialization

Per atomic event block and grouped-action boundary:

1. **Candidate strategy universe** — all ever-seen strategies up to and including the block. Sources: `StrategyChanged`, `DebtUpdated`, `DebtPurchased`, `StrategyReported`, `UpdatedMaxDebtForStrategy`, default queue events, allocator ratio events. Do not drop revoked strategies; they may still hold non-zero debt and are needed for reconciliation.
2. Resolve the allocator from `NewDebtAllocator` and `UpdateDebtAllocator` history, confirmed by historical RPC when available.
3. **Archive reads at `N - 1` and `N`, or before the first and after the last block of a grouped action:**
   - `vault.totalAssets()`
   - `vault.totalDebt()`; validate it against the sum of strategy debt
   - `vault.totalIdle()`; do not silently synthesize a missing value for a published snapshot
   - `vault.strategies(s)` for each candidate strategy
   - shared allocator `getStrategyConfig(vault,s)` if an allocator exists at the block; decode membership, target ratio, and maximum ratio
4. **Bps from raw integers.** If `totalAssets == 0`, bps are 0; raw debts kept.
5. **Unavailable-value provenance.** Preserve raw RPC totals and use `null` for any enrichment whose required source evidence is unavailable.
6. **Execution evidence.** Read transaction traces, historical role evidence, and allocator `shouldUpdateDebt` results needed for later grouping and classification.
7. **Validation.** Require strategy-debt sum to equal total debt and total debt plus total idle to equal total assets before publication.

After all historical block-end states, materialize a live-tail state at the latest safe block using the same multicall set. Skip live-tail if it duplicates the last historical block.

REST exposes this live tail as a separate `currentSnapshot`. GraphQL retains it as a state with `stateGranularity: 'latest'`.

## 11. Required event sources

Envio must expose these for every Kong-supported chain:

- **V3 vault:** `Deposit`, `Withdraw`, `DebtUpdated`, `StrategyReported`, `StrategyChanged`, `UpdatedMaxDebtForStrategy`, `DebtPurchased`, `UpdateDefaultQueue`, `UpdateUseDefaultQueue`, `RoleSet`, `RoleStatusChanged`, `UpdateRoleManager`, `UpdateAccountant`
- **Debt manager factory:** `NewDebtAllocator`
- **Vault allocator assignment:** `UpdateDebtAllocator` or the equivalent event for the deployed vault version
- **Debt allocator:** both `UpdateStrategyDebtRatio` and `UpdateStrategyDebtRatios` contract variants, `UpdateKeeper`, `GovernanceTransferred`
- **Validation entities:** indexing coverage and known-gap metadata sufficient to prove that the required event range is complete

If Envio coverage is partial, indexing and backfilling the missing events upstream is a prerequisite to this work. An Envio event-coverage PR is already in progress; Kong implementation should begin only after its required event set and historical backfill are available.

Non-production environments may use explicitly marked provisional data for testing. Production Kong must not silently accept incomplete event coverage or failed RPC enrichment.

## 12. TBDs

- **Envio interface** — GraphQL is the proposed Kong input. Finalize the normalized event, coverage, pagination, authentication, and network contract between Envio and Kong.
- **Envio coverage** — add the §11 context and shared-allocator events, certify each supported chain, and backfill missing history before production activation.

```typescript
type AllocationPolicy = {
  id: string
  source: 'doa'
  sourceKey: string
  publishedAt: number
  baselineAprBps: number | null
  proposedAprBps: number | null
  explain: string | null
  targets: AllocationPolicyTarget[]
  application: PolicyApplication
}
```

- **Actor evidence** — define how Kong obtains keeper labels, Safe and relayer identities, historical vault role masks, and allocator address history for every chain.
- **Kong GraphQL schema** — the Kong maintainer owns the final query names, connections, pagination, authorization, and rate limits for normalized states, actions, policies, events, traces, roles, and intervals.
- **Normalized storage** — decide which normalized Envio and RPC evidence Kong persists so GraphQL does not repeat expensive enrichment work.
- **Incremental materialization** — define the immutable historical prefix, mutable tail, reclassification window, cursor lifetime, and old-run retention policy.
- **Unlimited max debt** — define a safe GraphQL and REST representation for `uint256.max` without JavaScript number loss.
- **Unallocated ratio** — decide whether the normalized model needs a distinct `unallocatedBps` field. The chart already exposes raw `totalAssets` and `totalIdle`; it must not depend on Envio RPC-enriched checkpoints.

## 13. Acceptance

Feature is complete when:

1. Kong materializes one validated normalized history and serves it through GraphQL plus the REST chart projection. A full REST projection is optional.
2. All invariants in §6 hold.
3. All event sources in §11 are reflected in classification and state.
4. DOA records create policies and evidence-based relationships to actions. No DOA record creates executed state.
5. Incremental and full materialization produce equivalent normalized and projected output for the same `(chainId, vault, safeBlock, source revisions)`. Drift is a bug.
6. Every action has a clear whole-group before and after state. Multi-transaction grouping discloses its evidence and limitations.
7. Economic kind, automation, mechanism, allocator-target match, and policy relationship are independent fields.
8. Every published state satisfies the exact accounting identities. Every chart interval balances each tracked strategy and idle node.
9. REST requests use only materialized storage and do not call Envio, RPC, or DOA services at request time.
10. GraphQL and REST resolve from the same materialization run and agree on shared state, action, policy, and evidence fields.
11. Failed or incomplete materialization never replaces the last successful active run.
12. Production data fails closed when Envio event coverage, archive RPC reads, or accounting validation is incomplete.

## Appendix — Type definitions

All timestamps are unix seconds, UTC.

The normalized model and REST projections are defined below.

```typescript
type Address = `0x${string}`
type Hash = `0x${string}`

// Shared normalized model used by GraphQL and REST materialization.
type VaultAllocationModel = {
  generatedAt: number
  runId: string
  dataQuality: AllocationDataQuality
  vault: VaultAllocationVault
  strategies: AllocationHistoryStrategy[]
  states: AllocationState[]
  actions: AllocationAction[]
  transitions: AllocationTransition[]
  policies: AllocationPolicy[]
  intervals: AllocationInterval[]
  events: AllocationSourceEvent[]
}

type AllocationDataQuality = {
  certification: 'certified' | 'provisional'
  coverageStartBlock: number
  validatedThroughBlock: number
  safeBlock: number
  coverageRevision: string
  limitations: string[]
}

type VaultAllocationVault = {
  chainId: number
  address: Address
  name: string | null
  symbol: string | null
  assetAddress: Address | null
  assetSymbol: string | null
  assetDecimals: number | null
}

type AllocationHistoryStrategy = {
  address: Address
  name: string | null
  status: 'active' | 'inactive' | 'unknown'
  statusReadAtBlock: number
}

type AllocationState = {
  id: string
  stateGranularity: 'block_end' | 'action_before' | 'action_after' | 'latest'
  blockNumber: number
  blockTimestamp: number
  source: 'archive_rpc'
  totalAssets: string
  totalDebt: string
  totalIdle: string | null
  allocatorAddress: Address | null
  sourceEventIds: string[]
  strategies: AllocationStateStrategy[]
  accountingChecks: {
    strategyDebtSumEqualsTotalDebt: boolean
    totalAssetsEqualsDebtPlusIdle: boolean | null
  }
}

type AllocationStateStrategy = {
  strategyAddress: Address
  currentDebt: string
  currentDebtBps: number
  maxDebt: string | null
  maxDebtBps: number | null
  targetDebtRatioBps: number | null
  maxDebtRatioBps: number | null
  allocatorAdded: boolean | null
  activation: number | null
  lastReport: number | null
}

type AllocationTransitionKind =
  | 'allocator_execution'
  | 'deposit_driven_debt_update'
  | 'withdrawal_driven_debt_update'
  | 'manual_debt_update'
  | 'manual_config_change'
  | 'report_only_state_change'
  | 'strategy_lifecycle_change'
  | 'bad_debt_purchase'
  | 'vault_deposit'
  | 'vault_withdrawal'
  | 'unknown'

type AllocationActionKind =
  | 'policy_application'
  | 'idle_deployment'
  | 'idle_deallocation'
  | 'strategy_reallocation'
  | 'unattributed_debt_update'
  | 'configuration_change'
  | 'strategy_lifecycle_change'
  | 'bad_debt_purchase'
  | 'current_snapshot'
  | 'unknown'

type ActorClassification = {
  address: Address | null
  role:
    | 'doa_keeper'
    | 'debt_allocator_keeper'
    | 'governance'
    | 'management'
    | 'role_manager'
    | 'vault_role_holder'
    | 'unknown'
  label: string | null
}

type AllocationTransaction = {
  transactionHash: Hash
  blockNumber: number
  blockTimestamp: number
  originator: ActorClassification
  transactionTarget: Address | null
  inputSelector: Hash | null
  callPath: Address[]
  traceStatus: 'available' | 'unavailable'
  immediateVaultCaller: Address | null
  authorization: {
    roles: string[]
    roleMask: string | null
    confirmedAtBlock: boolean | null
  }
  sourceEventIds: string[]
  triggerReplays: AllocatorTriggerReplay[]
  vaultActivities: VaultActivity[]
}

type AllocationTransition = {
  id: string
  kind: AllocationTransitionKind
  fromStateId: string | null
  toStateId: string
  blockNumber: number
  blockTimestamp: number
  transactionHashes: Hash[]
  effects: AllocationTransitionEffect[]
}

type AllocationTransitionEffect = {
  kind: AllocationTransitionKind
  transactionHash: Hash
  sourceEventIds: string[]
  operationIds: string[]
  actor: ActorClassification
  transactionTarget: Address | null
  inputSelector: Hash | null
  traceStatus: 'available' | 'unavailable'
  callPath: Address[]
  immediateVaultCaller: Address | null
  authorization: {
    roles: string[]
    roleMask: string | null
    confirmedAtBlock: boolean | null
  }
  triggerReplays: AllocatorTriggerReplay[]
  vaultActivities: VaultActivity[]
}

type AllocationOperation = {
  id: string
  kind:
    | 'strategy_added'
    | 'strategy_retired'
    | 'max_debt_updated'
    | 'allocator_strategy_configured'
    | 'vault_configuration_updated'
  source: 'envio_event' | 'archive_rpc_diff'
  sourceEventIds: string[]
  subjectAddress: Address | null
  changes: Array<{ field: string; before: unknown; after: unknown }>
}

type AllocationExecution = {
  automation: 'automatic' | 'manual' | 'mixed' | 'unknown' | null
  mechanism:
    | 'allocator_keeper'
    | 'direct_vault_role'
    | 'governance_safe'
    | 'governance'
    | 'role_manager'
    | 'mixed'
    | 'unknown'
    | null
  targetStatus: 'matched' | 'overridden' | 'unavailable' | 'not_applicable' | 'mixed' | null
  transactions: AllocationTransaction[]
}

type AllocationAction = {
  id: string
  kind: AllocationActionKind
  startBlock: number
  endBlock: number
  startTimestamp: number
  endTimestamp: number
  beforeStateId: string | null
  afterStateId: string
  transitionIds: string[]
  operationIds: string[]
  changes: AllocationChanges
  policyRelationship: AllocationPolicyRelationship | null
  execution: AllocationExecution
  classification: {
    confidence: 'high' | 'medium' | 'low'
    evidence: string[]
    limitations: string[]
  }
}

type AllocationChanges = {
  totalDebtDelta: string | null
  totalIdleDelta: string | null
  strategies: Array<{
    strategyAddress: Address
    currentDebtBefore: string | null
    currentDebtAfter: string | null
    currentDebtDelta: string | null
    maxDebtBefore: string | null
    maxDebtAfter: string | null
    maxDebtDelta: string | null
    currentDebtBpsBefore: number | null
    currentDebtBpsAfter: number | null
    currentDebtBpsDelta: number | null
    targetDebtRatioBpsBefore: number | null
    targetDebtRatioBpsAfter: number | null
    maxDebtRatioBpsBefore: number | null
    maxDebtRatioBpsAfter: number | null
    activeBefore: boolean | null
    activeAfter: boolean | null
  }>
}

type AllocationPolicyTarget = {
  strategyAddress: Address
  currentRatioBps: number | null
  targetRatioBps: number | null
  maxRatioBps: number | null
  currentAprBps: number | null
  targetAprBps: number | null
}

type PolicyApplication =
  | {
      status: 'confirmed'
      blockNumber: number
      transactionHash: Hash
      sourceEventIds: string[]
    }
  | {
      status: 'inferred_from_historical_config'
      blockNumber: null
      transactionHash: null
      sourceEventIds: []
    }
  | {
      status: 'unmatched' | 'superseded'
      blockNumber: null
      transactionHash: null
      sourceEventIds: []
    }

type AllocationPolicy = {
  id: string
  source: 'doa'
  sourceKey: string
  publishedAt: number
  baselineAprBps: number | null
  proposedAprBps: number | null
  explain: string | null
  targets: AllocationPolicyTarget[]
  application: PolicyApplication
}

type AllocationPolicyRelationship = {
  policyId: string
  relationship: 'applied_in_action' | 'governing_policy'
}

type AllocatorTriggerReplay = {
  strategyAddress: Address
  allocatorAddress: Address
  readAtBlock: number
  status: 'matched' | 'not_matched' | 'unavailable'
  shouldUpdate: boolean | null
  expectedDebt: string
  recommendedDebt: string | null
  absoluteDifference: string | null
  matchTolerance: string
  reason: string | null
}

type VaultActivity = {
  kind: 'deposit' | 'withdrawal'
  path: 'direct' | 'routed'
  sender: Address | null
  receiver: Address | null
  owner: Address | null
  assets: string | null
  shares: string | null
  transactionHash: Hash
  sourceEventId: string
}

type AllocationBalanceNode =
  | { type: 'idle' }
  | { type: 'strategy'; address: Address; name: string | null }

type AllocationBoundaryNode =
  | { type: 'external' }
  | { type: 'accounting' }

type AllocationNode = AllocationBalanceNode | AllocationBoundaryNode

type AllocationChartNode =
  | { type: 'idle' }
  | { type: 'strategy'; address: Address }
  | AllocationBoundaryNode

type AllocationFlow = {
  source: AllocationNode
  target: AllocationNode
  amount: string
  kind:
    | 'idle_deployment'
    | 'idle_deallocation'
    | 'strategy_reallocation'
    | 'deposit'
    | 'withdrawal'
    | 'reported_gain'
    | 'reported_loss'
    | 'report_refund'
    | 'bad_debt_purchase'
    | 'unattributed_asset_change'
  attribution: 'observed_event' | 'derived_from_debt_updates' | 'residual_balance'
}

type AllocationInterval = {
  id: string
  fromEntryId: string
  toEntryId: string | null
  endKind: 'allocation_entry' | 'safe_head'
  startStateId: string
  endStateId: string
  flows: AllocationFlow[]
  reconciliation: {
    openingTotalAssets: string
    closingTotalAssets: string
    balanceStatus: 'reconciled' | 'unreconciled'
    attributionStatus: 'complete' | 'partial'
    unattributedAmount: string
    residuals: AllocationNodeResidual[]
  }
}

type AllocationNodeResidual = {
  node: AllocationBalanceNode
  openingBalance: string
  attributedInflows: string
  attributedOutflows: string
  unattributedInflows: string
  unattributedOutflows: string
  closingBalance: string
  residualAmount: string
}

type AllocationSourceEvent = {
  id: string
  chainId: number
  vaultAddress: Address
  sourceAddress: Address
  sourceLabel: 'vault' | 'debtAllocator' | 'debtManagerFactory' | 'unknown'
  eventName: string
  signature: Hash
  blockNumber: number
  blockTimestamp: number
  transactionHash: Hash
  transactionIndex: number
  logIndex: number
  transactionFrom: Address | null
  transactionTo: Address | null
  inputSelector: Hash | null
  strategyAddress: Address | null
  args: Record<string, unknown>
}

// Denormalized REST projection. Full entry fields may be expanded without
// changing the normalized GraphQL model.
type VaultAllocationRestResponse = {
  projection: 'full'
  generatedAt: number
  runId: string
  direction: 'asc' | 'desc'
  dataQuality: AllocationRestDataQuality
  vault: VaultAllocationVault
  entries: AllocationRestEntry[]
  pagination: AllocationPagination
}

type VaultAllocationChartResponse = {
  projection: 'chart'
  generatedAt: number
  runId: string
  direction: 'asc' | 'desc'
  dataQuality: AllocationRestDataQuality
  vault: Pick<VaultAllocationVault, 'chainId' | 'address' | 'name'>
  strategies: Record<Address, string | null>
  boundaryStates: Record<string, AllocationChartState>
  currentSnapshot: AllocationChartCurrentSnapshot | null
  entries: AllocationChartEntry[]
  pagination: { nextCursor: string | null }
}

type AllocationRestDataQuality = Pick<AllocationDataQuality, 'certification' | 'limitations'>

type AllocationRestEntry = AllocationAction & {
  before: AllocationState | null
  after: AllocationState
  transitions: AllocationTransition[]
  operations: AllocationOperation[]
  policy: AllocationPolicy | null
}

type AllocationChartEntry = {
  id: string
  kind: 'strategy_reallocation'
  endBlock: number
  endTimestamp: number
  after: AllocationChartState
  execution: Pick<AllocationExecution, 'automation' | 'mechanism' | 'targetStatus'>
  expectedAprImpact: ExpectedAprImpact
  interval: AllocationChartInterval | null
}

type AllocationChartCurrentSnapshot = AllocationChartState & {
  id: string
  kind: 'current_snapshot'
  interval: AllocationChartInterval | null
}

type AllocationChartState = {
  blockNumber: number
  blockTimestamp: number
  totalAssets: string
  totalIdle: string | null
  allocations: Array<{ strategyAddress: Address; currentDebt: string }>
}

type AllocationChartInterval = {
  fromEntryId: string
  toEntryId: string | null
  endKind: 'allocation_entry' | 'safe_head'
  flows: Array<Omit<AllocationFlow, 'source' | 'target'> & {
    source: AllocationChartNode
    target: AllocationChartNode
  }>
  reconciliation: Pick<
    AllocationInterval['reconciliation'],
    'balanceStatus' | 'attributionStatus' | 'unattributedAmount'
  >
}

type ExpectedAprImpact =
  | {
      status: 'available'
      source: 'doa'
      scope: 'proposal'
      baselineAprBps: number
      proposedAprBps: number
      deltaAprBps: number
      policyId: string
      publishedAt: number
      relationship: 'applied_in_action' | 'governing_policy'
      applicationStatus: 'confirmed' | 'inferred_from_historical_config'
    }
  | {
      status: 'unavailable'
      reason: 'no_matched_doa_policy' | 'policy_apr_unavailable'
    }

type AllocationPagination = {
  limit: number
  nextCursor: string | null
  hasMore: boolean
}
```
