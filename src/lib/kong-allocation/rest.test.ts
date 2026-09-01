import { describe, expect, it } from 'vitest'
import type { DoaOptimizationRecord } from '@/lib/doa/types'
import { buildRestAllocationHistory } from './rest'
import type { Address, AllocationState, AllocationTransition, Hash, NormalizedAllocationTimeline } from './types'

const vault = '0x00000000000000000000000000000000000000aa' as Address
const strategy = '0x00000000000000000000000000000000000000bb' as Address
const allocator = '0x00000000000000000000000000000000000000cc' as Address
const keeper = '0x00000000000000000000000000000000000000dd' as Address
const transactionOne = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hash
const transactionTwo = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hash

function state(blockNumber: number, debt: string, idle: string): AllocationState {
  const totalAssets = (BigInt(debt) + BigInt(idle)).toString()
  return {
    id: `state:${blockNumber}`,
    stateGranularity: 'block_end',
    blockNumber,
    blockTimestamp: blockNumber * 10,
    transactionHash: null,
    totalAssets,
    totalDebt: debt,
    totalIdle: idle,
    unallocatedBps: Number((BigInt(idle) * 10_000n) / BigInt(totalAssets)),
    allocatorAddress: allocator,
    sourceEventIds: [],
    strategies: [
      {
        strategyAddress: strategy,
        currentDebt: debt,
        currentDebtBps: Number((BigInt(debt) * 10_000n) / BigInt(totalAssets)),
        maxDebt: totalAssets,
        maxDebtBps: 10_000,
        targetDebtRatioBps: 6000,
        maxDebtRatioBps: 7000,
        allocatorAdded: true,
        activation: 1,
        lastReport: 1
      }
    ]
  }
}

function transition(
  blockNumber: number,
  from: number,
  to: number,
  hash: Hash,
  expectedDebt: string
): AllocationTransition {
  return {
    id: `transition:${blockNumber}`,
    kind: 'allocator_execution',
    fromStateId: `state:${from}`,
    toStateId: `state:${to}`,
    blockNumber,
    blockTimestamp: blockNumber * 10,
    transactionHashes: [hash],
    effects: [
      {
        kind: 'allocator_execution',
        sourceEventIds: [`event:${blockNumber}`],
        transactionHash: hash,
        transactionFrom: keeper,
        transactionTo: allocator,
        inputSelector: '0x12345678',
        actor: { address: keeper, role: 'debt_allocator_keeper', label: 'Keeper' },
        executionContext: {
          traceStatus: 'available',
          callPath: [keeper, allocator, vault],
          immediateVaultCaller: allocator,
          immediateVaultCallerRoleMask: '96',
          immediateVaultCallerHasDebtManagerRole: true
        },
        triggerReplays: [
          {
            strategyAddress: strategy,
            allocatorAddress: allocator,
            readAtBlock: blockNumber - 1,
            status: 'matched',
            shouldUpdate: true,
            expectedDebt,
            recommendedDebt: expectedDebt,
            absoluteDifference: '0',
            matchTolerance: '1000',
            reason: null
          }
        ]
      }
    ]
  }
}

function proposal(): DoaOptimizationRecord {
  const timestampUtc = new Date(900_000).toISOString()
  return {
    vault,
    strategyDebtRatios: [{ strategy, currentRatio: 5000, targetRatio: 6000 }],
    currentApr: 1,
    proposedApr: 2,
    explain: 'Move toward the proposed target',
    source: {
      key: 'doa:optimizations:1:900',
      chainId: 1,
      revision: '900',
      isLatestAlias: false,
      timestampUtc,
      latestMatchedTimestampUtc: null
    },
    allocationCoverage: {
      currentIncludedBps: 5000,
      targetIncludedBps: 6000,
      currentResidualBps: 5000,
      targetResidualBps: 4000,
      currentComplete: false,
      targetComplete: false,
      classification: 'partial-optimizer-scope',
      unallocatedBps: null,
      unallocatedSource: null
    },
    freshness: { optimizationTimestampUtc: timestampUtc, latestAvailableTimestampUtc: timestampUtc }
  }
}

