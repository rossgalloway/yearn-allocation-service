import type { QueryResult, QueryResultRow } from 'pg'
import { describe, expect, it } from 'vitest'
import type { DatabaseQueryable } from '@/lib/database/client'
import { buildAllocationChartPayload } from './chart'
import { buildAllocationFlowIntervals } from './flow-ledger'
import {
  ALLOCATION_MATERIALIZER_VERSION,
  readMaterializedAllocationChart,
  readMaterializedAllocationEntry,
  readMaterializedAllocationHistory
} from './repository'
import type { Address, AllocationHistoryEntry } from './types'
import type { TestVault } from './vaults'

const vault: TestVault = {
  chainId: 1,
  address: '0x00000000000000000000000000000000000000aa',
  label: 'yvUSDC-1'
}

function queryResult<Row extends QueryResultRow>(rows: Row[]): QueryResult<Row> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows }
}

function entry(
  id: string,
  block: number,
  kind: AllocationHistoryEntry['kind'] = 'idle_deployment'
): AllocationHistoryEntry {
  const state = {
    blockNumber: block,
    blockTimestamp: block * 10,
    source: 'archive_rpc' as const,
    totalAssets: '100',
    totalDebt: '100',
    totalIdle: '0',
    unallocatedBps: null,
    unallocatedSource: null,
    unallocatedCheckpointId: null,
    allocatorAddress: null,
    allocations: [],
    accountingChecks: { totalAssetsEqualsDebtPlusIdle: true, strategyDebtSumEqualsTotalDebt: true }
  }
  return {
    id,
    kind,
    startBlock: block,
    endBlock: block,
    startTimestamp: block * 10,
    endTimestamp: block * 10,
    before: kind === 'current_snapshot' ? null : state,
    after: state,
    changes: { totalDebtDelta: '0', totalIdleDelta: '0', strategies: [] },
    policy: null,
    operations: [],
    execution: {
      automation: 'automatic',
      mechanism: 'allocator_keeper',
      targetStatus: 'matched',
      transactions: []
    },
    classification: { confidence: 'high', evidence: [], limitations: [] },
    detailsAvailable: false
  }
}

class FakeDatabase implements DatabaseQueryable {
  activeRun = '7'
  readonly intervals: ReturnType<typeof buildAllocationFlowIntervals>
  constructor(
    readonly entries: AllocationHistoryEntry[] = [entry('entry-b', 100), entry('entry-a', 100), entry('entry-c', 90)]
  ) {
    this.intervals = buildAllocationFlowIntervals({ entries, events: [], vaultAddress: vault.address })
  }

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<QueryResult<Row>> {
    if (text.includes('FROM allocation_history_projection p')) {
      const runId = values.length === 4 ? String(values[3]) : values.length === 3 ? String(values[2]) : this.activeRun
      return queryResult([
        {
          projection_id: '3',
          run_id: runId,
          schema_version: 2,
          materializer_version: ALLOCATION_MATERIALIZER_VERSION,
          generated_at: '1000',
          coverage_safe_for_timeline: true,
          coverage_known_gaps: [],
          vault_payload: {
            chainId: 1,
            address: vault.address.toLowerCase() as Address,
            name: 'Test vault',
            symbol: 'yvTEST',
            assetAddress: null,
            assetSymbol: 'TEST',
            assetDecimals: 6
          }
        } as unknown as Row
      ])
    }
    if (text.includes('FROM allocation_history_entry')) {
      if (text.includes("kind = 'current_snapshot'")) {
        const item = this.entries.find((entry) => entry.kind === 'current_snapshot')
        const rows = item
          ? [
              {
                entry_id: item.id,
                end_block: String(item.endBlock),
                payload: buildAllocationChartPayload(
                  item,
                  vaultPayload(),
                  String(values[0]),
                  this.intervals.get(item.id)
                )
              } as unknown as Row
            ]
          : []
        return queryResult(rows)
      }
      if (text.includes('entry_id = ANY')) {
        const ids = new Set(values[1] as string[])
        return queryResult(
          this.entries
            .filter((item) => ids.has(item.id) && item.kind === 'strategy_reallocation')
            .map(
              (item) =>
                ({
                  entry_id: item.id,
                  end_block: String(item.endBlock),
                  payload: buildAllocationChartPayload(
                    item,
                    vaultPayload(),
                    String(values[0]),
                    this.intervals.get(item.id)
                  )
                }) as unknown as Row
            )
        )
      }
      if (text.includes('entry_id = $2')) {
        const item = this.entries.find((entry) => entry.id === String(values[1]))
        return queryResult(
          item
            ? ([
                {
                  entry_id: item.id,
                  end_block: String(item.endBlock),
                  payload: item,
                  chart_payload: buildAllocationChartPayload(
                    item,
                    vaultPayload(),
                    String(values[0]),
                    this.intervals.get(item.id)
                  )
                }
              ] as unknown as Row[])
            : []
        )
      }
      const chart = text.includes('chart_payload AS payload')
      const descending = /ORDER BY (?:e\.)?end_block DESC/.test(text)
      const cursorBlock = values.length === 4 ? Number(values[2]) : null
      const cursorId = values.length === 4 ? String(values[3]) : null
      const limit = Number(values[1])
      const rows = this.entries
        .filter((item) => {
          if (chart && item.kind !== 'strategy_reallocation') {
            return false
          }
          if (cursorBlock === null || cursorId === null) return true
          const comparison = item.endBlock - cursorBlock || item.id.localeCompare(cursorId)
          return descending ? comparison < 0 : comparison > 0
        })
        .sort((left, right) => {
          const comparison = left.endBlock - right.endBlock || left.id.localeCompare(right.id)
          return descending ? -comparison : comparison
        })
        .slice(0, limit)
        .map(
          (item) =>
            ({
              entry_id: item.id,
              end_block: String(item.endBlock),
              payload: chart
                ? buildAllocationChartPayload(item, vaultPayload(), String(values[0]), this.intervals.get(item.id))
                : item
            }) as unknown as Row
        )
      return queryResult(rows)
    }
    throw new Error(`Unexpected query: ${text}`)
  }
}

