# Vault Allocation History — Spec (Re-spec of Kong #396)

## 1. Goal

Provide Kong API consumers with a vault-scoped allocation timeline that explains how debt was distributed across strategies over time, and what kind of activity produced each change. Consumers render charts/panels directly from the response, with no event replay or archive RPC calls of their own.

## 2. Consumers

- **Primary:** yearn.fi (allocation flow chart, reallocation panel)
- **Secondary:** other Kong API clients

## 3. Required outputs

For a given `(chainId, vault)`:

- **Vault metadata** — name, symbol, asset, decimals
- **Strategy directory** — every strategy ever interacted with, plus current activity status
- **Allocation states** — block-end snapshots of debt distribution
- **Allocation transitions** — what changed between consecutive states, classified by intent, with actor metadata and `effects[]` for mixed same-block activity
- **DOA annotations** on transitions where a matched proposal explains the change
- **Pending DOA proposals** with status (`pending` / `unmatched` / `stale`)
- **Raw source events** (optional, debug only)

Response uses the `VaultAllocationTimeline` schema (see Appendix).

## 4. Timeline format

The output is an **event series**, not a timeseries. Rendering contract:

- States are sampled only at blocks where relevant events fired. No samples for inactive blocks.
- A vault with no activity for 30 days has zero state samples for that span.
- **Values are constant between consecutive states (step-function semantics).** Between state N and state N+1, the allocation is whatever state N held. State N+1 changes it.
- The live-tail state ends the series at "now." Its `blockNumber` / `blockTimestamp` come from the latest safe block used to compute it, not from response-generation time.
- Consumers wanting evenly-spaced x-axis samples must resample/interpolate themselves. The API does not produce uniform samples.

Without this contract, a chart renderer assuming timeseries semantics will draw incorrect plots.

## 5. Classification kinds

`doa_execution`, `allocator_execution`, `manual_debt_update`, `manual_config_change`, `report_only_state_change`, `strategy_lifecycle_change`, `bad_debt_purchase`, `current_live_tail`, `unknown`.

Classification is DOA-aware: a transition matching a DOA proposal AND containing an on-chain debt update is `doa_execution`. Actor classification runs per-effect within a transition.

## 6. Invariants

- On-chain events are canonical truth. DOA records are annotations only; a DOA record alone never produces an executed state.
- Historical states reconcile to on-chain truth: `sum(strategy.currentDebt) + totalIdle ≈ totalAssets` at the relevant block. Bps computed from raw integers, not pre-rounded.
- Strategy directory at any historical block includes all strategies ever seen up to that block, including revoked-with-nonzero-debt.
- State and transition IDs are deterministic, derivable from `(chainId, vault, blockNumber)`.
- Multiple relevant events in the same block collapse into one block-end state, with `effects[]` capturing each contributing event/transaction.
- Frontend is render-only: response must not require archive RPC, event replay, or knowledge of internal storage.

## 7. Architecture

### 7.1 Data sources

- **Envio (self-hosted)** — event logs + transaction-level data (`tx.from`, `tx.to`, function selector). Connection details, schema, and query interface — see §12 (TBD).
- **DOA proposal source** — see §12 (TBD). Needs a defined contract before implementation.
- **Archive RPC** — viem clients constructed inside the refresh script for state reconciliation multicalls (`vault.totalAssets`, `vault.totalDebt`, `vault.totalIdle`, `vault.strategies(s)`, allocator ratios). RPC URLs provisioned per chain as GitHub Actions secrets.

### 7.2 Storage

One Redis key per vault:

- `allocation-history:{chainId}:{vaultLower}:blob`

Blob extends `VaultAllocationTimeline` (Appendix) with internal cursors that the route strips on read:

```ts
type AllocationHistoryBlob = VaultAllocationTimeline & {
  lastProcessedBlock: number
  lastProcessedDoaTimestamp: number  // unix seconds
}
```

The trailing entry of `states` is the live tail when present (`stateGranularity: 'latest'`); the trailing entry of `transitions` is the live tail when present (`kind: 'current_live_tail'`). Two cursors because on-chain events and DOA records run on different clocks.

### 7.3 Refresh jobs — GitHub Actions

Two scheduled workflows:

- **Full rebuild — weekly.** Rebuilds blob from each vault's `inceptBlock`. Validates that incremental output matches a from-scratch rebuild.
- **Incremental — hourly.** Reads events strictly newer than `lastProcessedBlock` and DOA proposals strictly newer than `lastProcessedDoaTimestamp`. Materializes new states, runs DOA processing (matching + aging), updates watermarks, writes blob.

Both call the same shared `refresh(vault, mode: 'full' | 'incremental')` function.

Concurrency: GH Actions `concurrency:` blocks with `cancel-in-progress: false`. If hourly fires while weekly is running, hourly queues until weekly completes.

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

### 7.5 REST endpoint

