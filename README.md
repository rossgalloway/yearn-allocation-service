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
See [docs/kong-spec-changes-summary.md](./docs/kong-spec-changes-summary.md) for a short overview of the main changes from the
original Kong spec and the REST/GraphQL split.
See [docs/kong-allocation-history-spec-proposed.md](./docs/kong-allocation-history-spec-proposed.md) for the complete proposed
specification with all changes applied.
See [docs/kong-allocation-history-spec-redline.md](./docs/kong-allocation-history-spec-redline.md) for a complete proposed
redline of the original spec.
For easier review, open the styled
[HTML diff](./docs/kong-allocation-history-spec-redline.html) through a local static server.
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

Reports the selected serving source, Postgres reachability, active materializations, their certification metadata, and the
latest refresh result. It never returns URLs or tokens. In database mode, readiness requires a schema-version-2 run for all
configured vaults; those runs must be certified unless the explicit test-only provisional switch is enabled.

### `GET /api/rest/views/allocation-history/:chainId/:address` (test)

Without a `projection` parameter, returns the schema-version-2 evidence-rich REST projection proposed for Kong. The response
contains vault metadata, pagination, and a denormalized `entries` array; it does not expose top-level strategies, states,
transitions, proposals, or raw events.
Background jobs read events from Envio, enrich them through the configured archive RPC, and atomically activate a Postgres
read-model generation. Public requests then read only Postgres. The default reference vaults are:

- `yvUSDC-1`: `0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204`
- `yvUSDT-1`: `0x310B7Ea7475A0B449Cfd73bE81522F1B88eFAFaa`
- `yvUSD`: `0x696d02Db93291651ED510704c9b286841d506987`

The route defaults to 25 entries, including a safe-block `current_snapshot`. Each meaningful entry embeds its complete
whole-group `before` and `after` allocation, calculated strategy changes, compact transaction steps, policy provenance when
available, and classification evidence. Multi-transaction keeper runs are grouped only when historical allocator trigger
replay, traced execution path, allocator configuration, and state continuity agree.

Responses default to `direction=desc` (newest first). Pass `direction=asc` for chronological order. `limit` accepts 1–100 final
public entries. When `pagination.nextCursor` is non-null, pass it back unchanged with the same direction to continue through
the complete materialized history. The opaque cursor pins the immutable run, direction, and selected projection used by the
first page, so a refresh cannot reorder or skip entries mid-traversal and a chart cursor cannot be used with the full response.
Raw events are deliberately not exposed by this REST route; they belong in the future Kong GraphQL detail surface.

Pass `projection=chart` for the lean website-hydration shape. The database filters before applying `limit`, so chart pages
contain only visible `strategy_reallocation` entries. Deposits, withdrawals, reports, and idle movements remain included in the
interval ledger between those visible points. The initial page returns the safe-head state separately as `currentSnapshot`;
cursor pages set it to null.

Chart states retain exact raw `totalAssets`, `totalIdle`, and strategy `currentDebt`. Derived BPS values are intentionally
omitted so the client has one rounding path. Strategy names are deduplicated into the response-level `strategies` dictionary.
Each entry keeps the three execution axes, proposal-scoped `expectedAprImpact`, and a run-pinned `detailsHref`; transaction,
operation, classification, and atomic before-state evidence remain available from that detail route.

Every chart interval identifies its boundary entries with `fromEntryId` and `toEntryId` instead of repeating both states.
`boundaryStates` supplies a referenced state that falls outside the current cursor page. The current snapshot carries the tail
interval with `toEntryId: null` and `endKind: "safe_head"`. Ledger amounts are raw underlying units. Literal deposits,
withdrawals, and report refunds use the `external` boundary node; reported gains and losses use the non-custodial `accounting`
boundary node. Debt updates are derived, and idle round trips may collapse into strategy-to-strategy flows.

The materializer still validates the complete per-node equations before activation. The chart response keeps only
`balanceStatus`, `attributionStatus`, and the exact sum of `unattributed_asset_change` amounts as `unattributedAmount`; full
residual equations remain in the stored detail evidence. Chart pagination returns only `nextCursor`. Clients that advertise
`Accept-Encoding: gzip` receive compressed JSON.

Envio `Deposit` and `Withdraw` rows are context rather than allocation intent. Pure debt updates that only service withdrawals
do not consume space in the public entries array. If the same transaction or block contains allocator execution, a confirmed
`DEBT_MANAGER` caller, bad-debt handling, or configuration/lifecycle activity, that action remains visible and retains
`vaultActivities` with assets, shares, participants, and direct/routed path. Deposit-driven debt updates remain visible as
`idle_deployment`, including delayed keeper deployment after idle accumulates across separate deposit transactions. Report-only
accounting transitions are also omitted.

