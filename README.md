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

Returns the schema-version-2, chart-ready REST projection proposed for Kong. The response contains vault metadata, pagination,
and a denormalized `entries` array; it does not expose top-level strategies, states, transitions, proposals, or raw events.
This prototype reads events from Envio and enriches them through the configured archive RPC. It is intentionally limited to
Ethereum and these vaults:

- `yvUSDC-1`: `0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204`
- `yvUSDT-1`: `0x310B7Ea7475A0B449Cfd73bE81522F1B88eFAFaa`
- `yvUSD`: `0x696d02Db93291651ED510704c9b286841d506987`

The route defaults to at most 25 entries, including a safe-block `current_snapshot`. It scans a bounded window of the latest 100
raw transition blocks, removes REST-excluded accounting noise, groups related actions, and then applies the requested response
limit. Each meaningful entry embeds its complete
whole-group `before` and `after` allocation, calculated strategy changes, compact transaction steps, policy provenance when
available, and classification evidence. Multi-transaction keeper runs are grouped only when historical allocator trigger
replay, traced execution path, allocator configuration, and state continuity agree.

Responses default to `direction=desc` (newest first). Pass `direction=asc` for chronological order. `limit` accepts 1–100 final
public entries; a response can contain fewer when the bounded scan does not contain enough qualifying actions. Raw events are
deliberately not exposed by this REST route; they belong in the future Kong GraphQL detail surface. The response echoes its
`direction` and uses the Kong cache headers from the spec.

Envio `Deposit` and `Withdraw` rows are context rather than allocation intent. Pure debt updates that only service withdrawals
do not consume space in the public entries array. If the same transaction or block contains allocator execution, a confirmed
`DEBT_MANAGER` caller, bad-debt handling, or configuration/lifecycle activity, that action remains visible under its action kind
and retains `vaultActivities` with assets, shares, participants, and direct/routed path. Deposit-driven debt updates remain
visible. Report-only accounting transitions are also omitted.

Archive traces distinguish the top-level originator, relayer path, allocator, and immediate vault caller. Envio `RoleSet`
history verifies whether that caller held `DEBT_MANAGER` at the execution block. Allocator calls are replayed through historical
`shouldUpdateDebt`; target matches within the response's disclosed sub-unit tolerance become `target_maintenance`, while larger
differences become `allocator_override`.
Unresolved traces, role history, or trigger calls remain explicit limitations instead of being inferred from `transactionFrom`.

DOA proposal age is not an execution status. A policy application is `confirmed` only when Envio supplies exact matching
allocator configuration events. When the archive-RPC target configuration exactly matches a proposal but Envio lacks the
shared allocator event, the inline policy is explicitly `inferred_from_historical_config`.

This is a shape-validation endpoint, not the production refresh pipeline: it computes on demand, keeps a 15-minute in-memory
cache, and reads at most the latest 1,000 rows from each Envio event family. Kong should materialize completed entries for
predictable public latency and expose slower normalized investigation through GraphQL.

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