Lives at `packages/web/app/api/rest/views/allocation-history/[chainId]/[address]/route.ts`. Behaves like other Kong REST endpoints:

- Reads `allocation-history:{chainId}:{vaultLower}:blob`, strips internal cursor fields, returns the result
- Same `Cache-Control` posture as existing REST routes (`max-age=900, s-maxage=900, stale-while-revalidate=600`)
- CORS headers
- Validates params, returns 400 on invalid, 404 on missing cache

### 7.6 Code layout

All under `packages/web/app/api/rest/views/allocation-history/`:

- `[chainId]/[address]/route.ts` — REST endpoint
- `refresh.ts` — shared refresh function (`refresh(vault, mode)`)
- `materialize.ts` — archive multicall + state construction at a block
- `classify.ts` — transition classifier, DOA-aware finalization
- `doa.ts` — DOA processing (matching, aging, status)
- `envio.ts` — Envio query helpers (TBD)
- `redis.ts` — blob read/write helpers
- `shape.ts` — derive public response from blob
- `types.ts` — shared types
- `*.spec.ts` — tests alongside

GH Actions workflow at `.github/workflows/allocation-history.yml` invokes the refresh via a bun-executed entrypoint.

## 8. Constants

In `packages/web/app/api/rest/views/allocation-history/doa.ts`:

- `maxDoaProposalPublishingLagHours = 24` — DOA may publish a proposal record up to this long after the corresponding on-chain execution.
- `expectedDoaProposalExecutionWindowHours = 72` — A fresh DOA proposal is expected to execute on-chain within this window.
- `staleDoaProposalThresholdDays = 30` — Past this age, an unmatched DOA proposal is considered stale.

## 9. DOA processing

Single shared pure function `processDoa(proposals, transitions, now)`:

- **Matching:** for each unmatched proposal, find candidate transitions in the past `maxDoaProposalPublishingLagHours`. Signals (strongest first):
  1. Same `(chainId, vault)`
  2. Allocator `UpdateStrategyDebtRatios` target ratios match proposal target ratios
  3. Co-occurring `DebtUpdated` direction matches proposal targets
  4. Transaction path matches DOA keeper/applicator address set
  5. Event timestamp near proposal timestamp
- **Aging:** for each unmatched proposal, status from `now - proposal_time`:
  - `pending` if `≤ expectedDoaProposalExecutionWindowHours`
  - `unmatched` if `≤ staleDoaProposalThresholdDays`
  - `stale` otherwise (also stale if superseded by a newer proposal targeting the same set, or removed from upstream)
- **Late-arrival re-match:** when new DOA records appear, transitions within the `maxDoaProposalPublishingLagHours` window are re-classified — already-stored `manual_debt_update` / `allocator_execution` transitions can be upgraded to `doa_execution`.

Both incremental and full refreshes call this function unchanged.

## 10. State materialization

Per relevant block:

1. **Candidate strategy universe** — all ever-seen strategies up to and including the block. Sources: `StrategyChanged`, `DebtUpdated`, `DebtPurchased`, `StrategyReported`, `UpdatedMaxDebtForStrategy`, default queue events, allocator ratio events. Do not drop revoked strategies; they may still hold non-zero debt and are needed for reconciliation.
2. **Allocator resolution** — debt allocator at the block from `NewDebtAllocator` history at or before that block.
3. **Archive multicall at `blockNumber`:**
   - `vault.totalAssets()`
   - `vault.totalDebt()` (fall back to summing strategy debts if not exposed)
   - `vault.totalIdle()` (fall back to `max(totalAssets - totalDebt, 0)`; flag as computed in logs)
   - `vault.strategies(s)` for each candidate strategy
   - allocator `getStrategyTargetRatio(s)` and `getStrategyMaxRatio(s)` if allocator exists at the block
4. **Bps from raw integers.** If `totalAssets == 0`, bps are 0; raw debts kept.

After all historical block-end states, materialize a live-tail state at the latest safe block using the same multicall set. Skip live-tail if it duplicates the last historical block.

## 11. Required event sources

Envio must expose these for every Kong-supported chain:

- **V3 vault:** `DebtUpdated`, `StrategyReported`, `StrategyChanged`, `UpdatedMaxDebtForStrategy`, `DebtPurchased`, `UpdateDefaultQueue`, `UpdateUseDefaultQueue`, `RoleSet`, `RoleStatusChanged`, `UpdateRoleManager`, `UpdateAccountant`
- **Debt manager factory:** `NewDebtAllocator`
- **Debt allocator:** `UpdateStrategyDebtRatios`, `UpdateKeeper`, `GovernanceTransferred`

If Envio coverage is partial, indexing the missing events upstream is a prerequisite to this work.

## 12. TBDs (block implementation)

