import { describe, expect, it } from 'vitest'
import type { DoaOptimizationRecord } from '@/lib/doa/types'
import { processDoa } from './doa'
import type { Address, AllocationSourceEvent, AllocationTransition, Hash } from './types'

const vault = '0x00000000000000000000000000000000000000aa' as Address
const strategy = '0x00000000000000000000000000000000000000bb' as Address
const transactionHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hash
const secondTransactionHash = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Hash
const mainnetDoaKeeper = '0x283132390ea87d6ecc20255b59ba94329ee17961' as Address

function record(timestamp: number): DoaOptimizationRecord {
  const timestampUtc = new Date(timestamp * 1000).toISOString()
  return {
    vault,
    strategyDebtRatios: [{ strategy, currentRatio: 1000, targetRatio: 2000 }],
    currentApr: 1,
    proposedApr: 2,
    explain: 'Increase the strategy target',
    source: {
      key: `doa:optimizations:1:${timestamp}`,
      chainId: 1,
      revision: String(timestamp),
      isLatestAlias: false,
      timestampUtc,
      latestMatchedTimestampUtc: null
    },
    allocationCoverage: {
      currentIncludedBps: 1000,
      targetIncludedBps: 2000,
      currentResidualBps: 9000,
      targetResidualBps: 8000,
      currentComplete: false,
      targetComplete: false,
      classification: 'partial-optimizer-scope',
      unallocatedBps: null,
      unallocatedSource: null
    },
    freshness: { optimizationTimestampUtc: timestampUtc, latestAvailableTimestampUtc: timestampUtc }
  }
}

function sourceEvent(
  id: string,
  eventName: string,
  args: Record<string, unknown>,
  overrides: Partial<AllocationSourceEvent> = {}
): AllocationSourceEvent {
  return {
    id,
    sourceAddress: vault,
    sourceLabel: eventName === 'UpdateStrategyDebtRatios' ? 'debtAllocator' : 'vault',
    eventName,
    signature: '0x01',
    blockNumber: 100,
    blockTimestamp: 10_100,
    transactionHash,
    transactionIndex: 0,
    logIndex: id.endsWith(':0') ? 0 : 1,
    transactionFrom: null,
    transactionTo: null,
    inputSelector: null,
    strategyAddress: strategy,
    args,
    ...overrides
  }
}

function transition(eventIds: string[], overrides: Partial<AllocationTransition> = {}): AllocationTransition {
  return {
    id: `allocation-transition:1:${vault}:100`,
    kind: 'allocator_execution',
    fromStateId: null,
    toStateId: 'state:100',
    blockNumber: 100,
    blockTimestamp: 10_100,
    transactionHashes: [transactionHash],
    effects: [
      {
        kind: 'allocator_execution',
        sourceEventIds: eventIds,
        transactionHash,
        transactionFrom: null,
        transactionTo: null,
        inputSelector: null,
        actor: { address: null, role: 'unknown', label: null }
      }
    ],
    ...overrides
  }
}

describe('processDoa', () => {
  it('upgrades a debt transition when allocator targets match a proposal', () => {
    const debt = sourceEvent('1:tx:0', 'DebtUpdated', { currentDebt: '100', newDebt: '200' })
    const ratio = sourceEvent('1:tx:1', 'UpdateStrategyDebtRatios', { newTargetRatio: '2000' })
    const result = processDoa([record(10_000)], [transition([debt.id, ratio.id])], [debt, ratio], 10_200)

    expect(result.transitions[0].kind).toBe('doa_execution')
    expect(result.transitions[0].doa?.strategyTargets[0].targetRatioBps).toBe(2000)
    expect(result.pendingDoaProposals).toEqual([])
  })

  it('matches every keeper debt step explained by one proposal without allocator-ratio events', () => {
    const firstDebt = sourceEvent(
      '1:tx:0',
      'DebtUpdated',
      { currentDebt: '100', newDebt: '200' },
      { transactionFrom: mainnetDoaKeeper }
    )
    const secondDebt = sourceEvent(
      '1:tx:1',
      'DebtUpdated',
      { currentDebt: '200', newDebt: '300' },
      {
        blockNumber: 101,
        blockTimestamp: 10_200,
        transactionHash: secondTransactionHash,
        transactionFrom: mainnetDoaKeeper
      }
    )
    const firstTransition = transition([firstDebt.id])
    const secondTransition = transition([secondDebt.id], {
      id: `allocation-transition:1:${vault}:101`,
      blockNumber: 101,
      blockTimestamp: 10_200,
      transactionHashes: [secondTransactionHash],
      effects: [
        {
          kind: 'manual_debt_update',
          sourceEventIds: [secondDebt.id],
          transactionHash: secondTransactionHash,
          transactionFrom: mainnetDoaKeeper,
          transactionTo: null,
          inputSelector: null,
          actor: { address: mainnetDoaKeeper, role: 'doa_keeper', label: 'Yearn TKS DOA keeper' }
        }
      ]
    })

    const result = processDoa([record(10_000)], [firstTransition, secondTransition], [firstDebt, secondDebt], 10_300)

    expect(result.transitions.map((item) => item.kind)).toEqual(['doa_execution', 'doa_execution'])
    expect(result.transitions.map((item) => item.doa?.sourceKey)).toEqual([
      'doa:optimizations:1:10000',
      'doa:optimizations:1:10000'
    ])
    expect(result.pendingDoaProposals).toEqual([])
  })

  it('does not match debt direction and timing without a trusted execution path', () => {
    const debt = sourceEvent('1:tx:0', 'DebtUpdated', { currentDebt: '100', newDebt: '200' })
    const result = processDoa([record(10_000)], [transition([debt.id])], [debt], 10_200)

    expect(result.transitions[0].kind).toBe('allocator_execution')
    expect(result.transitions[0].doa).toBeUndefined()
    expect(result.pendingDoaProposals[0].status).toBe('pending')
  })

  it('ages unmatched proposals without creating executed transitions', () => {
    const proposal = record(10_000)
    const result = processDoa([proposal], [], [], 10_000 + 31 * 24 * 3600)

    expect(result.transitions).toEqual([])
    expect(result.pendingDoaProposals[0].status).toBe('stale')
  })

  it('distinguishes pending, unmatched, and stale proposal ages', () => {
    const proposal = record(10_000)

    expect(processDoa([proposal], [], [], 10_000 + 48 * 3600).pendingDoaProposals[0].status).toBe('pending')
    expect(processDoa([proposal], [], [], 10_000 + 4 * 24 * 3600).pendingDoaProposals[0].status).toBe('unmatched')
    expect(processDoa([proposal], [], [], 10_000 + 31 * 24 * 3600).pendingDoaProposals[0].status).toBe('stale')
  })
})
