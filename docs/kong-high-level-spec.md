# High Level Allocator Spec

The design is:

```
Envio indexing
      ↓
Kong ingestion and RPC enrichment
      ↓
One normalized allocation data model
      ├── GraphQL: flexible access to normalized data
      └── REST: fast, precomputed website responses
```

GraphQL and REST should share the same ingestion and enrichment work. They only present that data differently.

## What remains useful from the original spec

Most of the underlying structure in the [original Kong spec](https://hackmd.io/@murderteeth/rJkQlX-AWx) still works well for GraphQL.

|Original object|Recommendation|
|---|---|
|`vault`|Keep|
|`strategies`|Keep, but determine current status from RPC|
|`states`|Keep, including historical and current snapshots|
|`events`|Keep as the raw Envio evidence|
|`transitions`|Keep for atomic changes, but add a higher-level action/group object|
|`effects`|Keep as transaction or event-level operations|
|`doa`|Replace with a reusable allocation-policy model|
|`pendingDoaProposals`|Replace with policy application states such as unmatched or superseded|

The original normalized structure is therefore a good starting point for the GraphQL schema.

The largest addition is a new layer above individual transitions:

```
Allocation action
    ├── one or more transactions
    ├── atomic transitions/events
    ├── state before the whole action
    ├── state after the whole action
    ├── economic action kind
    ├── execution information
    └── related allocation policy
```

The new REST endpoint calls this an `entry`. GraphQL could call it `AllocationAction`, `AllocationEntry`, or `AllocationExecutionGroup`.

## What Kong should receive from Envio

Envio should own all blockchain indexing. Kong should not scan logs itself.

For each event, Kong needs:

- Chain, vault, and source contract
- Event name and decoded arguments
- Block number and timestamp
- Transaction hash and transaction index
- Log index
- Strategy address, when relevant
- Top-level transaction addresses and selector, when available

### Vault events

The original list is mostly correct:

- `DebtUpdated`
- `StrategyReported`
- `StrategyChanged`
- `UpdatedMaxDebtForStrategy`
- `DebtPurchased`
- `UpdateDefaultQueue`
- `UpdateUseDefaultQueue`
- `RoleSet`
- `RoleStatusChanged`
- `UpdateRoleManager`
- `UpdateAccountant`

We added:

- `Deposit`
- `Withdraw`

These are important context. They explain many debt changes, even though they do not normally create public allocation entries.

### Allocator events

Kong also needs:

- `NewDebtAllocator`
- `UpdateDebtAllocator`
- `UpdateStrategyDebtRatio`
- `UpdateStrategyDebtRatios`
- `UpdateKeeper`
- `GovernanceTransferred`

Envio should normalize both the old allocator and shared allocator event shapes. The shared allocator’s vault-indexed ratio changes are especially important for confirming policy applications.

### Coverage and checkpoint data

For production-quality output, Envio should also provide:

- Coverage start and validated-through blocks
- Whether the indexed range is safe for timeline use
- Known gaps
- Accounting checkpoints
- Unresolved checkpoint failures

## What Kong must fetch from RPC

Envio events tell Kong that something happened. They do not always prove the exact vault state around the action.

### Archive RPC reads

For an action at block `N`, Kong needs state reads at:

- `N - 1`: immediately before the action
- `N`: immediately after the action

For a group spanning several blocks:

- Before the first transaction
- After the last transaction

Each snapshot needs:

- `vault.totalAssets()`
- `vault.totalDebt()`
- `vault.totalIdle()`
- `vault.strategies(strategy)`
- The active debt allocator
- `allocator.getStrategyConfig(vault, strategy)`

Kong also needs historical RPC calls for:

- `shouldUpdateDebt(vault, strategy)` before an allocator action
- Transaction traces or equivalent call-path data
- Historical contract configuration when Envio does not contain the required event

### Current RPC reads

A normal current-state RPC can provide:

- Latest safe block
- Vault name, symbol, asset, and decimals
- Strategy names
- Current strategy activation status
- Current allocation snapshot

The same archive provider can provide these too, but they do not require old-state support.

## What changed in Kong’s processing

This is where the largest differences from the original spec are.

### 1. Before and after snapshots are action-specific

The original spec linked one event state to the previous event state.

We now read the state directly before and after each action. This prevents deposits, withdrawals, reports, and gains between two actions from being incorrectly included in the allocation change.

### 2. Several transitions can form one action

The original model was mainly block-based.

A keeper or manual operation can span several transactions and blocks. Kong should group them when call paths, allocator state, roles, timing, and state continuity support the grouping.

GraphQL should preserve both levels:

- Atomic transition or transaction
- Grouped allocation action

REST normally returns only the grouped action.

### 3. Economic result and execution source are separate

The original `kind` mixed these concepts.

The new common model should contain:

```
kind
  idle_deployment
  idle_deallocation
  strategy_reallocation
  configuration_change
  strategy_lifecycle_change

execution
  automation: automatic | manual | unknown
  mechanism: allocator_keeper | direct_vault_call | ...
  targetStatus: matched | overridden | unavailable
```

This separation should exist in the underlying model, not only in REST.

### 4. DOA becomes an allocation policy

A DOA proposal is a target-allocation policy. It is not itself an execution.

The better relationship is:

```
AllocationPolicy
    ├── target strategy ratios
    ├── expected APR information
    ├── publication time
    └── application evidence

AllocationAction
    └── policy relationship
        applied_in_action
        governing_policy
        historical_target_match
```

One policy can govern many later keeper actions.

### 5. Actor information requires enrichment

`transactionFrom` is not enough for Safe or relayed transactions.

Kong should combine:

- Envio transaction metadata
- RPC transaction traces
- Historical vault roles
- Allocator and keeper configuration

This produces separate fields for the originator, relayer, allocator, immediate vault caller, and authorization evidence.

### 6. Chart intervals require accounting processing

The flow ledger is mainly needed by REST chart consumers, but it should be calculated from the common normalized data.

It combines:

- Debt changes
- Deposits and withdrawals
- Reports and gains/losses
- Refunds
- Opening and closing RPC snapshots

Unknown changes remain `unattributed_asset_change`.

GraphQL can expose the underlying events and calculated interval. REST should receive the ready-to-render interval.

## Recommended GraphQL model

GraphQL should expose the normalized domain objects, with connections between them:

```
Vault {
  allocationStates(...)
  allocationActions(...)
  allocationPolicies(...)
  allocationIntervals(...)
  allocationSourceEvents(...)
}

AllocationAction {
  kind
  beforeState
  afterState
  transitions
  operations
  transactions
  execution
  policyRelationship
  interval
  classification
}

AllocationTransition {
  blockNumber
  transaction
  sourceEvents
  strategyChanges
}

AllocationPolicy {
  targets
  expectedAprImpact
  publishedAt
  applicationStatus
  governedActions
}
```

This is an extension of the original structure, not a complete replacement.

## Recommended REST model

REST should use the working shape from this prototype:

```
GET /api/rest/views/allocation-history/:chainId/:address
GET /api/rest/views/allocation-history/:chainId/:address?projection=chart
```

It should return:

- Pre-grouped entries
- Embedded before and after states
- Compact execution information
- Relevant policy information
- Reconciled chart intervals
- Stable cursor pagination

REST should not require clients to join strategies, states, transitions, policies, and events.

## Minimal Kong implementation

1. Keep indexing in Envio.
2. Extend the Envio input contract with deposit/withdrawal context and complete allocator events.
3. Add one Kong allocation materializer that:
    - Reads Envio
    - Reads historical RPC state
    - Adds traces and actor evidence
    - Builds states, transitions, grouped actions, policies, and intervals
    - Validates accounting
4. Store the normalized model in Kong’s database.
5. Resolve GraphQL from that normalized model.
6. Precompute the smaller REST entry and chart projections from the same model.

The most important architectural rule is:

> GraphQL and REST must not reconstruct allocation history separately. They should read different projections of the same enriched and validated materialization.

That gives Powerglove its fast REST shape while keeping Kong’s GraphQL flexible and internally consistent.