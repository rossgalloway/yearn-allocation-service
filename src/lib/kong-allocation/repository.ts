import type { QueryResult, QueryResultRow } from 'pg'
import { allocationCoverageContractIssues } from '@/lib/allocation/service'
import {
  type DatabaseQueryable,
  DatabaseUpstreamError,
  databasePool,
  databaseQuery,
  withDatabaseTransaction
} from '@/lib/database/client'
import type { VaultAllocationCoverage } from '@/lib/envio/types'
import { buildAllocationChartPayload } from './chart'
import { AllocationHistoryCursorError, decodeAllocationHistoryCursor, encodeAllocationHistoryCursor } from './cursor'
import { buildAllocationFlowIntervals } from './flow-ledger'
import type {
  AllocationChartCurrentSnapshot,
  AllocationChartInterval,
  AllocationChartState,
  AllocationHistoryEntry,
  AllocationSourceEvent,
  AllocatorDeploymentEvidence,
  MaterializedAllocationChartPayload,
  TimelineDirection,
  VaultAllocationChartResponse,
  VaultAllocationHistoryEntryResponse,
  VaultAllocationHistoryResponse,
  VaultAllocationVault
} from './types'
import type { TestVault } from './vaults'

export const ALLOCATION_SCHEMA_VERSION = 2
export const ALLOCATION_MATERIALIZER_VERSION = 'allocation-history-v2-allocator-assignment'
const DEFAULT_STALE_RUN_SECONDS = 6 * 60 * 60
const ENTRY_INSERT_BATCH_SIZE = 250

interface ProjectionRow extends QueryResultRow {
  projection_id: string
  run_id: string
  schema_version: number
  materializer_version: string
  generated_at: string
  coverage_safe_for_timeline: boolean
  coverage_known_gaps: string[] | string
  vault_payload: VaultAllocationVault | string
}

interface EntryRow<Payload = AllocationHistoryEntry> extends QueryResultRow {
  entry_id: string
  end_block: string
  payload: Payload | string
  chart_payload?: MaterializedAllocationChartPayload | string | null
}

interface RunRow extends QueryResultRow {
  id: string
  projection_id: string
}

export class AllocationHistoryNotMaterializedError extends Error {
  constructor(message = 'Allocation history has not been materialized for this vault') {
    super(message)
    this.name = 'AllocationHistoryNotMaterializedError'
  }
}

export class AllocationHistoryEntryNotFoundError extends Error {
  constructor() {
    super('Allocation history entry was not found')
    this.name = 'AllocationHistoryEntryNotFoundError'
  }
}

function jsonObject<T>(value: T | string, label: string): T {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value) as T
  } catch (error) {
    throw new DatabaseUpstreamError(`Postgres returned invalid ${label} JSON`, { cause: error })
  }
}

async function projectionForPage(
  queryable: DatabaseQueryable,
  vault: TestVault,
  cursor: ReturnType<typeof decodeAllocationHistoryCursor> | null
): Promise<ProjectionRow> {
  const values = cursor
    ? [vault.chainId, vault.address.toLowerCase(), cursor.projectionId, cursor.runId]
    : [vault.chainId, vault.address.toLowerCase()]
  const where = cursor ? 'p.id = $3::bigint AND r.id = $4::bigint' : 'r.id = p.active_run_id'
  const result = await queryable.query<ProjectionRow>(
    `SELECT
       p.id::text AS projection_id,
       r.id::text AS run_id,
       r.schema_version,
       r.materializer_version,
       r.generated_at::text,
       r.coverage_safe_for_timeline,
       r.coverage_known_gaps,
       r.vault_payload
     FROM allocation_history_projection p
     JOIN allocation_history_run r ON r.projection_id = p.id
     WHERE p.chain_id = $1
       AND p.vault_address = $2
       AND ${where}
       AND r.status = 'succeeded'
     LIMIT 1`,
    values
  )
  const row = result.rows[0]
  if (!row && cursor) throw new AllocationHistoryCursorError('Allocation history cursor is no longer available')
  if (row?.schema_version !== ALLOCATION_SCHEMA_VERSION || row.generated_at === null || row.vault_payload === null) {
    throw new AllocationHistoryNotMaterializedError()
  }
  return row
}