function timeline(transitions: AllocationTransition[]): NormalizedAllocationTimeline {
  return {
    generatedAt: 2000,
    vault: {
      chainId: 1,
      address: vault,
      name: 'Test vault',
      symbol: 'yvTEST',
      assetAddress: null,
      assetSymbol: 'TEST',
      assetDecimals: 6
    },
    strategies: [{ address: strategy, name: 'Test strategy', status: 'active' }],
    states: [state(99, '500', '500'), state(100, '700', '300'), state(101, '700', '300'), state(102, '1000', '0')],
    transitions,
    unappliedDoaProposals: []
  }
}

describe('REST allocation history projection', () => {
  it('groups matched allocator steps and embeds snapshots, policy, and transactions', () => {
    const result = buildRestAllocationHistory({
      timeline: timeline([
        transition(100, 99, 100, transactionOne, '700'),
        transition(102, 101, 102, transactionTwo, '1000')
      ]),
      doaRecords: [proposal()],
      direction: 'desc',
      limit: 25,
      hasMore: false
    })

    expect(result.schemaVersion).toBe(2)
    expect(result).not.toHaveProperty('states')
    expect(result).not.toHaveProperty('transitions')
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({
      kind: 'target_maintenance',
      startBlock: 100,
      endBlock: 102,
      before: { blockNumber: 99 },
      after: { blockNumber: 102 },
      policy: { application: { status: 'inferred_from_historical_config' } },
      execution: { transactions: [{ transactionHash: transactionOne }, { transactionHash: transactionTwo }] },
      classification: { confidence: 'high' }
    })
    expect(result.entries[0].changes.strategies[0]).toMatchObject({
      strategyName: 'Test strategy',
      currentDebtBefore: '500',
      currentDebtAfter: '1000',
      currentDebtDelta: '500'
    })
  })

  it('uses trace-resolved historical role evidence for manual reallocations', () => {
    const manual = transition(100, 99, 100, transactionOne, '700')
    manual.kind = 'manual_debt_update'
    manual.effects[0].kind = 'manual_debt_update'
    manual.effects[0].triggerReplays = undefined
    manual.effects[0].transactionTo = vault
    manual.effects[0].executionContext = {
      traceStatus: 'available',
      callPath: [keeper, vault],
      immediateVaultCaller: keeper,
      immediateVaultCallerRoleMask: '64',
      immediateVaultCallerHasDebtManagerRole: true
    }

    const result = buildRestAllocationHistory({
      timeline: timeline([manual]),
      doaRecords: [],
      direction: 'desc',
      limit: 25,
      hasMore: false
    })

    expect(result.entries[0].kind).toBe('manual_role_reallocation')
    expect(result.entries[0].execution.transactions[0].authorization).toEqual({
      role: 'DEBT_MANAGER',
      roleMask: '64',
      confirmedAtBlock: true
    })
  })

  it('omits pure withdrawal servicing from the chart-ready REST timeline', () => {
    const withdrawal = transition(100, 99, 100, transactionOne, '700')
    withdrawal.kind = 'withdrawal_driven_debt_update'
    withdrawal.effects[0].kind = 'withdrawal_driven_debt_update'
    withdrawal.effects[0].actor = { address: keeper, role: 'unknown', label: null }
    withdrawal.effects[0].triggerReplays = undefined
    withdrawal.effects[0].transactionTo = vault
    withdrawal.effects[0].executionContext = {
      traceStatus: 'available',
      callPath: [keeper, vault],
      immediateVaultCaller: keeper,
      immediateVaultCallerRoleMask: '0',
      immediateVaultCallerHasDebtManagerRole: false
    }
    withdrawal.effects[0].vaultActivities = [
      {
        kind: 'withdrawal',
        path: 'direct',
        sourceEventId: 'withdrawal:100',
        sender: keeper,
        receiver: keeper,
        owner: keeper,
        assets: '200',
        shares: '200'
      }
    ]

    const result = buildRestAllocationHistory({
      timeline: timeline([withdrawal]),
      doaRecords: [],
      direction: 'desc',
      limit: 25,
      hasMore: false
    })

    expect(result.entries).toEqual([])
  })

  it('preserves an allocator execution that also services a withdrawal', () => {
    const allocatorWithdrawal = transition(100, 99, 100, transactionOne, '700')
    allocatorWithdrawal.kind = 'withdrawal_driven_debt_update'
    allocatorWithdrawal.effects[0].kind = 'withdrawal_driven_debt_update'
    allocatorWithdrawal.effects[0].vaultActivities = [
      {
        kind: 'withdrawal',
        path: 'routed',
        sourceEventId: 'withdrawal:100',
        sender: keeper,
        receiver: keeper,
        owner: keeper,
        assets: '200',
        shares: '200'
      }
    ]

    const result = buildRestAllocationHistory({
      timeline: timeline([allocatorWithdrawal]),
      doaRecords: [],
      direction: 'desc',
      limit: 25,
      hasMore: false
    })

    expect(result.entries[0].kind).toBe('target_maintenance')
    expect(result.entries[0].execution.transactions[0].vaultActivities?.[0].kind).toBe('withdrawal')
  })

  it('preserves a role-authorized reallocation that also services a withdrawal', () => {
    const roleWithdrawal = transition(100, 99, 100, transactionOne, '700')
    roleWithdrawal.kind = 'withdrawal_driven_debt_update'
    roleWithdrawal.effects[0].kind = 'withdrawal_driven_debt_update'
    roleWithdrawal.effects[0].triggerReplays = undefined
    roleWithdrawal.effects[0].transactionTo = vault
    roleWithdrawal.effects[0].executionContext = {
      traceStatus: 'available',
      callPath: [keeper, vault],
      immediateVaultCaller: keeper,
      immediateVaultCallerRoleMask: '64',
      immediateVaultCallerHasDebtManagerRole: true
    }
    roleWithdrawal.effects[0].vaultActivities = [
      {
        kind: 'withdrawal',
        path: 'direct',
        sourceEventId: 'withdrawal:100',
        sender: keeper,
        receiver: keeper,
        owner: keeper,
        assets: '200',
        shares: '200'
      }
    ]

    const result = buildRestAllocationHistory({
      timeline: timeline([roleWithdrawal]),
      doaRecords: [],
      direction: 'desc',
      limit: 25,
      hasMore: false
    })

    expect(result.entries[0].kind).toBe('manual_role_reallocation')
  })

  it('preserves configuration changes that share a block with withdrawal servicing', () => {
    const withdrawal = transition(100, 99, 100, transactionOne, '700')
    withdrawal.kind = 'withdrawal_driven_debt_update'
    withdrawal.effects[0].kind = 'withdrawal_driven_debt_update'
    withdrawal.effects[0].actor = { address: keeper, role: 'unknown', label: null }
    withdrawal.effects[0].triggerReplays = undefined
    withdrawal.effects[0].vaultActivities = [
      {
        kind: 'withdrawal',
        path: 'direct',
        sourceEventId: 'withdrawal:100',
        sender: keeper,
        receiver: keeper,
        owner: keeper,
        assets: '200',
        shares: '200'
      }
    ]
    withdrawal.effects.push({
      ...withdrawal.effects[0],
      kind: 'manual_config_change',
      transactionHash: transactionTwo,
      sourceEventIds: ['configuration:100'],
      vaultActivities: undefined
    })

    const result = buildRestAllocationHistory({
      timeline: timeline([withdrawal]),
      doaRecords: [],
      direction: 'desc',
      limit: 25,
      hasMore: false
    })

    expect(result.entries[0].kind).toBe('configuration_change')
  })

  it('applies the response limit after filtering and grouping', () => {
    const maintenance = transition(100, 99, 100, transactionOne, '700')
    const configuration = transition(102, 101, 102, transactionTwo, '1000')
    configuration.kind = 'manual_config_change'
    configuration.effects[0].kind = 'manual_config_change'

    const result = buildRestAllocationHistory({
      timeline: timeline([maintenance, configuration]),
      doaRecords: [],
      direction: 'desc',
      limit: 1,
      hasMore: false
    })

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0].kind).toBe('configuration_change')
    expect(result.pagination).toEqual({ limit: 1, returned: 1, hasMore: true })
  })

  it('omits report-only transitions from the chart-ready REST timeline', () => {
    const report = transition(100, 99, 100, transactionOne, '700')
    report.kind = 'report_only_state_change'
    report.effects[0].kind = 'report_only_state_change'

    const result = buildRestAllocationHistory({
      timeline: timeline([report]),
      doaRecords: [],
      direction: 'desc',
      limit: 25,
      hasMore: false
    })

    expect(result.entries).toEqual([])
  })
})
