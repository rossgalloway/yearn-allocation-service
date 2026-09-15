import { describe, expect, it } from 'vitest'
import { buildStrategyDirectory, eventBlocks, firstVaultEventBlock, orderByDirection } from './refresh'
import type { Address, AllocationSourceEvent, AllocationState, Hash } from './types'

const active = '0x00000000000000000000000000000000000000aa' as Address
const inactive = '0x00000000000000000000000000000000000000bb' as Address
const unavailable = '0x00000000000000000000000000000000000000cc' as Address

function latestState(): AllocationState {
  return {
    id: 'state:latest',
    stateGranularity: 'latest',
    blockNumber: 100,
    blockTimestamp: 1000,
    transactionHash: null,
    totalAssets: '100',
    totalDebt: '100',
    totalIdle: '0',
    allocatorAddress: null,
    sourceEventIds: [],
    strategies: [
      {
        strategyAddress: active,
        currentDebt: '100',
        currentDebtBps: 10_000,
        maxDebt: '100',
        maxDebtBps: 10_000,
        targetDebtRatioBps: null,
        maxDebtRatioBps: null,
        allocatorAdded: null,
        activation: 900,
        lastReport: 950
      },
      {
        strategyAddress: inactive,
        currentDebt: '0',
        currentDebtBps: 0,
        maxDebt: '0',
        maxDebtBps: 0,
        targetDebtRatioBps: null,
        maxDebtRatioBps: null,
        allocatorAdded: null,
        activation: 0,
        lastReport: 0
      }
    ]
  }
}

describe('Kong allocation timeline helpers', () => {
  it('derives current directory status from the latest RPC activation', () => {
    const directory = buildStrategyDirectory(
      [active, inactive, unavailable],
      new Map([
        [active, 'Active strategy'],
        [inactive, 'Inactive strategy']
      ]),
      latestState()
    )

    expect(directory).toEqual([
      { address: active, name: 'Active strategy', status: 'active' },
      { address: inactive, name: 'Inactive strategy', status: 'inactive' },
      { address: unavailable, name: null, status: 'unknown' }
    ])
  })

  it('orders block entries in either direction without changing their contents', () => {
    const values = [
      { id: 'a', blockNumber: 10 },
      { id: 'b', blockNumber: 20 }
    ]

    expect(orderByDirection(values, 'desc').map((value) => value.blockNumber)).toEqual([20, 10])
    expect(orderByDirection(values, 'asc').map((value) => value.blockNumber)).toEqual([10, 20])
  })

  it('does not create allocation samples from standalone context events', () => {
    const base = {
      id: '1:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0',
      sourceAddress: active,
      sourceLabel: 'vault' as const,
      signature: '0x01' as Hash,
      transactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Hash,
      transactionIndex: 0,
      logIndex: 0,
      transactionFrom: active,
      transactionTo: active,
      inputSelector: null,
      args: {}
    }
    const events: AllocationSourceEvent[] = [
      { ...base, eventName: 'Deposit', blockNumber: 90, blockTimestamp: 900 },
      { ...base, eventName: 'Withdraw', blockNumber: 95, blockTimestamp: 950 },
      { ...base, eventName: 'DebtUpdated', blockNumber: 100, blockTimestamp: 1000 }
    ]

    expect(eventBlocks(events)).toEqual([{ blockNumber: 100, blockTimestamp: 1000 }])
    expect(eventBlocks(events, 0)).toEqual([])
  })
})

describe('vault history start', () => {
  it('retains allocator evidence without taking vault snapshots before creation', () => {
    const shared = { sourceAddress: inactive, vaultAddress: null, blockNumber: 50 } as AllocationSourceEvent
    const creation = { sourceAddress: active, vaultAddress: active, blockNumber: 100 } as AllocationSourceEvent
    expect(firstVaultEventBlock([shared, creation], active, 200)).toBe(100)
    expect(firstVaultEventBlock([shared], active, 200)).toBe(200)
  })
})
