import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { databasePool } from '@/lib/database/client'
import { runDatabaseMigrations } from '@/lib/database/migrations'
import type { VaultAllocationCoverage } from '@/lib/envio/types'
import {
  completeMaterializationRun,
  failMaterializationRun,
  readMaterializedAllocationChart,
  readMaterializedAllocationEntry,
  readMaterializedAllocationHistory,
  startMaterializationRun
} from './repository'
import type { Address, AllocationEntryState, AllocationHistoryEntry, VaultAllocationVault } from './types'
import type { TestVault } from './vaults'

const testDatabaseUrl = process.env.TEST_DATABASE_URL?.trim()
const databaseUrl = process.env.DATABASE_URL?.trim()
const describeDatabase = testDatabaseUrl && testDatabaseUrl === databaseUrl ? describe.sequential : describe.skip
const address = `0x${process.pid.toString(16).padStart(40, '0').slice(-40)}` as Address
const vault: TestVault = { chainId: 1, address, label: 'yvUSDC-1' }
const vaultPayload: VaultAllocationVault = {
  chainId: 1,
  address,
  name: 'Integration vault',
  symbol: 'yvTEST',
  assetAddress: null,
  assetSymbol: 'TEST',
  assetDecimals: 6
}
const coverage: VaultAllocationCoverage = {
  id: `integration:1:${address}`,
  chainId: 1,
  vaultAddress: address,
  coverageStartBlock: 90,
  coverageStartBlockHash: `0x${'1'.repeat(64)}`,
  validatedThroughBlock: 200,
  validatedThroughBlockHash: `0x${'2'.repeat(64)}`,
  vaultDiscoveryComplete: true,
  eventHistoryComplete: true,
  allocatorDeploymentHistoryComplete: true,
  allocatorAssignmentHistoryComplete: true,
  checkpointTriggerAuditComplete: true,
  safeForTimeline: true,
  knownGaps: [],
  coverageRevision: 'integration-test',
  producerCommit: 'a'.repeat(40),
  validatedAt: new Date(0).toISOString()
}

function state(blockNumber: number): AllocationEntryState {
  return {
    blockNumber,
    blockTimestamp: blockNumber * 10,
    source: 'archive_rpc',
    totalAssets: '100',
    totalDebt: '100',
    totalIdle: '0',
    unallocatedBps: null,
    unallocatedSource: null,
    unallocatedCheckpointId: null,
    allocatorAddress: null,
    allocations: [],
    accountingChecks: {
      totalAssetsEqualsDebtPlusIdle: true,
      strategyDebtSumEqualsTotalDebt: true
    }
  }
}

function entry(id: string, blockNumber: number, kind: AllocationHistoryEntry['kind']): AllocationHistoryEntry {
  const after = state(blockNumber)
  return {
    id,
    kind,
    startBlock: blockNumber,
    endBlock: blockNumber,
    startTimestamp: after.blockTimestamp,
    endTimestamp: after.blockTimestamp,
    before: kind === 'current_snapshot' ? null : state(blockNumber - 1),
    after,
    changes: { totalDebtDelta: null, totalIdleDelta: null, strategies: [] },
    policy: null,
    operations: [],
    execution: {
      automation: kind === 'current_snapshot' ? null : 'automatic',
      mechanism: kind === 'current_snapshot' ? null : 'allocator_keeper',
      targetStatus: kind === 'current_snapshot' ? null : 'matched',
      transactions: []
    },
    classification: { confidence: 'high', evidence: [], limitations: [] },
    detailsAvailable: false
  }
}

