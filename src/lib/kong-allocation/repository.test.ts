import type { QueryResult, QueryResultRow } from 'pg'
import { describe, expect, it } from 'vitest'
import type { DatabaseQueryable } from '@/lib/database/client'
import { readMaterializedAllocationHistory } from './repository'
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

function entry(id: string, block: number): AllocationHistoryEntry {
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
    kind: 'idle_deployment',
    startBlock: block,
    endBlock: block,
    startTimestamp: block * 10,
    endTimestamp: block * 10,
    before: state,
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
  readonly entries = [entry('entry-b', 100), entry('entry-a', 100), entry('entry-c', 90)]

  async query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values: readonly unknown[] = []
  ): Promise<QueryResult<Row>> {
    if (text.includes('FROM allocation_history_projection p')) {
      const runId = values.length === 4 ? String(values[3]) : this.activeRun
      return queryResult([
        {
          projection_id: '3',
          run_id: runId,
          schema_version: 2,
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
      const descending = text.includes('ORDER BY end_block DESC')
      const cursorBlock = values.length === 4 ? Number(values[2]) : null
      const cursorId = values.length === 4 ? String(values[3]) : null
      const limit = Number(values[1])
      const rows = this.entries
        .filter((item) => {
          if (cursorBlock === null || cursorId === null) return true
          const comparison = item.endBlock - cursorBlock || item.id.localeCompare(cursorId)
          return descending ? comparison < 0 : comparison > 0
        })
        .sort((left, right) => {
          const comparison = left.endBlock - right.endBlock || left.id.localeCompare(right.id)
          return descending ? -comparison : comparison
        })
        .slice(0, limit)
        .map((item) => ({ entry_id: item.id, end_block: String(item.endBlock), payload: item }) as unknown as Row)
      return queryResult(rows)
    }
    throw new Error(`Unexpected query: ${text}`)
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
})
