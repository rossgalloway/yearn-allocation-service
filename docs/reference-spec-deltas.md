# Allocation history reference-spec deltas

Reference: [Vault Allocation History — Spec](https://hackmd.io/@murderteeth/rJkQlX-AWx)

This document records deliberate prototype differences, clarifications discovered through live data, and unresolved schema
questions. Update it whenever behavior diverges from the reference so the Kong implementation can either adopt or reject the
change explicitly.

## Accepted prototype changes

| Area | Reference spec | Prototype behavior | Reason / future action |
| --- | --- | --- | --- |
| Snapshot pairing | One block-end state per relevant event block. The preceding event state is the transition's `fromStateId`. | Every returned event transition at block `N` references an immediate pre-state read at `N - 1` and a post-state read at `N`. Both states are returned and adjacent blocks are deduplicated. | Captures the actual before/after allocation change even when deposits, withdrawals, or other non-allocation activity occurred since the previous allocation event. Kong should preserve this pairing. |
| Response order | States and transitions are chronological (oldest first). | `direction=desc` is the default so clients walk backward from current state. `direction=asc` restores chronological order, and the response echoes the selected `direction`. Link semantics remain chronological: `fromStateId` is always before and `toStateId` is always after. | Better default for current-to-history exploration while retaining chart-friendly ascending output. |
| Strategy status | Directory status is current, but the source is not prescribed. | Current status comes from the latest safe-block RPC `strategies(address).activation` value. Envio lifecycle events define the historical universe, not current status. | Live data established that `StrategyChanged` uses `1 = added`, `2 = revoked`; relying on a misread enum marked every strategy inactive. |
| DOA matching | Multiple signals may identify an execution, including keeper paths and debt direction. | Exact allocator target ratios remain the strongest signal. On Ethereum, the documented TKS DOA keeper path plus a proposal-strategy debt-direction match is also sufficient. Direction and timing without a trusted path still fail closed. | The current Envio source has no `UpdateStrategyDebtRatios` rows, while live yvUSDC data shows the known keeper executing proposal-aligned `update_debt` calls minutes after publication. |
| DOA execution span | The schema annotates transitions but does not explicitly state whether one proposal can match more than one transition. | One proposal may annotate multiple debt transitions. Each event block keeps its own pre/post state and `doa_execution` transition. | A real rebalance is executed as multiple keeper transactions, often minutes or hours apart; restricting a proposal to one block drops most of the allocation change. |
| Vault activity context | `Deposit` and `Withdraw` are not in the required source-event list, and their associated `DebtUpdated` events fall into `manual_debt_update`. | Envio `Deposit` / `Withdraw` rows are fetched as context-only events. A debt change in the same transaction is `deposit_driven_debt_update` or `withdrawal_driven_debt_update`; effects include exact assets, shares, participants, event ID, and direct/routed path. Standalone context events do not create timeline samples. | Live yvUSDC evidence showed that 83 of 85 nominally manual debt updates satisfied withdrawals; live yvUSD showed 15 deposit-driven debt increases. Consumers need to distinguish allocation intent from vault-flow accounting movement. |
| Trusted keeper without proposal | Keeper-path debt changes without a matching DOA proposal are `manual_debt_update`. | A debt update from a known DOA/debt-allocator keeper is `allocator_execution`; a qualifying proposal can still upgrade it to `doa_execution`. | The actor and transaction path prove automated allocation activity even when proposal history is missing, expired, or directionally ambiguous. |
| Prototype history | Production blobs contain rebuilt and incrementally maintained full history. | The route computes on demand, defaults to 25 transition blocks, accepts `limit=1..100`, caches for 15 minutes, and reads at most 1,000 rows per Envio event family. | Keeps this service suitable for schema and consumer validation; not a replacement for the proposed Kong refresh jobs. |
| Supported vaults | All Kong-supported V3 vaults and chains. | Ethereum-only: `yvUSDC-1`, `yvUSDT-1`, and `yvUSD`. | Explicit test scope requested for archive-RPC enrichment. |

## Clarifications retained from the reference

- `states` are archive-RPC materializations at event-selected blocks; `transitions` are derived from Envio events. They are not
  raw event payloads.
- The live tail is a safe-block RPC state and has a `current_live_tail` transition with no source effects.
- `pendingDoaProposals` contains every unmatched vault proposal after deduplication, including statuses `pending`, `unmatched`,
  and `stale`. The name is therefore broader than “currently pending.”
- DOA records annotate on-chain transitions but never create executed states.

## Open schema decisions

1. Rename `pendingDoaProposals` to `unmatchedDoaProposals` or `doaProposals`, or restrict it to `status: "pending"`.
2. Define how `maxDebtBps` represents an unlimited `maxDebt == uint256.max`; the current numeric ratio is too large for exact
   JavaScript representation.
3. Provide keeper/applicator labels for chains beyond Ethereum and decide how address changes are governed. The Ethereum TKS
   keeper used by this prototype is `0x283132390ea87d6ecc20255b59ba94329ee17961`.
4. Decide whether paired states should remain linked only by `fromStateId` / `toStateId` or gain an explicit
   `snapshotPosition: "before" | "after"` field.
5. Define partial DOA execution semantics. The prototype considers a proposal matched after its first qualifying debt
   transition and annotates every additional matching transition, because the reference status model has no
   `partially_executed` state. A production contract may instead need target-set completion metadata.
