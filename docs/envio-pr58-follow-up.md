# Envio PR #58: arbitrary allocator discovery and chain coverage

The vaults team confirmed on 2026-09-08 that a Role Manager can assign any address as a debt allocator, including when adding an existing vault. This follow-up extends PR #58 while retaining Envio's event-only responsibility.

## Implementation

1. Add an `AssignedDebtAllocator` discovery contract with aliased vault-bound and shared ratio signatures and the understood common control signatures. Use this same registration for factory and assignment discovery on Ethereum, Base, and Katana so event order cannot select a narrower ABI.
2. Register addresses from both `AddedNewVault` and `UpdateDebtAllocator`. Persist assignment/discovery evidence even for zero, code-free, and unknown custom addresses. Avoid registering the zero address for logs; its assignment record remains intact.
3. Keep both factory semantics separate. The shared factory's second address is governance; the vault-bound factory's second address is a bound vault. Both event topics are identical.
4. Normalize shared ratio events using their own vault. Normalize known vault-bound events using bound-vault provenance. Store known shared controls once at allocator scope. Preserve unknown association or family as unresolved evidence, including subsequent late reconciliation without duplicate source IDs.
5. Preserve existing raw event entities for supported signatures. Normalize Role Manager removal and vault Role Manager changes so consumers can evaluate authority at each event position.
6. Extend the allocation normalization allowlist and chain discovery configuration to Base (`8453`) and Katana (`747474`). Record verified factory/Role Manager source evidence per chain; do not copy Ethereum implementation metadata to other chains.

## Validation

- Initial arbitrary assignment and non-factory replacement capture subsequent understood events.
- A shared ratio emitted for a second vault is associated with that vault, not the vault that discovered the allocator.
- Unknown controls remain unresolved; known shared controls remain allocator-scoped; no vault fan-out occurs.
- Factory-first and assignment-first registration, late family evidence, repeated discovery, zero-address assignments, and continuation across processing calls preserve evidence without duplicates.
- Fixtures exercise Ethereum, Base, and Katana independently; persisted runtime replay/restart and full cursor traversal remain separate operational checks.
- Run Envio codegen, TypeScript build, allocation tests, and historical fixture checks. Record aggregate test limitations independently.

## Consumer and rollout contract

Kong consumes normalized events, assignments, deployments, and unresolved records. It owns historical RPC reads, family-specific configuration adapters, current assignment projection, history materialization, and certification. Unsupported custom interfaces retain their assigned address with explicit unavailable configuration.

Local implementation does not activate production coverage. Deployment needs a compatible schema and replay from the required discovery/configuration history on each chain. An empty custom-allocator event stream does not certify its event coverage. This follow-up remains local until publication is explicitly requested.

## Local implementation results (2026-09-08)

The follow-up is implemented on local branch `codex/allocator-discovery-multichain`. Envio codegen, TypeScript build, all 13 allocation tests, and the historical fixture check pass. The fixture check validates three decoded real logs and the previously captured 4,020-log evidence summary; it is not a new full replay.

The aggregate `test` and `check:config` commands cannot complete on the PR #58 base because it references two absent files: `monitoring/test/monitoring.test.js` and `scripts/check_envio_config_compatibility.mjs`. The allocator tests pass before the aggregate test reaches the missing monitoring file. These unrelated script omissions are unchanged.

Current bytecode was checked for the shared factory and Role Manager factory on all three chains. The legacy vault-bound factory has code on Ethereum and Base and no code at the checked Katana block, so it remains unconfigured on Katana. Exact block numbers and hashes are recorded in Envio's `fixtures/allocation/chain-discovery.json`. Full replay, database-backed restart validation, and production activation remain operational follow-up work.