export async function readMaterializedAllocationHistory(
  input: {
    vault: TestVault
    limit: number
    direction: TimelineDirection
    cursor?: string | null
  },
  queryable: DatabaseQueryable = databasePool()
): Promise<VaultAllocationHistoryResponse> {
  const cursor = input.cursor ? decodeAllocationHistoryCursor(input.cursor, input.direction, 'full') : null
  let projection: ProjectionRow
  try {
    projection = await projectionForPage(queryable, input.vault, cursor)
  } catch (error) {
    if (error instanceof AllocationHistoryCursorError) throw error
    if (error instanceof AllocationHistoryNotMaterializedError) throw error
    if (error instanceof DatabaseUpstreamError) throw error
    throw new DatabaseUpstreamError('Unable to read the active allocation materialization', { cause: error })
  }

  const comparison = input.direction === 'desc' ? '<' : '>'
  const order = input.direction === 'desc' ? 'DESC' : 'ASC'
  const values: unknown[] = [projection.run_id, input.limit + 1]
  let cursorClause = ''
  if (cursor) {
    values.push(cursor.endBlock, cursor.entryId)
    cursorClause = `AND (e.end_block, e.entry_id) ${comparison} ($3::bigint, $4::text)`
  }
  let result: QueryResult<EntryRow>
  try {
    result = await queryable.query<EntryRow>(
      `SELECT entry_id, end_block::text, payload
       FROM allocation_history_entry AS e
       WHERE e.run_id = $1::bigint
         ${cursorClause}
       ORDER BY e.end_block ${order}, e.entry_id ${order}
       LIMIT $2`,
      values
    )
  } catch (error) {
    throw new DatabaseUpstreamError('Unable to read materialized allocation entries', { cause: error })
  }

  const hasMore = result.rows.length > input.limit
  const selected = result.rows.slice(0, input.limit)
  const entries = selected.map((row) => jsonObject(row.payload, 'allocation entry'))
  const limitations = jsonObject(projection.coverage_known_gaps, 'coverage limitations')
  if (!Array.isArray(limitations) || !limitations.every((item) => typeof item === 'string')) {
    throw new DatabaseUpstreamError('Postgres returned invalid coverage limitations JSON')
  }
  const last = selected.at(-1)
  const nextCursor =
    hasMore && last
      ? encodeAllocationHistoryCursor({
          version: 2,
          projectionId: projection.projection_id,
          runId: projection.run_id,
          projection: 'full',
          direction: input.direction,
          endBlock: Number(last.end_block),
          entryId: last.entry_id
        })
      : null

  return {
    schemaVersion: ALLOCATION_SCHEMA_VERSION,
    projection: 'full',
    generatedAt: Number(projection.generated_at),
    direction: input.direction,
    dataQuality: {
      certification: projection.coverage_safe_for_timeline ? 'certified' : 'provisional',
      limitations
    },
    vault: jsonObject(projection.vault_payload, 'vault metadata'),
    entries,
    pagination: {
      limit: input.limit,
      returned: entries.length,
      hasMore,
      nextCursor
    }
  }
}

function projectionLimitations(projection: ProjectionRow): string[] {
  const limitations = jsonObject(projection.coverage_known_gaps, 'coverage limitations')
  if (!Array.isArray(limitations) || !limitations.every((item) => typeof item === 'string')) {
    throw new DatabaseUpstreamError('Postgres returned invalid coverage limitations JSON')
  }
  return limitations
}

function materializedChartPayload(
  value: MaterializedAllocationChartPayload | string,
  label: string
): MaterializedAllocationChartPayload {
  const payload = jsonObject(value, label)
  if (
    !payload ||
    typeof payload !== 'object' ||
    !payload.data ||
    typeof payload.data !== 'object' ||
    !payload.strategies ||
    typeof payload.strategies !== 'object' ||
    Array.isArray(payload.strategies)
  ) {
    throw new DatabaseUpstreamError(`Postgres returned invalid ${label} JSON`)
  }
  return payload
}

