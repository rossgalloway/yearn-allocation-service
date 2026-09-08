# Allocation History: Main Changes from the Kong Spec

Reference: [Original Kong allocation history spec](https://hackmd.io/@murderteeth/rJkQlX-AWx)

This document is a short, standalone summary.

- [Complete proposed Kong specification](./kong-allocation-history-spec-proposed.md)
- [Redline against the original Kong specification](./kong-allocation-history-spec-redline.html)

## Goal

Envio indexes blockchain events. Kong enriches those events, builds one normalized allocation model, and serves it in two
ways:

- **GraphQL:** flexible access to normalized data and detailed evidence
- **REST:** a small, fast chart response for public websites

Both APIs read the same saved materialization run. They must not rebuild or classify history separately.

The first Kong milestone also fixes [allocator discovery and API correctness, #471](https://github.com/yearn/kong/issues/471).
Current allocator lookups and historical allocation processing share the same ordered assignment model. The current-data fix
can ship before the complete allocation-history feature.

```text
Blockchain
    ↓
Envio: events and indexing coverage
    ↓
Kong: RPC enrichment, grouping, classification, and validation
    ↓
One saved allocation model
    ├── GraphQL: detailed normalized data
    └── REST: precomputed chart data
```

## Data Kong gets from Envio

Envio is the only blockchain indexer. Kong does not scan logs itself.

For each event, Kong needs the chain, vault, source contract, decoded arguments, block and transaction order, transaction hash,
log index, and strategy address when relevant.

The original event list remains useful. The proposed contract also requires:

- `Deposit` and `Withdraw` as context for deposits, withdrawals, and debt changes
- Initial and replacement allocator assignments from `AddedNewVault` and `UpdateDebtAllocator`
- Factory deployment provenance, distinct from active vault assignments
- Legacy and shared-allocator strategy-ratio events
- Indexing coverage and known-gap records

Envio does not need to provide RPC-enriched accounting snapshots for this design. Kong gets exact historical state from archive
RPC. An Envio PR that adds the required event coverage is already open. Its event set and historical backfill are prerequisites
before production activation. The initial supported chains are Ethereum (`1`), Base (`8453`), and Katana (`747474`). Each chain
requires its own configured discovery sources, replay evidence, indexing progress, and known-gap records.

### Allocators can be any address

The vaults team confirmed that both initial and replacement debt allocators may be arbitrary addresses, including custom
contracts or addresses without contract code. Assignment is valid evidence even when Kong cannot read a familiar allocator
interface. Neither Envio nor Kong may require a recognized factory before preserving an assignment.

Envio registers assigned addresses with a discovery ABI covering the allocator event shapes it understands. This synthetic
`AssignedDebtAllocator` category is an indexing mechanism, not a claim that the address implements a particular contract.
It must cover both `AddedNewVault` and `UpdateDebtAllocator`, preserve registration across restart, and avoid narrowing capture
when factory provenance arrives later. Unknown event shapes remain outside supported coverage; an empty event stream does not
prove that the address is a supported allocator.

Factory evidence identifies the contract family and deployment:

- Vault-bound factories emit `NewDebtAllocator(allocator,vault)`.
- Shared factories emit `NewDebtAllocator(allocator,governance)`.

Both have the same canonical event signature, so the configured factory address and ABI determine the second argument's meaning.
Neither event establishes the currently active assignment.

Shared ratio events carry their own vault address. Shared keeper and governance events are stored once at allocator scope.
Events without enough association evidence remain unresolved. Kong reads vault-scoped, allocator-scoped, and unresolved evidence
and retains the source records when relating them to a vault's history.

## Data Kong gets from RPC

Envio proves which events happened. RPC reads prove the exact state and provide execution evidence.

For a single-block action, Kong reads state immediately before and after that block. For a multi-block action, Kong reads before
the first transaction and after the last transaction.

Archive RPC provides:

- Vault `totalAssets`, `totalDebt`, and `totalIdle`
- Strategy debt, activation, report time, and maximum debt
- Historical allocator assignments and strategy target and maximum ratios
- Historical `shouldUpdateDebt` results
- Transaction traces, call paths, and role evidence

Current RPC provides the latest safe block, current state, vault metadata, strategy names, and current strategy status. The same
RPC provider may serve both roles if it supports historical reads.

Configuration reads and `shouldUpdateDebt` replay select an adapter for the verified allocator family. Vault-bound methods
take a strategy; shared methods take a vault and strategy. Custom or code-free addresses keep their assignment while unsupported
configuration remains `null` with a reason. A successful zero ratio remains zero. RPC observations are recorded at their block
and do not overwrite the indexed assignment history.

## Shared Kong data model

Most of the original normalized model remains useful.

| Original object | Proposed treatment |
| --- | --- |
| `vault` | Keep. |
| `strategies` | Keep every strategy seen in history. Report its status at the latest safe block. |
| `states` | Keep. Add action-boundary states and the latest safe state. Each state contains the strategies known at that block. |
| `events` | Keep as normalized Envio evidence. |
| Allocator identities and deployments | Add contract family, discovery evidence, and optional factory provenance. |
| Vault allocator assignments | Add ordered initial/replacement assignments, Role Manager evidence, and resolution status. |
| `transitions` and `effects` | Keep for atomic block, transaction, and event changes. |
| `doa` | Replace a one-to-one execution annotation with a reusable allocation policy. |
| `pendingDoaProposals` | Use evidence-based `unmatched` or `superseded` states. Do not make a proposal stale only because it is old. |

The main addition is a grouped allocation action. REST calls its compact projection an entry.

```text
Allocation action
    ├── exact state before and after the whole action
    ├── one or more transitions and transactions
    ├── economic result
    ├── execution method and actors
    ├── configuration or lifecycle operations
    └── policy relationship, when known
```

## Main processing changes

### Read exact boundaries

Kong reads the state immediately before and after each action. It does not use the previous allocation action's final state as
the next action's initial state. Deposits, withdrawals, reports, gains, and losses may happen between actions.

### Group related transactions

One keeper or manual action can span several transactions and blocks. Kong groups transitions only when call paths, allocator
state, roles, timing, and state continuity support the relationship. Time alone is not enough.

A block-level transition may contain several transactions. Therefore it has `transactionHashes[]` and `effects[]`; each effect
keeps its own transaction and execution evidence.

### Separate result from execution

The economic `kind` says what changed: idle deployment, idle deallocation, strategy reallocation, configuration change, or
strategy lifecycle change.

Separate fields say how it happened:

- `execution.automation`: automatic, manual, mixed, or unknown
- `execution.mechanism`: allocator keeper, direct vault role, governance, or another path
- `execution.targetStatus`: matched, overridden, unavailable, or not applicable

For example, target maintenance is an automatic strategy reallocation under a matched policy. An allocator override is a
manual or non-policy strategy reallocation. Moving idle into one strategy remains an idle deployment, regardless of who calls
it.

Pure withdrawal-driven debt updates remain atomic evidence and interval flows, but do not become standalone allocation actions.
This filter does not remove manual emergency deallocations, governance or administrator actions, bad-debt purchases,
configuration changes, or lifecycle changes.

### Treat DOA as policy

A DOA proposal defines target allocations. It does not prove that execution happened. One policy can govern several later
actions.

Use two relationship names:

- `applied_in_action`: the action applied the policy configuration
- `governing_policy`: a later action executed under that active configuration

An archive-RPC target match can support `inferred_from_historical_config`, but it is not a third relationship type. DOA data is
optional enrichment, so its failure must not stop executed history from updating.

### Reconcile chart intervals

Every snapshot must satisfy:

```text
sum of strategy debt = total debt
total debt + total idle = total assets
```

For each idle or strategy node in a chart interval:

```text
opening balance
+ attributed inflows
- attributed outflows
+ unattributed balancing inflows
- unattributed balancing outflows
= closing balance
```

Amounts are raw underlying asset units. Deposits, withdrawals, and report refunds use the `external` boundary because they are
literal asset flows. Reported gains and losses use the `accounting` boundary because they do not imply an external token
transfer. Unknown balancing changes remain explicit `unattributed_asset_change` flows. `unattributedAmount` is the sum of their
absolute amounts.

The separate `unallocatedBps` field is a design choice for the Kong maintainer. The chart already provides `totalAssets` and
`totalIdle`, so it does not depend on that field.

## GraphQL output

GraphQL exposes the saved normalized model and its relationships:

- Vaults, the global strategy directory, and historical states
- Grouped actions, calculated changes, and atomic transitions
- Transactions, operations, and normalized Envio source events
- Policies and the actions they apply to or govern
- Traces, roles, allocator trigger replay, grouping evidence, and classification evidence
- Reconciled intervals, node residuals, and unattributed changes
- Coverage and data-quality information

GraphQL is the drill-down interface for investigation and detailed tools. Clients can select only the fields they need. Normal
queries do not repeat Envio ingestion or RPC enrichment. The Kong maintainer owns the final GraphQL query names, connections,
pagination, authorization, and rate limits.

The existing `vault.allocator` and `allocator(chainId,vault).address` fields must use the same saved assignment projection and
return the assigned address, including an unsupported custom address. Add assignment revision, as-of block, and support metadata;
refresh affected vault snapshots and caches together. The allocator query's `vault` is the lookup context: several vaults can
share one allocator. Historical requests remain pinned to the assignment evidence saved in their materialization run.

## REST output

The required REST surface is the public chart response:

```text
GET /api/rest/views/allocation-history/:chainId/:address?projection=chart
```

It returns:

- `runId`, so GraphQL can select the same immutable materialization
- Vault and strategy display information
- Visible strategy-reallocation entries with stable grouped-action IDs
- The raw after-state for each entry
- A current safe snapshot on the first page
- Automation, mechanism, and target-status labels
- Expected DOA APR data when available
- Reconciled interval flows containing hidden deposits, withdrawals, reports, idle movements, and other changes
- A stable cursor, newest-first by default, with optional oldest-first traversal

There is no required REST detail route. A client uses an entry's action ID and the response `runId` to request its exact before
and after states, calculated changes, transactions, operations, policy, traces, and evidence through GraphQL. REST requests read
saved data only; they do not call Envio or RPC. Kong should use its normal caching, CORS, validation, and response-compression
practices.

### Optional full REST projection

Kong may also support `projection=full` for clients that need complete denormalized entries without GraphQL. Each entry embeds
the whole-action `before`, `after`, and server-calculated `changes`, plus transitions, operations, execution information,
classification, and policy data. This is an optional compatibility surface, not a requirement for the chart design.

## Storage and refresh

The original spec proposed one Redis blob per vault. The new model needs queryable normalized storage for GraphQL and a saved
chart projection for REST. The exact database schema is left to the Kong maintainer.

Each materialization run is immutable. Kong validates a new run before activation, and a failed run leaves the previous run
active. Cursors remain pinned to one run.

Backfill and incremental refresh use the same ingestion, enrichment, grouping, classification, policy, interval, and validation
logic. Production operation requires incremental tail processing and an old-run retention policy. Supported vaults should be
discovered from Kong's Yearn V3 vault list instead of hardcoded.

## Delivery order

1. Complete Envio assignment discovery and evidence on Ethereum, Base, and Katana, including arbitrary assigned addresses.
2. Deliver Kong #471: import that evidence, resolve current assignments, read supported configuration, and migrate existing
   allocator APIs and saved vault data. Validate and activate this projection independently from full history.
3. Reuse those components for allocation-history snapshots, grouping, policy matching, GraphQL, and REST.

Implementation may proceed against pinned fixtures while upstream replay is prepared. Production activation requires verified
coverage for the relevant chain and vault. Envio supplies indexing evidence; Kong owns RPC enrichment and timeline certification.
