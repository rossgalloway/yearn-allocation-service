# Allocation History: Main Changes from the Kong Spec

Reference: [Original Kong allocation history spec](https://hackmd.io/@murderteeth/rJkQlX-AWx)

See [kong-allocation-history-spec-redline.md](./kong-allocation-history-spec-redline.md) for a complete manual diff against
the original text.

## Goal

Envio should index blockchain events. Kong should enrich those events, build one normalized allocation model, and serve that
model in two ways:

- **GraphQL:** flexible and detailed queries
- **REST:** fast, limited responses for websites and charts

GraphQL and REST should use the same enriched and validated data and not rebuild the history separately.

```text
Blockchain
    ↓
Envio indexing and GraphQL
    ↓
Kong RPC enrichment and processing
    ↓
One normalized allocation model
    ├── GraphQL: normalized data and detailed evidence
    └── REST: precomputed entries and chart data
```

## Data Kong gets from Envio

Envio owns event indexing. Kong should not scan blockchain logs itself.

For every event, Kong needs the chain, vault, source contract, decoded arguments, block information, transaction hash and
position, log index, and strategy address when relevant.

The original event list is mostly correct. It covers debt changes, reports, strategies, vault configuration, roles, queues,
debt allocators, allocator ratios, keepers, governance, and debt purchases.

We added `Deposit` and `Withdraw`. These are context events. They often explain a debt change, but they do not normally create
an allocation action by themselves.

Envio should also provide coverage records, accounting checkpoints, known gaps, and unresolved checkpoint failures. This lets
Kong decide whether the indexed history is complete and safe to publish.

The prototype currently combines individual Envio event tables with normalized `AllocationSourceEvent` rows because normalized
coverage is incomplete. The cleaner Kong contract is one complete normalized Envio interface, including the shared allocator's
vault-specific ratio events.

## Data Kong gets from RPC

Envio shows that something happened. RPC reads prove the exact vault state and help explain how it happened.

For an action at block `N`, archive RPC provides the state at `N - 1` and `N`. For an action across several blocks, Kong reads
before the first transaction and after the last transaction.

Historical reads include:

- Vault `totalAssets`, `totalDebt`, and `totalIdle`
- Strategy debt, activation, report time, and maximum debt
- The active debt allocator and each strategy's target and maximum ratios
- `shouldUpdateDebt` before allocator actions
- Transaction traces and call paths

Current RPC reads provide the latest safe block, current allocation, vault metadata, strategy names, and current strategy
status. One archive provider may provide both historical and current reads.

## Shared Kong data model

Most of the original normalized structure remains useful behind both APIs.

| Original object | Recommended change |
| --- | --- |
| `vault` | Keep. |
| `strategies` | Keep. Read current status from the latest safe RPC state. |
| `states` | Keep. Include action boundary snapshots and the current safe snapshot. |
| `events` | Keep as raw Envio evidence. |
| `transitions` and `effects` | Keep for atomic transaction and event changes. |
| `doa` | Replace the one-to-one annotation with a reusable allocation policy. |
| `pendingDoaProposals` | Replace time-based stale states with states such as unmatched or superseded. |

The main new object is a grouped allocation action. REST currently calls this an `entry`.

```text
Allocation action
    ├── state before and after the whole action
    ├── one or more transactions
    ├── atomic transitions and source events
    ├── economic action kind
    ├── execution and actor information
    ├── configuration or lifecycle operations
    └── related allocation policy, when known
```

GraphQL should preserve both atomic transitions and grouped actions.

## Main processing changes

### Before and after states

The original spec linked an event state to the previous event state. Kong should read the state immediately before and after
each action. This prevents unrelated deposits, withdrawals, reports, or gains from becoming part of the allocation change.

### Multi-transaction actions

One keeper or manual action can span several transactions and blocks. Kong may group them when call paths, allocator state,
roles, timing, and state continuity show that they belong together. Time alone is not enough.

### Action and execution are separate

The original `kind` mixed what changed with how it happened. The new model separates:

- `kind`: idle deployment, idle deallocation, strategy reallocation, configuration change, or lifecycle change
- `execution.automation`: automatic, manual, or unknown
- `execution.mechanism`: allocator keeper, direct vault call, or another path
- `execution.targetStatus`: matched, overridden, or unavailable

A strategy reallocation can be automatic or manual. Moving idle into one strategy is an idle deployment, even when an
allocator performs it.

### DOA is a policy

A DOA proposal describes target allocations. It does not prove that an execution happened. One policy can govern several
later actions. Kong should record whether a policy was applied, governed a later action, or only matched historical target
configuration. Proposal age alone should not make it stale.

DOA data is optional enrichment. A DOA outage must not stop executed history from updating.

### Evidence and accounting

`transactionFrom` is not enough for Safe or relayed transactions. Kong combines Envio metadata, traces, historical roles,
allocator configuration, and `shouldUpdateDebt` replay to identify the actor, authorization, automation, and target match.

Every snapshot must satisfy:

```text
sum of strategy debt = total debt
total debt + total idle = total assets
```

For charts, Kong also builds a raw-unit flow ledger between visible actions. It includes debt movements, deposits,
withdrawals, reports, gains, losses, and refunds. Anything not explained remains `unattributed_asset_change`.

Only an exact same-block Envio checkpoint that agrees with RPC may provide `unallocatedBps`. Missing evidence is `null`, not
zero.

## GraphQL output

Kong GraphQL should expose the normalized model and its relationships:

- Vaults, strategies, and allocation states
- Grouped actions and atomic transitions
- Transactions, operations, and source events
- Policies and the actions they govern
- Traces, roles, trigger replay, and classification evidence
- Reconciled intervals and unattributed changes
- Coverage and data-quality information

GraphQL is suitable for investigation, debugging, and detailed tools. Clients can select only the fields they need.

The prototype does not implement this Kong GraphQL API. It builds normalized objects in memory, while Postgres mainly stores
completed REST entries. Kong should store the normalized model if GraphQL must query it without repeating Envio and RPC work.

## REST output

REST is the fast public interface for website hydration and charts.

```text
GET /api/rest/views/allocation-history/:chainId/:address
GET /api/rest/views/allocation-history/:chainId/:address?projection=chart
GET /api/rest/views/allocation-history/:chainId/:address/entries/:entryId?runId=...
```

REST returns complete entries with embedded before and after states, strategy changes, transaction summaries, execution
information, relevant policy information, and classification confidence.

The compact chart projection returns the main economic actions, current snapshot, expected APR when available, and reconciled
interval flows. Deposits, withdrawals, reports, and pure withdrawal servicing do not fill the public timeline, but their data
is still used to explain actions and intervals.

Entries are newest first by default. Stable cursors keep pagination on one materialization run.

## Storage and refresh

The original spec proposed one Redis blob per vault. The prototype instead builds an immutable Postgres run, validates it, and
activates it in one transaction. A failed refresh leaves the previous run active.

For Kong, the clean target is:

1. Store the normalized states, actions, policies, events, and evidence needed by GraphQL.
2. Build the REST and chart projections from the same run.
3. Activate all projections together after validation.
4. Add incremental refresh and a retention policy before broad production use.

The prototype currently performs a complete replay and only covers Ethereum `yvUSDC-1`, `yvUSDT-1`, and `yvUSD`. It can
publish clearly marked provisional test runs when Envio coverage is incomplete. That exception should not become the Kong
production default.