The public `kind` describes the whole grouped asset flow. Strategy debt increases without decreases are `idle_deployment`;
decreases without increases are `idle_deallocation`; groups containing both are `strategy_reallocation`. If no debt moved, a
pure policy, configuration, or lifecycle action may supply the kind instead. Exact strategy additions, retirements, max-debt
changes, allocator settings, and other configuration changes are preserved as structured `operations`; a compound transaction
keeps the economic-flow kind and carries those operations alongside it.

`execution.automation` independently records whether the amount followed an automatic allocator recommendation or was chosen
manually. `execution.mechanism` records the call path (`allocator_keeper`, `direct_vault_role`, `governance_safe`, and related
values), while `execution.targetStatus` records whether an allocator target was `matched`, `overridden`, or unavailable.
`policy` independently embeds a matching DOA configuration when one is available and remains null otherwise.

Archive traces distinguish the top-level originator, relayer path, allocator, and immediate vault caller. Envio `RoleSet`
history verifies whether that caller held `DEBT_MANAGER` at the execution block. Allocator calls are replayed through historical
`shouldUpdateDebt`; a target match produces `automation: automatic` and `targetStatus: matched`, while a caller-selected amount
produces `automation: manual` and `targetStatus: overridden` without changing the economic-flow kind.
Unresolved traces, role history, or trigger calls remain explicit limitations instead of being inferred from `transactionFrom`.

DOA proposal age is not an execution status. A policy application is `confirmed` only when Envio supplies exact matching
allocator configuration events. When the archive-RPC target configuration exactly matches a proposal but Envio lacks the
shared allocator event, the inline policy is explicitly `inferred_from_historical_config`.

`ALLOCATION_HISTORY_SOURCE=database` enables the materialized read path. `live` retains the bounded request-time prototype for
local shape testing, but it still fails closed unless Envio provides certified coverage and checkpoints. Source selection is
explicit; adding `DATABASE_URL` alone never cuts traffic over to an empty database.

`ALLOCATION_ALLOW_UNCERTIFIED_MATERIALIZATION=true` is a test-only background-materialization switch. It permits Envio events
and archive-RPC snapshots to produce an active provisional database run when certification entities are absent or incomplete.
The REST response exposes `dataQuality.certification: "provisional"`, lists the evidence gaps, and is always uncached. Missing
same-block checkpoints remain null rather than being presented as zero or inferred data. The request-time `live` path remains
strict.

The materializer stores both the full evidence payload and the compact chart payload, so chart requests do not load and trim
the larger JSON at request time. See [docs/database.md](./docs/database.md) for migrations, backfill, refresh, verification,
and cutover. The current refresh
implementation intentionally performs a complete rebuild into a new immutable run. It does not yet implement incremental tail
updates or a bounded old-run retention policy; those remain Kong production decisions.

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
bunx tsc --noEmit
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
- `DATABASE_URL`
- `ALLOCATION_HISTORY_SOURCE=database` after all backfills pass health checks

`ALLOW_UNSAFE_ALLOCATION_DATA` and `ALLOCATION_ALLOW_UNCERTIFIED_MATERIALIZATION` must remain false in production.


### Allocator assignment reference update

Allocator assignments come from Envio `AddedNewVault` and `UpdateDebtAllocator` evidence from the authoritative Role Manager. Factory deployments identify the contract family; they never assign a vault. Initial custom addresses, replacement addresses, and zero clears are retained independently of ABI support. Responses include `allocatorResolution` with the assignment, support state, family, and block used for enrichment. Shared allocator control events retain allocator scope. Unresolved evidence prevents certified publication.

Ethereum (1), Base (8453), and Katana (747474) are supported through `ALLOCATION_VAULTS_JSON`, an explicit array of `{chainId,address,label}` objects. Configure each selected chain's `RPC_URL_<chainId>` and obtain per-vault immutable coverage before backfilling. The three existing Ethereum samples remain the default. `--chain=<chainId>` selects a chain for the materialization script.

Run migrations before rematerializing: migration 0004 retains allocator evidence with each run. The materializer version changed to `allocation-history-v2-allocator-assignment`; earlier runs must be rebuilt. This requires the local follow-up to Envio PR #58 described in [the implementation notes](docs/envio-pr58-follow-up.md). Envio schema availability and deterministic fixture tests are not proof of complete production replay or certified history on any chain.