describeDatabase('Postgres allocation history repository', () => {
  beforeAll(async () => {
    await runDatabaseMigrations()
    await databasePool().query('DELETE FROM allocation_history_projection WHERE chain_id = $1 AND vault_address = $2', [
      vault.chainId,
      vault.address
    ])
  })

  afterAll(async () => {
    await databasePool().query('DELETE FROM allocation_history_projection WHERE chain_id = $1 AND vault_address = $2', [
      vault.chainId,
      vault.address
    ])
    await databasePool().end()
  })

  it('activates atomically, keeps cursors pinned, preserves the last good run, and recovers stale runs', async () => {
    const firstRun = await startMaterializationRun({ vault, mode: 'backfill' })
    await completeMaterializationRun({
      run: firstRun,
      allocatorDeployments: [
        {
          allocatorAddress: address,
          factoryAddress: address,
          family: 'shared',
          boundVaultAddress: null,
          governanceAddress: address,
          createdBlock: 80,
          sourceEventId: 'deployment:80',
          abiVariant: 'shared-v1'
        }
      ],
      generatedAt: 1_000,
      safeBlock: { blockNumber: 110, blockTimestamp: 1_100 },
      coverage,
      vault: vaultPayload,
      entries: [
        entry('action:90', 90, 'strategy_reallocation'),
        entry('action:100', 100, 'strategy_reallocation'),
        entry('current:110', 110, 'current_snapshot')
      ]
    })

    const storedEntries = await databasePool().query<{ entry_id: string; end_block: string }>(
      `SELECT entry_id, end_block::text
       FROM allocation_history_entry
       WHERE run_id = $1::bigint
       ORDER BY allocation_history_entry.end_block DESC, entry_id DESC`,
      [firstRun.id]
    )
    expect(storedEntries.rows.map((row) => [row.entry_id, row.end_block])).toEqual([
      ['current:110', '110'],
      ['action:100', '100'],
      ['action:90', '90']
    ])

    const firstPage = await readMaterializedAllocationHistory({ vault, limit: 1, direction: 'desc' })
    expect(firstPage.entries.map((item) => item.id)).toEqual(['current:110'])
    expect(firstPage.pagination.nextCursor).not.toBeNull()

    const chartPage = await readMaterializedAllocationChart({ vault, limit: 1, direction: 'desc' })
    expect(chartPage.currentSnapshot?.id).toBe('current:110')
    expect(chartPage.currentSnapshot?.interval).toMatchObject({
      fromEntryId: 'action:100',
      toEntryId: null,
      endKind: 'safe_head',
      reconciliation: { balanceStatus: 'reconciled', attributionStatus: 'complete', unattributedAmount: '0' }
    })
    expect(chartPage.entries.map((item) => item.id)).toEqual(['action:100'])
    expect(Object.keys(chartPage.boundaryStates)).toEqual(['action:90'])
    expect(chartPage.boundaryStates['action:90']?.blockNumber).toBe(90)
    expect(chartPage.pagination.nextCursor).not.toBeNull()
    const chartDetail = await readMaterializedAllocationEntry({
      vault,
      entryId: chartPage.entries[0].id,
      runId: firstRun.id
    })
    expect(chartDetail).toMatchObject({
      projection: 'detail',
      entry: { id: 'action:100' },
      interval: {
        fromEntryId: 'action:90',
        toEntryId: 'action:100',
        reconciliation: { balanceStatus: 'reconciled' }
      }
    })

    const secondRun = await startMaterializationRun({ vault, mode: 'refresh' })
    await completeMaterializationRun({
      run: secondRun,
      generatedAt: 2_000,
      safeBlock: { blockNumber: 120, blockTimestamp: 1_200 },
      coverage,
      vault: vaultPayload,
      entries: [entry('action:105', 105, 'strategy_reallocation'), entry('current:120', 120, 'current_snapshot')]
    })

    const evidence = await databasePool().query('SELECT allocator_evidence FROM allocation_history_run WHERE id = $1', [
      firstRun.id
    ])
    expect(evidence.rows[0].allocator_evidence.deployments).toMatchObject([
      { sourceEventId: 'deployment:80', family: 'shared' }
    ])

    const pinnedPage = await readMaterializedAllocationHistory({
      vault,
      limit: 1,
      direction: 'desc',
      cursor: firstPage.pagination.nextCursor
    })
    expect(pinnedPage.entries.map((item) => item.id)).toEqual(['action:100'])

    const failedRun = await startMaterializationRun({ vault, mode: 'refresh' })
    await failMaterializationRun(failedRun.id, new Error('expected integration failure'))
    const activeAfterFailure = await readMaterializedAllocationHistory({ vault, limit: 1, direction: 'desc' })
    expect(activeAfterFailure.entries.map((item) => item.id)).toEqual(['current:120'])

    const interruptedRun = await startMaterializationRun({ vault, mode: 'refresh' })
    await expect(startMaterializationRun({ vault, mode: 'refresh' })).rejects.toThrow('already active')
    await databasePool().query(
      `UPDATE allocation_history_run
       SET started_at = now() - interval '7 hours'
       WHERE id = $1::bigint`,
      [interruptedRun.id]
    )
    const recoveredRun = await startMaterializationRun({ vault, mode: 'refresh' })
    const interrupted = await databasePool().query<{ status: string; error_code: string | null }>(
      'SELECT status, error_code FROM allocation_history_run WHERE id = $1::bigint',
      [interruptedRun.id]
    )
    expect(interrupted.rows[0]).toMatchObject({ status: 'failed', error_code: 'StaleRunReplaced' })
    await failMaterializationRun(recoveredRun.id, new Error('integration cleanup'))
  })

  it('activates an explicitly allowed provisional run and exposes its limitations', async () => {
    const run = await startMaterializationRun({ vault, mode: 'refresh' })
    const provisionalCoverage = {
      ...coverage,
      safeForTimeline: false,
      knownGaps: ['integration test coverage is provisional']
    }
    await completeMaterializationRun({
      run,
      generatedAt: 3_000,
      safeBlock: { blockNumber: 130, blockTimestamp: 1_300 },
      coverage: provisionalCoverage,
      vault: vaultPayload,
      entries: [entry('current:130', 130, 'current_snapshot')],
      allowProvisional: true
    })

    const response = await readMaterializedAllocationHistory({ vault, limit: 1, direction: 'desc' })
    expect(response.dataQuality).toEqual({
      certification: 'provisional',
      limitations: ['integration test coverage is provisional']
    })
  })
})
