# Allocation-history reference contract

Target: Kong `rg/allocation-history-spec` at `3c3f0efe8c68dd572e9bd57fecb3fcb8879ac9d8`.
Read [the repository README](../README.md) for route parameters and response fields.

## Input boundary

`AllocationEventReader.read` accepts vault identity, the finalized upper block and an event safety limit.
It returns ordered events, allocator deployment evidence, and `EventCoverage`. Events may precede the published range
when needed to seed strategy discovery, permissions or allocator assignments. They must not exceed the safe upper bound.

The Envio adapter reads canonical vault events and normalized allocator/Role Manager evidence. It bounds history by
both chain finality and indexed progress. An optional coverage row supplies event discovery/history/assignment gates,
source revision and known gaps. The adapter never asks for accounting checkpoints, checkpoint failures or
`safeForTimeline`. A missing coverage table does not prevent an explicitly provisional reference run.

The service checks supplied coverage-boundary hashes against RPC. The adapter rejects a coverage revision change during
acquisition. The event digest identifies the returned event/deployment batch. Neither indexed progress nor that digest
proves complete event coverage. Until upstream supplies stronger snapshot/correction guarantees, preserve that limitation.

`fixtureEventReader` accepts pinned evidence through the same interface. It does not relabel provisional captures as verified.
Kong's captured sample files are unchanged. They lack the new top-level run identity, chart asset metadata and structured
quality and retain old checkpoint fields; use explicit adapters when comparing them to new responses.

## Accounting and presentation

At each required block, RPC establishes totals and strategy debts. Publication requires:

```text
sum(strategy currentDebt) = totalDebt
totalDebt + totalIdle = totalAssets
```

Failure to read a required value is not zero. Unsupported allocator interfaces preserve the observed assignment and null
configuration. Optional policy or execution enrichment can be unavailable without invalidating known balances.

Historical states are block-end reads. Detail transactions explain contributing operations; they do not establish
transaction-exact before/after balances. Related keeper actions may remain grouped across intervening deposits.
No new balance-equality grouping requirement is imposed by this migration.

The chart selects strategy reallocations. Deposits, withdrawals, reports and idle-only actions still affect interval accounting.
An interval connects the previous visible action's after-state to the next visible action's after-state. It differs from
an individual action's own before/after change. The current snapshot closes the tail at the safe block.

Derived strategy-to-strategy flows describe balance redistribution rather than direct token transfers. Per-node interval
equations must balance, while unexplained amounts remain `unattributed_asset_change`. Residual flows cannot establish event
completeness. Proposal APR changes remain proposal estimates rather than realized returns.

## Publication

The CLI composes reader, reconstruction and repository publication. It builds one candidate before atomically activating it.
Run-pinned cursors and detail links retain their run across later refreshes. Failed or replaced writers cannot publish.
No run cleanup is introduced. An unavailable cursor requires restarting; it never switches silently to the active run.

The API retains schemaVersion 2 for this coordinated reference update and uses a new processing/cache revision.
Older stored runs are kept but are not adapted on request. Rebuild before switching the consumer to this branch.

## Scope

This is an explorable reference for Kong's team, not a second production deployment or an independent validation project.
Keep the input boundary and processing responsibilities recognizable in Kong's eventual implementation. The two primary
routes are chart and action detail; the existing prepared `projection=full` list remains a diagnostic convenience.