function addStrategyNames(target: Record<string, string | null>, source: Record<string, string | null>): void {
  for (const [address, name] of Object.entries(source)) {
    if (!(address in target) || name !== null) target[address] = name
  }
}

function addBoundaryId(
  ids: Set<string>,
  presentEntryIds: ReadonlySet<string>,
  interval: AllocationChartInterval | null
): void {
  if (interval && !presentEntryIds.has(interval.fromEntryId)) ids.add(interval.fromEntryId)
}

export async function readMaterializedAllocationChart(
  input: {
    vault: TestVault
    limit: number
    direction: TimelineDirection
    cursor?: string | null
  },
  queryable: DatabaseQueryable = databasePool()
): Promise<VaultAllocationChartResponse> {
  const cursor = input.cursor ? decodeAllocationHistoryCursor(input.cursor, input.direction, 'chart') : null
  let projection: ProjectionRow
  try {
    projection = await projectionForPage(queryable, input.vault, cursor)
  } catch (error) {
    if (error instanceof AllocationHistoryCursorError) throw error
    if (error instanceof AllocationHistoryNotMaterializedError) throw error
    if (error instanceof DatabaseUpstreamError) throw error
    throw new DatabaseUpstreamError('Unable to read the active allocation chart materialization', { cause: error })
  }
  if (projection.materializer_version !== ALLOCATION_MATERIALIZER_VERSION) {
    throw new AllocationHistoryNotMaterializedError(
      'Allocation chart projection has not been materialized for this vault'
    )
  }

  const comparison = input.direction === 'desc' ? '<' : '>'
  const order = input.direction === 'desc' ? 'DESC' : 'ASC'
  const values: unknown[] = [projection.run_id, input.limit + 1]
  let cursorClause = ''
  if (cursor) {
    values.push(cursor.endBlock, cursor.entryId)
    cursorClause = `AND (e.end_block, e.entry_id) ${comparison} ($3::bigint, $4::text)`
  }

  let result: QueryResult<EntryRow<MaterializedAllocationChartPayload>>
  let currentSnapshotPayload: MaterializedAllocationChartPayload | null = null
  let currentSnapshot: AllocationChartCurrentSnapshot | null = null
  try {
    result = await queryable.query<EntryRow<MaterializedAllocationChartPayload>>(
      `SELECT entry_id, end_block::text, chart_payload AS payload
       FROM allocation_history_entry AS e
       WHERE e.run_id = $1::bigint
         AND e.kind = 'strategy_reallocation'
         AND e.chart_payload IS NOT NULL
         ${cursorClause}
       ORDER BY e.end_block ${order}, e.entry_id ${order}
       LIMIT $2`,
      values
    )
    if (!cursor) {
      const snapshot = await queryable.query<EntryRow<MaterializedAllocationChartPayload>>(
        `SELECT entry_id, end_block::text, chart_payload AS payload
         FROM allocation_history_entry
         WHERE run_id = $1::bigint
           AND kind = 'current_snapshot'
           AND chart_payload IS NOT NULL
         LIMIT 1`,
        [projection.run_id]
      )
      if (!snapshot.rows[0]) {
        throw new AllocationHistoryNotMaterializedError(
          'Allocation chart current snapshot has not been materialized for this vault'
        )
      }
      currentSnapshotPayload = materializedChartPayload(snapshot.rows[0].payload, 'allocation chart current snapshot')
      if (currentSnapshotPayload.data.kind !== 'current_snapshot') {
        throw new DatabaseUpstreamError('Postgres returned an invalid allocation chart current snapshot')
      }
      currentSnapshot = currentSnapshotPayload.data
    }
  } catch (error) {
    if (error instanceof AllocationHistoryNotMaterializedError) throw error
    throw new DatabaseUpstreamError('Unable to read materialized allocation chart entries', { cause: error })
  }

  const hasMore = result.rows.length > input.limit
  const selected = result.rows.slice(0, input.limit)
  const selectedPayloads = selected.map((row) => materializedChartPayload(row.payload, 'allocation chart entry'))
  const entries = selectedPayloads.map((payload) => {
    if (payload.data.kind !== 'strategy_reallocation') {
      throw new DatabaseUpstreamError('Postgres returned an invalid allocation chart entry')
    }
    return payload.data
  })
  const strategies: Record<string, string | null> = {}
  for (const payload of selectedPayloads) addStrategyNames(strategies, payload.strategies)
  if (currentSnapshotPayload) addStrategyNames(strategies, currentSnapshotPayload.strategies)

  const presentEntryIds = new Set(entries.map((entry) => entry.id))
  const boundaryIds = new Set<string>()
  for (const entry of entries) addBoundaryId(boundaryIds, presentEntryIds, entry.interval)
  addBoundaryId(boundaryIds, presentEntryIds, currentSnapshot?.interval ?? null)
  const boundaryStates: Record<string, AllocationChartState> = {}
  if (boundaryIds.size > 0) {
    let boundaryResult: QueryResult<EntryRow<MaterializedAllocationChartPayload>>
    try {
      boundaryResult = await queryable.query<EntryRow<MaterializedAllocationChartPayload>>(
        `SELECT entry_id, end_block::text, chart_payload AS payload
         FROM allocation_history_entry
         WHERE run_id = $1::bigint
           AND entry_id = ANY($2::text[])
           AND kind = 'strategy_reallocation'
           AND chart_payload IS NOT NULL`,
        [projection.run_id, [...boundaryIds]]
      )
    } catch (error) {
      throw new DatabaseUpstreamError('Unable to read allocation chart boundary states', { cause: error })
    }
    for (const row of boundaryResult.rows) {
      const payload = materializedChartPayload(row.payload, 'allocation chart boundary state')
      if (payload.data.kind !== 'strategy_reallocation') continue
      boundaryStates[row.entry_id] = payload.data.after
      addStrategyNames(
        strategies,
        Object.fromEntries(
          payload.data.after.allocations.map(({ strategyAddress }) => [
            strategyAddress,
            payload.strategies[strategyAddress] ?? null
          ])
        )
      )
      boundaryIds.delete(row.entry_id)
    }
    if (boundaryIds.size > 0) {
      throw new DatabaseUpstreamError('Allocation chart boundary state is unavailable')
    }
  }
  const last = selected.at(-1)
  const nextCursor =
    hasMore && last
      ? encodeAllocationHistoryCursor({
          version: 2,
          projectionId: projection.projection_id,
          runId: projection.run_id,
          projection: 'chart',
          direction: input.direction,
          endBlock: Number(last.end_block),
          entryId: last.entry_id
        })
      : null

  return {
    schemaVersion: ALLOCATION_SCHEMA_VERSION,
    projection: 'chart',
    generatedAt: Number(projection.generated_at),
    direction: input.direction,
    dataQuality: {
      certification: projection.coverage_safe_for_timeline ? 'certified' : 'provisional',
      limitations: projectionLimitations(projection)
    },
    vault: ((vault) => ({
      chainId: vault.chainId,
      address: vault.address,
      name: vault.name
    }))(jsonObject(projection.vault_payload, 'vault metadata')),
    strategies,
    boundaryStates,
    currentSnapshot,
    entries,
    pagination: { nextCursor }
  }
}

