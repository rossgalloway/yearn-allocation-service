import { describe, expect, it } from 'vitest'
import { buildTransitions, type TransitionPoint } from './classify'
import type { Address, AllocationSourceEvent, Hash } from './types'

const vault = '0x00000000000000000000000000000000000000aa' as Address
const keeper = '0x00000000000000000000000000000000000000bb' as Address
const mainnetDoaKeeper = '0x283132390ea87d6ecc20255b59ba94329ee17961' as Address
const strategy = '0x00000000000000000000000000000000000000cc' as Address

function event(overrides: Partial<AllocationSourceEvent>): AllocationSourceEvent {
  return {
    id: '1:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:0',
    sourceAddress: vault,
    sourceLabel: 'vault',
    eventName: 'DebtUpdated',
    signature: '0x01' as Hash,
    blockNumber: 100,
    blockTimestamp: 1000,
    transactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    transactionIndex: 0,
    logIndex: 0,
    transactionFrom: keeper,
    transactionTo: vault,
    inputSelector: '0x12345678',
    strategyAddress: strategy,
    args: { strategy, currentDebt: '0', newDebt: '100' },
    ...overrides
  }
}

function point(blockNumber: number): TransitionPoint {
  return {
    blockNumber,
    blockTimestamp: blockNumber * 10,
    fromStateId: `state:${blockNumber - 1}`,
    toStateId: `state:${blockNumber}`
  }
}

describe('buildTransitions', () => {
  it('keeps mixed same-block transactions as separate effects', () => {
    const config = event({
      id: '1:0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:1',
      eventName: 'UpdateDefaultQueue',
      transactionHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      transactionIndex: 1,
      logIndex: 1,
      args: { newDefaultQueue: [strategy] }
    })
    const [transition] = buildTransitions({
      chainId: 1,
      vaultAddress: vault,
      points: [point(100)],
      events: [event({}), config]
    })

    expect(transition.kind).toBe('manual_debt_update')
    expect(transition.fromStateId).toBe('state:99')
    expect(transition.toStateId).toBe('state:100')
    expect(transition.effects).toHaveLength(2)
    expect(transition.transactionHashes).toHaveLength(2)
  })

  it('derives debt allocator keepers from prior UpdateKeeper events', () => {
    const allowKeeper = event({
      id: '1:0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc:0',
      sourceLabel: 'debtAllocator',
      eventName: 'UpdateKeeper',
      blockNumber: 90,
      blockTimestamp: 900,
      transactionHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      transactionFrom: null,
      strategyAddress: undefined,
      args: { keeper, allowed: true }
    })
    const [transition] = buildTransitions({
      chainId: 1,
      vaultAddress: vault,
      points: [point(100)],
      events: [allowKeeper, event({})]
    })

    expect(transition.effects[0].actor).toEqual({ address: keeper, role: 'debt_allocator_keeper', label: null })
  })

  it('recognizes the documented mainnet DOA keeper without allocator events', () => {
    const [transition] = buildTransitions({
      chainId: 1,
      vaultAddress: vault,
      points: [point(100)],
      events: [event({ transactionFrom: mainnetDoaKeeper })]
    })

    expect(transition.effects[0].actor).toEqual({
      address: mainnetDoaKeeper,
      role: 'doa_keeper',
      label: 'Yearn TKS DOA keeper'
    })
    expect(transition.kind).toBe('allocator_execution')
  })

  it('classifies and enriches withdrawal-driven debt changes', () => {
    const withdrawal = event({
      id: '1:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:1',
      eventName: 'Withdraw',
      logIndex: 1,
      strategyAddress: undefined,
      args: {
        sender: keeper,
        receiver: keeper,
        owner: keeper,
        assets: '100',
        shares: '90'
      }
    })
    const [transition] = buildTransitions({
      chainId: 1,
      vaultAddress: vault,
      points: [point(100)],
      events: [event({ args: { strategy, currentDebt: '200', newDebt: '100' } }), withdrawal]
    })

    expect(transition.kind).toBe('withdrawal_driven_debt_update')
    expect(transition.effects[0].vaultActivities).toEqual([
      {
        kind: 'withdrawal',
        path: 'direct',
        sourceEventId: withdrawal.id,
        sender: keeper,
        receiver: keeper,
        owner: keeper,
        assets: '100',
        shares: '90'
      }
    ])
  })

  it('classifies and enriches deposit-driven debt changes', () => {
    const deposit = event({
      id: '1:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:1',
      eventName: 'Deposit',
      logIndex: 1,
      strategyAddress: undefined,
      args: { sender: keeper, owner: keeper, assets: '100', shares: '90' }
    })
    const [transition] = buildTransitions({
      chainId: 1,
      vaultAddress: vault,
      points: [point(100)],
      events: [event({ args: { strategy, currentDebt: '100', newDebt: '200' } }), deposit]
    })

    expect(transition.kind).toBe('deposit_driven_debt_update')
    expect(transition.effects[0].vaultActivities).toEqual([
      {
        kind: 'deposit',
        path: 'direct',
        sourceEventId: deposit.id,
        sender: keeper,
        receiver: null,
        owner: keeper,
        assets: '100',
        shares: '90'
      }
    ])
  })

  it('marks withdrawal context as routed when the outer transaction targets another contract', () => {
    const router = '0x00000000000000000000000000000000000000dd' as Address
    const withdrawal = event({
      id: '1:0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:1',
      eventName: 'Withdraw',
      logIndex: 1,
      transactionTo: router,
      strategyAddress: undefined,
      args: { sender: router, receiver: keeper, owner: keeper, assets: '100', shares: '90' }
    })
    const [transition] = buildTransitions({
      chainId: 1,
      vaultAddress: vault,
      points: [point(100)],
      events: [event({ transactionTo: router }), withdrawal]
    })

    expect(transition.effects[0].vaultActivities?.[0].path).toBe('routed')
  })
})
