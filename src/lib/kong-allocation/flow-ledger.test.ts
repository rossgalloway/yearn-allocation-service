import { describe, expect, it } from 'vitest'
import { buildAllocationFlowIntervals } from './flow-ledger'
import type { Address, AllocationEntryState, AllocationHistoryEntry, AllocationSourceEvent, Hash } from './types'

const vault = '0x00000000000000000000000000000000000000aa' as Address
const strategyA = '0x00000000000000000000000000000000000000a1' as Address
const strategyB = '0x00000000000000000000000000000000000000b1' as Address

function state(blockNumber: number, totalIdle: string, debtA: string, debtB: string): AllocationEntryState {
  const totalDebt = BigInt(debtA) + BigInt(debtB)
  return {
    blockNumber,
    blockTimestamp: blockNumber * 10,
    source: 'archive_rpc',
    totalAssets: (totalDebt + BigInt(totalIdle)).toString(),
    totalDebt: totalDebt.toString(),
    totalIdle,
    unallocatedBps: null,
    unallocatedSource: null,
    unallocatedCheckpointId: null,
    allocatorAddress: null,
    allocations: [
      {
        strategyAddress: strategyA,
        strategyName: 'Strategy A',
        active: true,
        currentDebt: debtA,
        currentDebtBps: 0,
        maxDebt: null,
        maxDebtBps: null,
        targetDebtRatioBps: null,
        maxDebtRatioBps: null,
        allocatorAdded: null
      },
      {
        strategyAddress: strategyB,
        strategyName: 'Strategy B',
        active: true,
        currentDebt: debtB,
        currentDebtBps: 0,
        maxDebt: null,
        maxDebtBps: null,
        targetDebtRatioBps: null,
        maxDebtRatioBps: null,
        allocatorAdded: null
      }
    ],
    accountingChecks: { totalAssetsEqualsDebtPlusIdle: true, strategyDebtSumEqualsTotalDebt: true }
  }
}

function entry(id: string, blockNumber: number, after: AllocationEntryState): AllocationHistoryEntry {
  return {
    id,
    kind: 'strategy_reallocation',
    startBlock: blockNumber,
    endBlock: blockNumber,
    startTimestamp: blockNumber * 10,
    endTimestamp: blockNumber * 10,
    before: state(blockNumber - 1, '0', '0', '0'),
    after,
    changes: { totalDebtDelta: null, totalIdleDelta: null, strategies: [] },
    policy: null,
    operations: [],
    execution: { automation: 'automatic', mechanism: 'allocator_keeper', targetStatus: 'matched', transactions: [] },
    classification: { confidence: 'high', evidence: [], limitations: [] },
    detailsAvailable: false
  }
}

function event(
  id: string,
  eventName: string,
  blockNumber: number,
  args: Record<string, unknown>,
  strategyAddress?: Address
): AllocationSourceEvent {
  const transactionHash = `0x${blockNumber.toString(16).padStart(64, '0')}` as Hash
  return {
    id,
    sourceAddress: vault,
    sourceLabel: 'vault',
    eventName,
    signature: `0x${'1'.repeat(64)}` as Hash,
    blockNumber,
    blockTimestamp: blockNumber * 10,
    transactionHash,
    transactionIndex: 0,
    logIndex: 0,
    transactionFrom: null,
    transactionTo: vault,
    inputSelector: null,
    ...(strategyAddress ? { strategyAddress } : {}),
    args
  }
}

describe('allocation interval flow ledger', () => {
  it('attributes interval activity and reconciles every allocation node', () => {
    const first = entry('entry:10', 10, state(10, '200', '800', '0'))
    const second = entry('entry:20', 20, state(20, '100', '500', '500'))
    const current: AllocationHistoryEntry = {
      ...entry('current:30', 30, state(30, '105', '500', '500')),
      kind: 'current_snapshot',
      before: null,
      execution: { automation: null, mechanism: null, targetStatus: null, transactions: [] }
    }
    const events = [
      event('deposit', 'Deposit', 11, { assets: '200' }),
      event(
        'report',
        'StrategyReported',
        15,
        { gain: '50', loss: '0', totalFees: '10', protocolFees: '1', totalRefunds: '0' },
        strategyA
      ),
      event('withdraw', 'Withdraw', 18, { assets: '150' }),
      event('debt-a', 'DebtUpdated', 20, { currentDebt: '850', newDebt: '500' }, strategyA),
      event('debt-b', 'DebtUpdated', 20, { currentDebt: '0', newDebt: '500' }, strategyB)
    ]

    const intervals = buildAllocationFlowIntervals({ entries: [first, second, current], events, vaultAddress: vault })
    const regular = intervals.get(second.id)
    expect(regular).toMatchObject({
      fromEntryId: first.id,
      toEntryId: second.id,
      endKind: 'allocation_entry',
      reconciliation: {
        openingTotalAssets: '1000',
        closingTotalAssets: '1100',
        totalAssetsDelta: '100',
        balanceStatus: 'reconciled',
        attributionStatus: 'complete',
        unattributedAmount: '0',
        checkedNodeTypes: ['idle', 'strategy']
      }
    })
    expect(regular?.flows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: { type: 'external' },
          target: { type: 'idle' },
          amount: '200',
          kind: 'deposit'
        }),
        expect.objectContaining({
          source: { type: 'accounting' },
          target: { type: 'strategy', address: strategyA, name: 'Strategy A' },
          amount: '50',
          kind: 'reported_gain',
          accounting: { totalFees: '10', protocolFees: '1' }
        }),
        expect.objectContaining({
          source: { type: 'idle' },
          target: { type: 'external' },
          amount: '150',
          kind: 'withdrawal'
        }),
        expect.objectContaining({
          source: { type: 'strategy', address: strategyA, name: 'Strategy A' },
          target: { type: 'strategy', address: strategyB, name: 'Strategy B' },
          amount: '350',
          kind: 'strategy_reallocation'
        }),
        expect.objectContaining({
          source: { type: 'idle' },
          target: { type: 'strategy', address: strategyB, name: 'Strategy B' },
          amount: '150',
          kind: 'idle_deployment'
        })
      ])
    )
    expect(regular?.reconciliation.residuals.every((residual) => residual.residualAmount === '0')).toBe(true)

    const tail = intervals.get(current.id)
    expect(tail).toMatchObject({
      fromEntryId: second.id,
      toEntryId: null,
      endKind: 'safe_head',
      reconciliation: {
        balanceStatus: 'reconciled',
        attributionStatus: 'partial',
        unattributedAmount: '5'
      }
    })
    expect(tail?.flows).toContainEqual(
      expect.objectContaining({
        source: { type: 'accounting' },
        target: { type: 'idle' },
        amount: '5',
        kind: 'unattributed_asset_change',
        attribution: 'residual_balance'
      })
    )
  })
})
