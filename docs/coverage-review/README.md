# Allocation coverage — 10 September 2026

Open `index.html` for the self-contained review. The local preview now serves all 21 selected Yearn multi-strategy
vaults: 13 Ethereum, 2 Base, and 6 Katana. yvFlexUSDC remains explicitly deferred.

- `proposed-vaults.json` is the enrolled `ALLOCATION_VAULTS_JSON` value in the local and preview environments.
- `selected-vaults.csv` contains the same 21 addresses with names, chain labels, and preview status.
- `expanded-service-validation.json` records successful chart, accounting, pagination, and pinned-detail checks for all
  21 vaults, plus their active materialization heads.
- `vault-inventory-2026-09-10.json` preserves the original 808-contract raw-filter inventory and retrieval metadata.
- `envio-probe-2026-09-10.json` and `rpc-probe-2026-09-10.json` preserve checks for the original 22 candidates.
- `flex-log-probe-2026-09-10.json` preserves the evidence for the deferred Flex vault.
- `multicall-validation.json` records the bounded direct/Multicall parity check on all three chains.
- `incremental-validation.json` compares cached reuse with forced state reconstruction at the same head, using canonical
  JSON values so Postgres property ordering does not affect the comparison.
- `ybold-cache-validation.json` measures a large cold backfill and a subsequent warm refresh. Heads differ; use this for
  RPC workload counts, not fixed-head output parity. The cold counter excludes initial finality-anchor reads, as noted.
- `probe-*.ts.txt` are archived probe source transcripts, not application scripts. They retain original local paths and
  read credentials from environment variables; they contain no credential values.

These reconstructed histories remain provisional. Successful materialization does not certify complete indexed history.
Provider billing savings were not measured. Multicall, persistent finalized RPC caching, and incremental state reuse are
implemented. Raw traces are reduced in bounded pages; allocator assignment and per-block event lookups are prepared once
per phase. Full public projection assembly still re-evaluates grouping, proposal evidence, and intervals. Refreshes are
manual; the inventory is a dated selection and is not automatically re-enrolled.
