# Yearn Allocation Service

A Next.js API service that serves DOA optimizer intent alongside Yearn Envio Allocation History states.

The initial state and coverage semantics are informed by `yearn.fi` branch `codex/optimization-allocation-completeness` at `6260c961`. The producer contract comes from the Allocation History entities merged into `yearn-envio` main at `4027315`.

## Authority boundaries

- Envio `AllocationSourceEvent` and `VaultAccountingCheckpoint` entities own executed on-chain allocation state.
- The immutable `VaultAllocationCoverage` row decides whether a timeline is safe to consume.
- `unallocatedBps` is populated only from `totalIdle` in a same-block Envio checkpoint.
- DOA Redis owns optimizer intent, proposed targets, APR estimates, explanations, and source timestamps.
- A DOA residual is never treated as idle capital. Certified indexed state may enrich it with separately sourced
  `unallocatedBps`.

See [docs/data-contract.md](./docs/data-contract.md) for processing and failure semantics.
Prototype decisions that differ from the Kong reference are tracked in
[docs/reference-spec-deltas.md](./docs/reference-spec-deltas.md).

## Endpoints

### `GET /api/allocations`

Returns one composite vault response:

- `executed`: certified or provisional Envio allocation states and their coverage provenance.
- `optimizer`: DOA optimization history enriched with timestamp-aligned indexed state when certification permits it.

The endpoint does not reproduce the old `/api/optimization/change` response shape.

Required query parameters:

- `vault`: a 20-byte hex address.
- `chainId`: positive integer chain ID. Allocation History currently publishes Ethereum coverage only.

Optional query parameters:

- `limit`: number of states, from 1 to 500; defaults to 100.
- `beforeBlock`: returns states before this block and enables stable older-page traversal.
- `fromBlock`: lower output bound. The service still replays from the certified coverage start to seed state correctly.
- `coverageRevision`: select one immutable revision. Production should set `ENVIO_ALLOCATION_COVERAGE_REVISION` instead.
- `optimizationLimit`: maximum DOA records, from 1 to 500; defaults to 100.
- `includeUnsafe=1`: read draft coverage only when `ALLOW_UNSAFE_ALLOCATION_DATA=true`. The response remains `complete: false`, `provisional: true`, and `Cache-Control: no-store`.

```bash
curl 'http://127.0.0.1:3000/api/allocations?chainId=1&vault=0x0000000000000000000000000000000000000000'
```

Executed state fails closed when no certified `safeForTimeline` row is available. When DOA records are available, the
endpoint can still return HTTP 200 with `executed.status: "unavailable"`; the optimizer records remain useful but their
`allocationSnapshot` stays incomplete and has no claimed unallocated value.

### Powerglove adoption

Raw DOA fields are retained under `optimizer.records`, including `strategyDebtRatios`, APRs, `explain`, `source`,
`freshness`, and `allocationCoverage`. Powerglove needs a small adapter for the composite envelope rather than a legacy
endpoint. Each record's `allocationSnapshot` is the canonical current-allocation overlay when complete.

### `GET /api/health`

Returns liveness and booleans for required upstream configuration. It never returns URLs or tokens.

### `GET /api/rest/views/allocation-history/:chainId/:address` (test)

Returns the `VaultAllocationTimeline` shape proposed for Kong. This prototype reads only raw event tables from Envio and
materializes block-end state through the configured archive RPC. It is intentionally limited to Ethereum and these vaults:

- `yvUSDC-1`: `0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204`
- `yvUSDT-1`: `0x310B7Ea7475A0B449Cfd73bE81522F1B88eFAFaa`
- `yvUSD`: `0x696d02Db93291651ED510704c9b286841d506987`

The route defaults to the latest 25 event transitions plus a confirmed live tail. For every transition at block `N`, `states`
contains an immediate pre-state read at `N - 1` and a post-state read at `N`; the transition links them through `fromStateId`
and `toStateId`. Adjacent duplicate state blocks are returned once.

Responses default to `direction=desc` (newest first). Pass `direction=asc` for chronological order. `limit` accepts 1–100
historical event transitions, and `events=1` includes raw events for the returned state blocks. The response echoes its
`direction` and uses the Kong cache headers from the spec.

Envio `Deposit` and `Withdraw` rows enrich effects without creating standalone allocation samples. Associated strategy debt
changes use `kind: "deposit_driven_debt_update"` or `kind: "withdrawal_driven_debt_update"` and expose `vaultActivities`
with assets, shares, participants, and whether the transaction called the vault directly or through a router/Safe. Known
keeper debt changes without a matching proposal are `allocator_execution`, not manual updates.

This is a shape-validation endpoint, not the production refresh pipeline: it computes on demand, keeps a 15-minute in-memory
cache, and reads at most the latest 1,000 rows from each Envio event family. The documented Ethereum TKS DOA keeper is labeled
directly; other actors are derived from allocator/vault role events when available and remain `unknown` otherwise.

## Local development

```bash
cp .env.example .env.local
bun install
bun run dev
```

Then open `http://127.0.0.1:3000`.

Verification:

```bash
bun run lint
bun run test
bun run build
```

## Deployment configuration

The repository follows the same Yearn Vercel deployment pattern as `katana-apr-service`. Configure secrets outside the repository:

- `ENVIO_ALLOCATION_GRAPHQL_URL`
- `ENVIO_ALLOCATION_GRAPHQL_TOKEN` when the candidate deployment is authenticated
- `ENVIO_ALLOCATION_COVERAGE_REVISION`
- `RPC_URL_1`
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

`ALLOW_UNSAFE_ALLOCATION_DATA` must remain false in production.
