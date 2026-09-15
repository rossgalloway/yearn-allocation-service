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
      classification: 'partial-optimizer-scope'
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
        actor: { address: null, role: 'unknown', label: null },
        executionContext: {
          traceStatus: 'unavailable',
          callPath: [],
          immediateVaultCaller: null,
          immediateVaultCallerRoleMask: null,
          immediateVaultCallerHasDebtManagerRole: null
        }
      }
    ],
    ...overrides
  }
}

describe('processDoa', () => {
  it('records a policy application only when allocator targets exactly match a proposal', () => {
    const debt = sourceEvent('1:tx:0', 'DebtUpdated', { currentDebt: '100', newDebt: '200' })
    const ratio = sourceEvent('1:tx:1', 'UpdateStrategyDebtRatios', { newTargetRatio: '2000' })
    const result = processDoa([record(10_000)], [transition([debt.id, ratio.id])], [debt, ratio])

    expect(result.transitions[0].kind).toBe('allocator_execution')
    expect(result.transitions[0].doa?.strategyTargets[0].targetRatioBps).toBe(2000)
    expect(result.transitions[0].doa?.application).toEqual({
      status: 'confirmed',
      blockNumber: 100,
      transactionHash,
      sourceEventIds: [ratio.id]
    })
    expect(result.unappliedDoaProposals).toEqual([])
  })

  it('does not treat keeper direction and timing as policy-application proof', () => {
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
          actor: { address: mainnetDoaKeeper, role: 'doa_keeper', label: 'Yearn TKS DOA keeper' },
          executionContext: {
            traceStatus: 'unavailable',
            callPath: [],
            immediateVaultCaller: null,
            immediateVaultCallerRoleMask: null,
            immediateVaultCallerHasDebtManagerRole: null
          }
        }
      ]
    })

    const result = processDoa([record(10_000)], [firstTransition, secondTransition], [firstDebt, secondDebt])

    expect(result.transitions.map((item) => item.kind)).toEqual(['allocator_execution', 'allocator_execution'])
    expect(result.transitions.every((item) => item.doa === undefined)).toBe(true)
    expect(result.unappliedDoaProposals[0].status).toBe('unmatched')
  })

  it('does not match debt direction and timing without a trusted execution path', () => {
    const debt = sourceEvent('1:tx:0', 'DebtUpdated', { currentDebt: '100', newDebt: '200' })
    const result = processDoa([record(10_000)], [transition([debt.id])], [debt])

    expect(result.transitions[0].kind).toBe('allocator_execution')
    expect(result.transitions[0].doa).toBeUndefined()
    expect(result.unappliedDoaProposals[0].status).toBe('unmatched')
  })

  it('does not age unmatched proposals into a synthetic stale status', () => {
    const proposal = record(10_000)
    const result = processDoa([proposal], [], [])

    expect(result.transitions).toEqual([])
    expect(result.unappliedDoaProposals[0].status).toBe('unmatched')
  })

  it('marks an unapplied proposal as superseded only when a newer template replaces it', () => {
    const result = processDoa([record(10_000), record(20_000)], [], [])

    expect(result.unappliedDoaProposals.map((proposal) => proposal.status)).toEqual(['superseded', 'unmatched'])
  })
})