function vaultPayload() {
  return {
    chainId: 1,
    address: vault.address.toLowerCase() as Address,
    name: 'Test vault',
    symbol: 'yvTEST',
    assetAddress: null,
    assetSymbol: 'TEST',
    assetDecimals: 6
  }
}

describe('materialized allocation history repository', () => {
  it('keyset-paginates same-block entries without gaps and pins the run', async () => {
    const database = new FakeDatabase()
    const first = await readMaterializedAllocationHistory({ vault, limit: 2, direction: 'desc' }, database)
    expect(first.entries.map((item) => item.id)).toEqual(['entry-b', 'entry-a'])
    expect(first.pagination.hasMore).toBe(true)
    expect(first.pagination.nextCursor).not.toBeNull()

    database.activeRun = '8'
    const second = await readMaterializedAllocationHistory(
      { vault, limit: 2, direction: 'desc', cursor: first.pagination.nextCursor },
      database
    )
    expect(second.entries.map((item) => item.id)).toEqual(['entry-c'])
    expect(second.pagination).toMatchObject({ returned: 1, hasMore: false, nextCursor: null })
  })

  it('orders the same materialized run in ascending direction', async () => {
    const result = await readMaterializedAllocationHistory({ vault, limit: 3, direction: 'asc' }, new FakeDatabase())

    expect(result.entries.map((item) => item.id)).toEqual(['entry-c', 'entry-a', 'entry-b'])
  })

  it('filters chart kinds before limiting and returns the current snapshot separately', async () => {
    const database = new FakeDatabase([
      entry('current:110', 110, 'current_snapshot'),
      entry('config:105', 105, 'configuration_change'),
      entry('flow:100', 100, 'idle_deployment'),
      entry('flow:90', 90, 'strategy_reallocation'),
      entry('flow:80', 80, 'strategy_reallocation')
    ])

    const first = await readMaterializedAllocationChart({ vault, limit: 1, direction: 'desc' }, database)
    expect(first.projection).toBe('chart')
    expect(first.vault).toEqual({ chainId: 1, address: vault.address, name: 'Test vault' })
    expect(first.currentSnapshot?.id).toBe('current:110')
    expect(first.entries.map((item) => item.id)).toEqual(['flow:90'])
    expect(first.boundaryStates['flow:80']?.blockNumber).toBe(80)
    expect(first.currentSnapshot?.interval?.fromEntryId).toBe('flow:90')
    expect(first.pagination.nextCursor).not.toBeNull()
    expect(first.pagination).toEqual({ nextCursor: expect.any(String) })

    const second = await readMaterializedAllocationChart(
      { vault, limit: 1, direction: 'desc', cursor: first.pagination.nextCursor },
      database
    )
    expect(second.currentSnapshot).toBeNull()
    expect(second.entries.map((item) => item.id)).toEqual(['flow:80'])
    expect(second.pagination).toEqual({ nextCursor: null })

    await expect(
      readMaterializedAllocationHistory(
        { vault, limit: 1, direction: 'desc', cursor: first.pagination.nextCursor },
        database
      )
    ).rejects.toThrow('Invalid allocation history cursor')
  })

  it('reads run-pinned full entry details', async () => {
    const result = await readMaterializedAllocationEntry({ vault, entryId: 'entry-a', runId: '7' }, new FakeDatabase())

    expect(result).toMatchObject({
      schemaVersion: 2,
      projection: 'detail',
      entry: { id: 'entry-a' }
    })
  })

  it('keeps complete interval equations behind the detail route', async () => {
    const database = new FakeDatabase([
      entry('flow:90', 90, 'strategy_reallocation'),
      entry('flow:100', 100, 'strategy_reallocation')
    ])

    const result = await readMaterializedAllocationEntry({ vault, entryId: 'flow:100', runId: '7' }, database)

    expect(result.interval).toMatchObject({
      fromEntryId: 'flow:90',
      toEntryId: 'flow:100',
      reconciliation: { balanceStatus: 'reconciled', residuals: expect.any(Array) }
    })
  })
})