async function projectionForEntry(
  queryable: DatabaseQueryable,
  vault: TestVault,
  runId: string | null
): Promise<ProjectionRow> {
  const values = runId
    ? [vault.chainId, vault.address.toLowerCase(), runId]
    : [vault.chainId, vault.address.toLowerCase()]
  const where = runId ? 'r.id = $3::bigint' : 'r.id = p.active_run_id'
  const result = await queryable.query<ProjectionRow>(
    `SELECT
       p.id::text AS projection_id,
       r.id::text AS run_id,
       r.schema_version,
       r.materializer_version,
       r.generated_at::text,
       r.coverage_safe_for_timeline,
       r.coverage_known_gaps,
       r.vault_payload
     FROM allocation_history_projection p
     JOIN allocation_history_run r ON r.projection_id = p.id
     WHERE p.chain_id = $1
       AND p.vault_address = $2
       AND ${where}
       AND r.status = 'succeeded'
     LIMIT 1`,
    values
  )
  const row = result.rows[0]
  if (!row && runId) throw new AllocationHistoryEntryNotFoundError()
  if (row?.schema_version !== ALLOCATION_SCHEMA_VERSION || row.generated_at === null || row.vault_payload === null) {
    throw new AllocationHistoryNotMaterializedError()
  }
  return row
}

