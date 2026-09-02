import { describe, expect, it } from 'vitest'
import type { DoaOptimizationRecord } from '@/lib/doa/types'
import { buildRestAllocationHistory } from './rest'
import type {
  Address,
  AllocationSourceEvent,
  AllocationState,
  AllocationTransition,
  Hash,
  NormalizedAllocationTimeline
} from './types'

const vault = '0x00000000000000000000000000000000000000aa' as Address
const strategy = '0x00000000000000000000000000000000000000bb' as Address
const strategyTwo = '0x00000000000000000000000000000000000000bc' as Address
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
    unallocatedSource: 'envio_same_block_checkpoint',
    unallocatedCheckpointId: `checkpoint:${blockNumber}`,
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

function multiStrategyState(blockNumber: number, firstDebt: string, secondDebt: string, idle: string): AllocationState {
  const result = state(blockNumber, firstDebt, idle)
  const totalDebt = BigInt(firstDebt) + BigInt(secondDebt)
  const totalAssets = totalDebt + BigInt(idle)
  result.totalAssets = totalAssets.toString()
  result.totalDebt = totalDebt.toString()
  result.unallocatedBps = Number((BigInt(idle) * 10_000n) / totalAssets)
  result.strategies[0].currentDebtBps = Number((BigInt(firstDebt) * 10_000n) / totalAssets)
  result.strategies.push({
    ...result.strategies[0],
    strategyAddress: strategyTwo,
    currentDebt: secondDebt,
    currentDebtBps: Number((BigInt(secondDebt) * 10_000n) / totalAssets)
  })
  return result
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

function sourceEvent(input: {
  id: string
  eventName: string
  strategyAddress?: Address
  args: Record<string, unknown>
  transactionHash?: Hash
  logIndex?: number
}): AllocationSourceEvent {
  return {
    id: input.id,
    sourceAddress: vault,
    sourceLabel: 'vault',
    eventName: input.eventName,
    signature: transactionOne,
    blockNumber: 100,
    blockTimestamp: 1000,
    transactionHash: input.transactionHash ?? transactionOne,
    transactionIndex: 0,
    logIndex: input.logIndex ?? 0,
    transactionFrom: keeper,
    transactionTo: vault,
    inputSelector: '0x6a761202' as Hash,
    strategyAddress: input.strategyAddress,
    args: input.args
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
  it('groups matched allocator idle deployments and embeds snapshots, policy, and transactions', () => {
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
      kind: 'idle_deployment',
      startBlock: 100,
      endBlock: 102,
      before: { blockNumber: 99 },
      after: { blockNumber: 102 },
      policy: { application: { status: 'inferred_from_historical_config' } },
      execution: {
        automation: 'automatic',
        mechanism: 'allocator_keeper',
        targetStatus: 'matched',
        transactions: [{ transactionHash: transactionOne }, { transactionHash: transactionTwo }]
      },
      classification: { confidence: 'high' }
    })
    expect(result.entries[0].changes.strategies[0]).toMatchObject({
      strategyName: 'Test strategy',
      currentDebtBefore: '500',
      currentDebtAfter: '1000',
      currentDebtDelta: '500'
    })
  })

  it('classifies a strategy decrease with no increase as idle deallocation', () => {
    const source = timeline([transition(100, 99, 100, transactionOne, '500')])
    source.states = [state(99, '700', '300'), state(100, '500', '500')]

    const result = buildRestAllocationHistory({
      timeline: source,
      doaRecords: [],
      direction: 'desc',
      limit: 25,
      hasMore: false
    })

    expect(result.entries[0]).toMatchObject({
      kind: 'idle_deallocation',
      execution: { automation: 'automatic', mechanism: 'allocator_keeper', targetStatus: 'matched' },
      changes: { totalDebtDelta: '-200', totalIdleDelta: '200' }
    })
  })

  it('keeps allocator overrides on the economic-flow axis and exposes the manual target choice separately', () => {
    const overridden = transition(100, 99, 100, transactionOne, '700')
    const replay = overridden.effects[0].triggerReplays?.[0]
    if (!replay) throw new Error('test fixture is missing allocator replay evidence')
    replay.status = 'not_matched'
    replay.recommendedDebt = '650'
    replay.absoluteDifference = '50'

    const result = buildRestAllocationHistory({
      timeline: timeline([overridden]),
      doaRecords: [],
      direction: 'desc',
      limit: 25,
      hasMore: false
    })

    expect(result.entries[0]).toMatchObject({
      kind: 'idle_deployment',
      policy: null,
      execution: {
        automation: 'manual',
        mechanism: 'allocator_keeper',
        targetStatus: 'overridden'
      },
      classification: { confidence: 'medium' }
    })
  })

  it('classifies whole-group strategy decreases and increases as strategy reallocation', () => {
    const source = timeline([transition(100, 99, 100, transactionOne, '500')])
    source.strategies.push({ address: strategyTwo, name: 'Second strategy', status: 'active' })
    source.states = [multiStrategyState(99, '700', '300', '0'), multiStrategyState(100, '500', '500', '0')]

    const result = buildRestAllocationHistory({
      timeline: source,
      doaRecords: [],
      direction: 'desc',
      limit: 25,
      hasMore: false
    })

    expect(result.entries[0]).toMatchObject({
      kind: 'strategy_reallocation',
      execution: { automation: 'automatic', mechanism: 'allocator_keeper', targetStatus: 'matched' },
      changes: { totalDebtDelta: '0', totalIdleDelta: '0' }
    })
    expect(result.entries[0].changes.strategies.map((item) => item.currentDebtDelta)).toEqual(['-200', '200'])
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

    expect(result.entries[0].kind).toBe('idle_deployment')
    expect(result.entries[0].execution).toMatchObject({
      automation: 'manual',
      mechanism: 'direct_vault_role',
      targetStatus: 'not_applicable'
    })
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

    expect(result.entries[0].kind).toBe('idle_deployment')
    expect(result.entries[0].execution).toMatchObject({
      automation: 'automatic',
      mechanism: 'allocator_keeper',
      targetStatus: 'matched'
    })
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

    expect(result.entries[0].kind).toBe('idle_deployment')
    expect(result.entries[0].execution).toMatchObject({
      automation: 'manual',
      mechanism: 'direct_vault_role',
      targetStatus: 'not_applicable'
    })
  })

  it('preserves configuration operations without hiding the entry economic flow', () => {
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

    expect(result.entries[0].kind).toBe('idle_deployment')
  })

  it('exposes pure strategy configuration as structured operations', () => {
    const configuration = transition(100, 99, 100, transactionOne, '500')
    configuration.kind = 'manual_config_change'
    configuration.effects[0].kind = 'manual_config_change'
    configuration.effects[0].sourceEventIds = ['strategy-added:100', 'max-debt:100']
    configuration.effects[0].triggerReplays = undefined
    configuration.effects[0].inputSelector = '0x6a761202' as Hash
    configuration.effects[0].executionContext = {
      traceStatus: 'available',
      callPath: [keeper, vault],
      immediateVaultCaller: keeper,
      immediateVaultCallerRoleMask: '64',
      immediateVaultCallerHasDebtManagerRole: true
    }

    const source = timeline([configuration])
    const before = state(99, '500', '500')
    const after = state(100, '500', '500')
    after.strategies.push({
      ...after.strategies[0],
      strategyAddress: strategyTwo,
      currentDebt: '0',
      currentDebtBps: 0,
      maxDebt: '10000000',
      maxDebtBps: 100_000_000,
      targetDebtRatioBps: 0,
      maxDebtRatioBps: 0,
      allocatorAdded: false,
      activation: 1
    })
    source.strategies.push({ address: strategyTwo, name: 'Second strategy', status: 'active' })
    source.states = [before, after]
    source.events = [
      sourceEvent({
        id: 'strategy-added:100',
        eventName: 'StrategyChanged',
        strategyAddress: strategyTwo,
        args: { strategy: strategyTwo, changeType: '1' }
      }),
      sourceEvent({
        id: 'max-debt:100',
        eventName: 'UpdatedMaxDebtForStrategy',
        strategyAddress: strategyTwo,
        args: { strategy: strategyTwo, newDebt: '10000000' },
        logIndex: 1
      })
    ]

    const result = buildRestAllocationHistory({
      timeline: source,
      doaRecords: [],
      direction: 'desc',
      limit: 25,
      hasMore: false
    })

    expect(result.entries[0]).toMatchObject({
      kind: 'configuration_change',
      execution: {
        automation: 'manual',
        mechanism: 'governance_safe',
        targetStatus: 'not_applicable'
      }
    })
    expect(result.entries[0].operations).toEqual([
      expect.objectContaining({
        kind: 'strategy_added',
        source: 'envio_event',
        subject: expect.objectContaining({ address: strategyTwo, name: 'Second strategy' })
      }),
      expect.objectContaining({
        kind: 'max_debt_updated',
        source: 'envio_event',
        changes: [{ field: 'maxDebt', before: null, after: '10000000' }]
      })
    ])
  })

  it('keeps lifecycle detail on a compound manual strategy reallocation', () => {
    const lifecycle = transition(100, 99, 100, transactionOne, '0')
    lifecycle.kind = 'strategy_lifecycle_change'
    lifecycle.effects[0].kind = 'strategy_lifecycle_change'
    lifecycle.effects[0].sourceEventIds = ['strategy-retired:100']
    lifecycle.effects[0].triggerReplays = undefined
    lifecycle.effects[0].inputSelector = '0x6a761202' as Hash
    lifecycle.effects[0].executionContext = {
      traceStatus: 'available',
      callPath: [keeper, vault],
      immediateVaultCaller: keeper,
      immediateVaultCallerRoleMask: '64',
      immediateVaultCallerHasDebtManagerRole: true
    }

    const source = timeline([lifecycle])
    source.strategies.push({ address: strategyTwo, name: 'Second strategy', status: 'active' })
    const before = multiStrategyState(99, '700', '300', '0')
    const after = multiStrategyState(100, '1', '999', '0')
    after.strategies[0].currentDebt = '0'
    after.strategies[0].currentDebtBps = 0
    after.strategies[0].activation = 0
    after.strategies[1].currentDebt = '1000'
    after.strategies[1].currentDebtBps = 10_000
    source.states = [before, after]
    source.events = [
      sourceEvent({
        id: 'strategy-retired:100',
        eventName: 'StrategyChanged',
        strategyAddress: strategy,
        args: { strategy, changeType: '2' }
      })
    ]

    const result = buildRestAllocationHistory({
      timeline: source,
      doaRecords: [],
      direction: 'desc',
      limit: 25,
      hasMore: false
    })

    expect(result.entries[0]).toMatchObject({
      kind: 'strategy_reallocation',
      execution: {
        automation: 'manual',
        mechanism: 'governance_safe',
        targetStatus: 'not_applicable'
      }
    })
    expect(result.entries[0].operations).toEqual([
      expect.objectContaining({
        kind: 'strategy_retired',
        subject: expect.objectContaining({ address: strategy, name: 'Test strategy' }),
        changes: [{ field: 'active', before: true, after: false }]
      })
    ])
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
    expect(result.entries[0].kind).toBe('idle_deployment')
    expect(result.pagination).toEqual({ limit: 1, returned: 1, hasMore: true, nextCursor: null })
  })

  it('keeps the synthetic current snapshot free of inferred execution and configuration changes', () => {
    const current = transition(100, 99, 100, transactionOne, '700')
    current.kind = 'current_live_tail'
    current.fromStateId = null
    current.effects = []

    const result = buildRestAllocationHistory({
      timeline: timeline([current]),
      doaRecords: [],
      direction: 'desc',
      limit: 25,
      hasMore: false
    })

    expect(result.entries[0]).toMatchObject({
      kind: 'current_snapshot',
      before: null,
      operations: [],
      execution: { automation: null, mechanism: null, targetStatus: null, transactions: [] }
    })
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