- **Envio interface** — connection (GraphQL? direct Postgres?), schema, auth, network access from the GH Actions runner. Owner: ?
- **Envio coverage** — confirm every event in §11 is indexed across all six chains; backfill missing ones if not.
- **DOA proposal interface** — confirm doa type inteface
```
type DoaAnnotation = {
  sourceKey: string
  proposalTimestamp: number
  optimizerCurrentApr: number | null
  optimizerProposedApr: number | null
  explain: string | null
  strategyTargets: Array<{
    strategyAddress: `0x${string}`
    currentRatioBps: number | null
    targetRatioBps: number | null
    currentApr?: number | null
    targetApr?: number | null
  }>
  matchReason: string
}
```
- **Address labels** — per-chain keeper/applicator addresses for actor classification


## 13. Acceptance

Feature is complete when:

1. `GET /api/rest/views/allocation-history/:chainId/:address` returns a `VaultAllocationTimeline` derived from the cached blob.
2. All invariants in §6 hold.
3. All event sources in §11 are reflected in classification and state.
4. DOA records are returned as annotations or as `pendingDoaProposals` per §9; no DOA record creates an executed state.
5. Hourly incremental and weekly full rebuild produce equivalent output for the same `(chainId, vault)`. Drift between them is a bug.

## Appendix — Type definitions

All timestamps are unix seconds, UTC.

```ts
type VaultAllocationTimeline = {
  schemaVersion: 1
  generatedAt: number
  vault: VaultAllocationVault
  strategies: AllocationHistoryStrategy[]
  states: AllocationState[]
  transitions: AllocationTransition[]
  pendingDoaProposals?: DoaProposal[]
  events?: AllocationSourceEvent[]
}

type VaultAllocationVault = {
  chainId: number
  address: `0x${string}`
  name: string | null
  symbol: string | null
  assetAddress: `0x${string}` | null
  assetSymbol: string | null
  assetDecimals: number | null
}

type AllocationHistoryStrategy = {
  address: `0x${string}`
  name: string | null
  status: 'active' | 'inactive' | 'unknown'
}

type AllocationState = {
  id: string
  stateGranularity: 'block_end' | 'latest'
  blockNumber: number
  blockTimestamp: number
  transactionHash: `0x${string}` | null
  totalAssets: string
  totalDebt: string
  totalIdle: string | null
  unallocatedBps: number
  sourceEventIds: string[]
  strategies: AllocationStateStrategy[]
}

type AllocationStateStrategy = {
  strategyAddress: `0x${string}`
  currentDebt: string
  currentDebtBps: number
  maxDebt: string | null
  maxDebtBps: number | null
  targetDebtRatioBps: number | null
  maxDebtRatioBps: number | null
  activation: number | null
  lastReport: number | null
}

type AllocationTransitionKind =
  | 'doa_execution'
  | 'allocator_execution'
  | 'manual_debt_update'
  | 'manual_config_change'
  | 'report_only_state_change'
  | 'strategy_lifecycle_change'
  | 'bad_debt_purchase'
  | 'current_live_tail'
  | 'unknown'

type ActorClassification = {
  address: `0x${string}` | null
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

type AllocationTransitionEffect = {
  kind: AllocationTransitionKind
  sourceEventIds: string[]
  transactionHash: `0x${string}`
  transactionFrom: `0x${string}` | null
  transactionTo: `0x${string}` | null
  inputSelector: `0x${string}` | null
  actor: ActorClassification
}

type AllocationTransition = {
  id: string
  kind: AllocationTransitionKind
  fromStateId: string | null
  toStateId: string
  blockNumber: number
  blockTimestamp: number
  transactionHashes: `0x${string}`[]
  effects: AllocationTransitionEffect[]
  doa?: DoaAnnotation
}

type AllocationSourceEvent = {
  id: string                         // `${chainId}:${transactionHash}:${logIndex}`
  sourceAddress: `0x${string}`       // vault, debt allocator, manager, etc.
  sourceLabel: 'vault' | 'debtAllocator' | 'debtManagerFactory' | 'unknown'
  eventName: string
  signature: `0x${string}`
  blockNumber: number
  blockTimestamp: number
  transactionHash: `0x${string}`
  transactionIndex: number
  logIndex: number
  transactionFrom: `0x${string}` | null
  transactionTo: `0x${string}` | null
  inputSelector: `0x${string}` | null  // first 4 bytes, e.g. 0x12345678
  strategyAddress?: `0x${string}` | null
  args: Record<string, unknown>
}

type DoaAnnotation = {
  sourceKey: string
  proposalTimestamp: number
  optimizerCurrentApr: number | null
  optimizerProposedApr: number | null
  explain: string | null
  strategyTargets: Array<{
    strategyAddress: `0x${string}`
    currentRatioBps: number | null
    targetRatioBps: number | null
    currentApr?: number | null
    targetApr?: number | null
  }>
  matchReason: string
}

type DoaProposal = DoaAnnotation & {
  status: 'pending' | 'unmatched' | 'stale'
}
```
