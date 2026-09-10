# Allocation coverage assessment — 10 September 2026

Open `index.html` for the self-contained review. The selected rollout contains 21 Yearn multi-strategy vaults:
13 Ethereum, 2 Base, and 6 Katana. yvFlexUSDC is explicitly deferred. The current service still serves its three
reference vaults; this proposed manifest does not activate additional coverage.

- `proposed-vaults.json` is the proposed `ALLOCATION_VAULTS_JSON` value.
- `selected-vaults.csv` contains the same 21 addresses with names and chain labels.
- `vault-inventory-2026-09-10.json` preserves the original 808-contract raw-filter inventory and retrieval metadata.
- `envio-probe-2026-09-10.json` and `rpc-probe-2026-09-10.json` preserve checks for the original 22 candidates.
- `flex-log-probe-2026-09-10.json` preserves the evidence for the deferred Flex vault.
- `multicall-validation.json` records the bounded direct/Multicall parity check on all three chains.
- `probe-*.ts.txt` are archived probe source transcripts, not application scripts. They retain the original local
  paths and read credentials from environment variables; they contain no credential values.

Evidence is a dated observation, not certification of complete indexed history. Provider billing savings were not
measured. Multicall is implemented locally; persistent RPC caching and incremental materialization remain follow-up work.
