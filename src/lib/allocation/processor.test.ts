import { describe, expect, it } from 'vitest'
import type { AllocationSourceEvent, VaultAccountingCheckpoint } from '@/lib/envio/types'
import { buildAllocationStates } from './processor'

const vault = '0x00000000000000000000000000000000000000aa'
const strategy = '0x00000000000000000000000000000000000000bb'

function event(overrides: Partial<AllocationSourceEvent>): AllocationSourceEvent {
  return {
    id: '1:0xevent:1',
    chainId: 1,
    vaultAddress: vault,
    sourceAddress: vault,
    sourceType: 'vault',
    eventName: 'DebtUpdated',
    signature: '0xsignature',
    normalizationVersion: 1,
    abiVariant: null,
    blockNumber: 100,
    blockTimestamp: '1000',
    blockHash: '0xblock',
    transactionHash: '0xtx',
    transactionIndex: 0,
    logIndex: 1,
    topLevelTransactionFrom: null,
    topLevelTransactionTo: null,
    topLevelInputSelector: null,
    strategyAddress: strategy,
    argsJson: JSON.stringify({ strategy, currentDebt: '0', newDebt: '600' }),
    ...overrides
  }
}

function checkpoint(overrides: Partial<VaultAccountingCheckpoint> = {}): VaultAccountingCheckpoint {
  return {
    id: '1:vault:100',
    chainId: 1,
    vaultAddress: vault,
    blockNumber: 100,
    blockTimestamp: '1000',
    blockHash: '0xblock',
    totalAssets: '1000',
    totalDebt: '600',
    totalIdle: '400',
    accountingIdentityHolds: true,
    canonicalBlockVerified: true,
    source: 'archive-rpc-effect',
    sourceEventIds: ['1:0xevent:1'],
    ...overrides
  }
}

describe('buildAllocationStates', () => {
  it('builds exact strategy and idle ratios from indexed events and the same-block checkpoint', () => {
    const [state] = buildAllocationStates([event({})], [checkpoint()])

    expect(state.complete).toBe(true)
    expect(state.unallocatedBps).toBe(4000)
    expect(state.strategies).toEqual([
      expect.objectContaining({
        strategyAddress: strategy,
        currentDebt: '600',
        currentDebtBps: 6000
      })
    ])
  })

  it('keeps allocator targets separate from indexed idle capital', () => {
    const ratioEvent = event({
      id: '1:0xevent:2',
      sourceType: 'debtAllocator',
      eventName: 'UpdateStrategyDebtRatios',
      logIndex: 2,
      argsJson: JSON.stringify({
        strategy,
        newTargetRatio: '2500',
        newMaxRatio: '3000',
        newTotalDebtRatio: '2500'
      })
    })
    const [state] = buildAllocationStates([event({}), ratioEvent], [checkpoint()])

    expect(state.unallocatedBps).toBe(4000)
    expect(state.strategies[0].targetDebtRatioBps).toBe(2500)
    expect(state.strategies[0].targetDebtRatioBps).not.toBe(state.unallocatedBps)
  })

  it('fails the processed state closed when checkpoint evidence is not canonical', () => {
    const [state] = buildAllocationStates([event({})], [checkpoint({ canonicalBlockVerified: false })])

    expect(state.complete).toBe(false)
    expect(state.issues).toContain('canonical-block-unverified:1:vault:100')
  })

  it('fails closed when replayed strategy debt does not equal indexed total debt', () => {
    const mismatchedDebtEvent = event({
      argsJson: JSON.stringify({ strategy, currentDebt: '0', newDebt: '500' })
    })
    const [state] = buildAllocationStates([mismatchedDebtEvent], [checkpoint()])

    expect(state.complete).toBe(false)
    expect(state.issues).toContain('strategy-debt-sum-mismatch:1:vault:100')
  })

  it('uses VaultV3 strategy lifecycle values and does not double-apply DebtPurchased', () => {
    const add = event({
      id: '1:0xevent:0',
      eventName: 'StrategyChanged',
      logIndex: 0,
      argsJson: JSON.stringify({ strategy, changeType: '0' })
    })
    const purchase = event({
      id: '1:0xevent:2',
      eventName: 'DebtPurchased',
      logIndex: 2,
      argsJson: JSON.stringify({ strategy, amount: '400' })
    })
    const [state] = buildAllocationStates([add, event({}), purchase], [checkpoint()])

    expect(state.strategies[0]).toEqual(expect.objectContaining({ isActive: true, currentDebt: '600' }))
  })
})