export async function readMaterializedAllocationEntry(
  input: {
    vault: TestVault
    entryId: string
    runId?: string | null
  },
  queryable: DatabaseQueryable = databasePool()
): Promise<VaultAllocationHistoryEntryResponse> {
  let projection: ProjectionRow
  try {
    projection = await projectionForEntry(queryable, input.vault, input.runId ?? null)
    const result = await queryable.query<EntryRow>(
      `SELECT entry_id, end_block::text, payload, chart_payload
       FROM allocation_history_entry
       WHERE run_id = $1::bigint AND entry_id = $2
       LIMIT 1`,
      [projection.run_id, input.entryId]
    )
    const row = result.rows[0]
    if (!row) throw new AllocationHistoryEntryNotFoundError()
    return {
      schemaVersion: ALLOCATION_SCHEMA_VERSION,
      projection: 'detail',
      generatedAt: Number(projection.generated_at),
      dataQuality: {
        certification: projection.coverage_safe_for_timeline ? 'certified' : 'provisional',
        limitations: projectionLimitations(projection)
      },
      vault: jsonObject(projection.vault_payload, 'vault metadata'),
      entry: jsonObject(row.payload, 'allocation entry'),
      interval:
        row.chart_payload && projection.materializer_version === ALLOCATION_MATERIALIZER_VERSION
          ? materializedChartPayload(row.chart_payload, 'allocation detail interval').detailInterval
          : null
    }
  } catch (error) {
    if (
      error instanceof AllocationHistoryEntryNotFoundError ||
      error instanceof AllocationHistoryNotMaterializedError ||
      error instanceof DatabaseUpstreamError
    ) {
      throw error
    }
    throw new DatabaseUpstreamError('Unable to read materialized allocation entry', { cause: error })
  }
}

export interface MaterializationRun {
  id: string
  projectionId: string
}

function staleRunSeconds(): number {
  const parsed = Number.parseInt(process.env.ALLOCATION_STALE_RUN_SECONDS ?? '', 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_STALE_RUN_SECONDS
}

export async function startMaterializationRun(input: {
  vault: TestVault
  mode: 'backfill' | 'refresh'
}): Promise<MaterializationRun> {
  return withDatabaseTransaction(async (client) => {
    const projection = await client.query<{ id: string }>(
      `INSERT INTO allocation_history_projection (chain_id, vault_address, vault_label)
       VALUES ($1, $2, $3)
       ON CONFLICT (chain_id, vault_address)
       DO UPDATE SET vault_label = EXCLUDED.vault_label, updated_at = now()
       RETURNING id::text`,
      [input.vault.chainId, input.vault.address.toLowerCase(), input.vault.label]
    )
    const projectionId = projection.rows[0]?.id
    if (!projectionId) throw new Error('Projection insert did not return an ID')

    const running = await client.query<{ id: string; is_stale: boolean }>(
      `SELECT
         id::text,
         started_at < now() - ($2::integer * interval '1 second') AS is_stale
       FROM allocation_history_run
       WHERE projection_id = $1::bigint AND status = 'running'
       FOR UPDATE`,
      [projectionId, staleRunSeconds()]
    )
    const current = running.rows[0]
    if (current && !current.is_stale) {
      throw new DatabaseUpstreamError(`A materialization run is already active for ${input.vault.label}`)
    }
    if (current) {
      await client.query(
        `UPDATE allocation_history_run
         SET status = 'failed',
             error_code = 'StaleRunReplaced',
             error_detail = 'A newer materialization replaced this stale running run',
             completed_at = now()
         WHERE id = $1::bigint`,
        [current.id]
      )
    }

    const run = await client.query<RunRow>(
      `INSERT INTO allocation_history_run (
         projection_id, mode, status, schema_version, materializer_version
       ) VALUES ($1::bigint, $2, 'running', $3, $4)
       RETURNING id::text, projection_id::text`,
      [projectionId, input.mode, ALLOCATION_SCHEMA_VERSION, ALLOCATION_MATERIALIZER_VERSION]
    )
    const row = run.rows[0]
    if (!row) throw new Error('Materialization run insert did not return an ID')
    return { id: row.id, projectionId: row.projection_id }
  })
}

export async function failMaterializationRun(runId: string, error: unknown): Promise<void> {
  const detail = (error instanceof Error ? error.message : String(error)).slice(0, 2_000)
  await databaseQuery(
    `UPDATE allocation_history_run
     SET status = 'failed', error_code = $2, error_detail = $3, completed_at = now()
     WHERE id = $1::bigint AND status = 'running'`,
    [runId, error instanceof Error ? error.name : 'UnknownError', detail]
  )
}

export async function completeMaterializationRun(input: {
  run: MaterializationRun
  generatedAt: number
  safeBlock: { blockNumber: number; blockTimestamp: number }
  coverage: VaultAllocationCoverage
  vault: VaultAllocationVault
  entries: readonly AllocationHistoryEntry[]
  sourceEvents?: readonly AllocationSourceEvent[]
  allocatorDeployments?: readonly AllocatorDeploymentEvidence[]
  allowProvisional?: boolean
}): Promise<void> {
  const coverageIssues = allocationCoverageContractIssues(input.coverage)
  const certified = input.coverage.safeForTimeline && coverageIssues.length === 0
  if (!certified && !input.allowProvisional) {
    throw new DatabaseUpstreamError(
      `Refusing to activate uncertified allocation history${coverageIssues.length > 0 ? `: ${coverageIssues.join(', ')}` : ''}`
    )
  }
  if (!certified && input.coverage.knownGaps.length === 0) {
    throw new DatabaseUpstreamError('Refusing to activate provisional allocation history without limitations')
  }
  if (
    !Number.isSafeInteger(input.generatedAt) ||
    !Number.isSafeInteger(input.safeBlock.blockNumber) ||
    !Number.isSafeInteger(input.safeBlock.blockTimestamp) ||
    input.safeBlock.blockNumber < input.coverage.coverageStartBlock ||
    input.safeBlock.blockNumber > input.coverage.validatedThroughBlock
  ) {
    throw new DatabaseUpstreamError('Refusing to activate allocation history with invalid block bounds')
  }
  if (
    input.vault.chainId !== input.coverage.chainId ||
    input.vault.address.toLowerCase() !== input.coverage.vaultAddress.toLowerCase()
  ) {
    throw new DatabaseUpstreamError('Refusing to activate allocation history for mismatched vault coverage')
  }
  const currentSnapshots = input.entries.filter((entry) => entry.kind === 'current_snapshot')
  if (
    currentSnapshots.length !== 1 ||
    currentSnapshots[0].endBlock !== input.safeBlock.blockNumber ||
    currentSnapshots[0].endTimestamp !== input.safeBlock.blockTimestamp ||
    new Set(input.entries.map((entry) => entry.id)).size !== input.entries.length
  ) {
    throw new DatabaseUpstreamError('Refusing to activate an incomplete allocation history projection')
  }
  for (const entry of input.entries) {
    const states = entry.before ? [entry.before, entry.after] : [entry.after]
    if (
      states.some(
        (state) =>
          state.accountingChecks.totalAssetsEqualsDebtPlusIdle !== true ||
          state.accountingChecks.strategyDebtSumEqualsTotalDebt !== true
      )
    ) {
      throw new DatabaseUpstreamError(`Refusing to activate unreconciled allocation entry ${entry.id}`)
    }
  }
  const flowIntervals = buildAllocationFlowIntervals({
    entries: input.entries,
    events: input.sourceEvents ?? [],
    vaultAddress: input.vault.address
  })
  for (const [entryId, interval] of flowIntervals) {
    const unattributedAmount = interval.flows
      .filter((flow) => flow.kind === 'unattributed_asset_change')
      .reduce((sum, flow) => sum + BigInt(flow.amount), 0n)
    if (
      interval.reconciliation.balanceStatus !== 'reconciled' ||
      interval.reconciliation.residuals.some((residual) => residual.residualAmount !== '0') ||
      unattributedAmount.toString() !== interval.reconciliation.unattributedAmount
    ) {
      throw new DatabaseUpstreamError(`Refusing to activate unreconciled allocation interval for ${entryId}`)
    }
  }

  await withDatabaseTransaction(async (client) => {
    const run = await client.query<RunRow>(
      `SELECT id::text, projection_id::text
       FROM allocation_history_run
       WHERE id = $1::bigint AND projection_id = $2::bigint AND status = 'running'
       FOR UPDATE`,
      [input.run.id, input.run.projectionId]
    )
    if (!run.rows[0]) throw new Error('Materialization run is no longer active')

    for (let start = 0; start < input.entries.length; start += ENTRY_INSERT_BATCH_SIZE) {
      const page = input.entries.slice(start, start + ENTRY_INSERT_BATCH_SIZE).map((entry) => ({
        entry_id: entry.id,
        kind: entry.kind,
        start_block: entry.startBlock,
        end_block: entry.endBlock,
        start_timestamp: entry.startTimestamp,
        end_timestamp: entry.endTimestamp,
        payload: entry,
        chart_payload: buildAllocationChartPayload(
          entry,
          input.vault,
          input.run.id,
          flowIntervals.get(entry.id) ?? null
        )
      }))
      await client.query(
        `INSERT INTO allocation_history_entry (
           run_id, entry_id, kind, start_block, end_block,
           start_timestamp, end_timestamp, payload, chart_payload
         )
         SELECT
           $1::bigint,
           item.entry_id,
           item.kind,
           item.start_block,
           item.end_block,
           item.start_timestamp,
           item.end_timestamp,
           item.payload,
           item.chart_payload
         FROM jsonb_to_recordset($2::jsonb) AS item(
           entry_id text,
           kind text,
           start_block bigint,
           end_block bigint,
           start_timestamp bigint,
           end_timestamp bigint,
           payload jsonb,
           chart_payload jsonb
         )`,
        [input.run.id, JSON.stringify(page)]
      )
    }

    const completed = await client.query(
      `UPDATE allocation_history_run
       SET status = 'succeeded',
           generated_at = $2,
           safe_block = $3,
           safe_block_timestamp = $4,
           coverage_start_block = $5,
           coverage_start_block_hash = $6,
           validated_through_block = $7,
           validated_through_block_hash = $8,
           coverage_revision = $9,
           coverage_producer_commit = $10,
           coverage_safe_for_timeline = $11,
           coverage_known_gaps = $12::jsonb,
           vault_payload = $13::jsonb,
           entry_count = $14,
           allocator_evidence = $15::jsonb,
           completed_at = now()
       WHERE id = $1::bigint`,
      [
        input.run.id,
        input.generatedAt,
        input.safeBlock.blockNumber,
        input.safeBlock.blockTimestamp,
        input.coverage.coverageStartBlock,
        input.coverage.coverageStartBlockHash,
        input.coverage.validatedThroughBlock,
        input.coverage.validatedThroughBlockHash,
        input.coverage.coverageRevision,
        input.coverage.producerCommit,
        input.coverage.safeForTimeline,
        JSON.stringify(input.coverage.knownGaps),
        JSON.stringify(input.vault),
        input.entries.length,
        JSON.stringify({
          deployments: input.allocatorDeployments ?? [],
          events: (input.sourceEvents ?? []).filter(
            (event) =>
              event.sourceLabel === 'debtAllocator' ||
              event.sourceLabel === 'roleManager' ||
              event.eventName === 'UpdateRoleManager'
          )
        })
      ]
    )
    if (completed.rowCount !== 1) throw new Error('Materialization run completion failed')
    const activated = await client.query(
      `UPDATE allocation_history_projection
       SET active_run_id = $2::bigint, updated_at = now()
       WHERE id = $1::bigint`,
      [input.run.projectionId, input.run.id]
    )
    if (activated.rowCount !== 1) throw new Error('Materialization projection activation failed')
  })
}

export async function probeDatabase(): Promise<boolean> {
  try {
    const result = await databaseQuery<{ ok: number }>('SELECT 1 AS ok')
    return result.rows[0]?.ok === 1
  } catch {
    return false
  }
}

export interface AllocationMaterializationStatus {
  chainId: number
  vaultAddress: string
  vaultLabel: string
  runId: string | null
  generatedAt: number | null
  safeBlock: number | null
  coverageRevision: string | null
  coverageSafeForTimeline: boolean | null
  schemaVersion: number | null
  materializerVersion: string | null
  entryCount: number | null
  completedAt: string | null
  latestAttemptStatus: 'running' | 'succeeded' | 'failed' | null
  latestAttemptErrorCode: string | null
  latestAttemptStartedAt: string | null
  latestAttemptCompletedAt: string | null
}

export async function readAllocationMaterializationStatuses(): Promise<AllocationMaterializationStatus[]> {
  const result = await databaseQuery<{
    chain_id: number
    vault_address: string
    vault_label: string
    run_id: string | null
    generated_at: string | null
    safe_block: string | null
    coverage_revision: string | null
    coverage_safe_for_timeline: boolean | null
    schema_version: number | null
    materializer_version: string | null
    entry_count: number | null
    completed_at: Date | string | null
    latest_attempt_status: 'running' | 'succeeded' | 'failed' | null
    latest_attempt_error_code: string | null
    latest_attempt_started_at: Date | string | null
    latest_attempt_completed_at: Date | string | null
  }>(
    `SELECT
       p.chain_id,
       p.vault_address,
       p.vault_label,
       r.id::text AS run_id,
       r.generated_at::text,
       r.safe_block::text,
       r.coverage_revision,
       r.coverage_safe_for_timeline,
       r.schema_version,
       r.materializer_version,
       r.entry_count,
       r.completed_at,
       latest.status AS latest_attempt_status,
       latest.error_code AS latest_attempt_error_code,
       latest.started_at AS latest_attempt_started_at,
       latest.completed_at AS latest_attempt_completed_at
     FROM allocation_history_projection p
     LEFT JOIN allocation_history_run r ON r.id = p.active_run_id
     LEFT JOIN LATERAL (
       SELECT status, error_code, started_at, completed_at
       FROM allocation_history_run candidate
       WHERE candidate.projection_id = p.id
       ORDER BY candidate.id DESC
       LIMIT 1
     ) latest ON true
     ORDER BY p.chain_id, p.vault_address`
  )
  const timestamp = (value: Date | string | null): string | null =>
    value instanceof Date ? value.toISOString() : value
  return result.rows.map((row) => ({
    chainId: row.chain_id,
    vaultAddress: row.vault_address,
    vaultLabel: row.vault_label,
    runId: row.run_id,
    generatedAt: row.generated_at === null ? null : Number(row.generated_at),
    safeBlock: row.safe_block === null ? null : Number(row.safe_block),
    coverageRevision: row.coverage_revision,
    coverageSafeForTimeline: row.coverage_safe_for_timeline,
    schemaVersion: row.schema_version,
    materializerVersion: row.materializer_version,
    entryCount: row.entry_count,
    completedAt: timestamp(row.completed_at),
    latestAttemptStatus: row.latest_attempt_status,
    latestAttemptErrorCode: row.latest_attempt_error_code,
    latestAttemptStartedAt: timestamp(row.latest_attempt_started_at),
    latestAttemptCompletedAt: timestamp(row.latest_attempt_completed_at)
  }))
}
