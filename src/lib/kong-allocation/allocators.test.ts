import { describe, expect, it } from 'vitest'
import { allocatorAssignmentEvents, blockEndPosition, resolveAllocatorAssignment, ZERO_ADDRESS } from './allocators'
import type { Address, AllocationSourceEvent, AllocatorDeploymentEvidence } from './types'

const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
const vault = addr(1),
  manager = addr(2),
  replacementManager = addr(3),
  old = addr(4),
  shared = addr(5),
  custom = addr(6)
function event(
  name: string,
  allocator: Address,
  blockNumber = 10,
  logIndex = 1,
  sourceAddress = manager
): AllocationSourceEvent {
  return {
    id: `${blockNumber}:${logIndex}`,
    eventName: name,
    args: { debtAllocator: allocator, vault },
    sourceAddress,
    sourceLabel: 'roleManager',
    vaultAddress: vault,
    blockNumber,
    blockTimestamp: 100,
    transactionHash: `0x${'1'.repeat(64)}`,
    signature: `0x${'2'.repeat(64)}`,
    transactionIndex: 0,
    logIndex,
    transactionFrom: null,
    transactionTo: null,
    inputSelector: null
  }
}
const deployment: AllocatorDeploymentEvidence = {
  allocatorAddress: shared,
  factoryAddress: addr(7),
  family: 'shared',
  boundVaultAddress: null,
  governanceAddress: addr(8),
  createdBlock: 1,
  sourceEventId: 'deployment',
  abiVariant: 'shared-v1'
}
const resolve = (events: AllocationSourceEvent[], block = 10) =>
  resolveAllocatorAssignment({
    vaultAddress: vault,
    events,
    at: blockEndPosition(block),
    roleManagerAddress: manager,
    deployments: [deployment]
  })

describe('allocator assignments', () => {
  it('preserves arbitrary initial addresses without requiring deployment provenance', () => {
    expect(resolve([event('AddedNewVault', custom)])).toMatchObject({
      address: custom,
      status: 'assigned',
      support: 'unsupported'
    })
    expect(resolve([event('NewDebtAllocator', shared)])).toMatchObject({ address: null, status: 'unavailable' })
  })
  it('orders same-block replacements at the exact log position and retains zero as a clear', () => {
    const events = [
      event('AddedNewVault', old, 9),
      event('UpdateDebtAllocator', shared, 10, 4),
      event('UpdateDebtAllocator', ZERO_ADDRESS, 10, 8)
    ]
    expect(
      resolveAllocatorAssignment({
        vaultAddress: vault,
        events,
        at: { ...blockEndPosition(10), transactionIndex: 0, logIndex: 3 },
        roleManagerAddress: manager
      }).address
    ).toBe(old)
    expect(
      resolveAllocatorAssignment({
        vaultAddress: vault,
        events,
        at: events[1],
        roleManagerAddress: manager,
        deployments: [deployment]
      })
    ).toMatchObject({ address: shared, family: 'shared' })
    expect(resolve(events)).toMatchObject({ address: null, status: 'cleared', assignmentId: '10:8' })
  })
  it('uses the authoritative manager and stops exposing removed assignments', () => {
    const migration = { ...event('UpdateRoleManager', custom, 10, 2, vault), args: { roleManager: replacementManager } }
    const events = [
      event('AddedNewVault', old, 9),
      event('AddedNewVault', custom, 9, 2, replacementManager),
      migration,
      event('UpdateDebtAllocator', shared, 10, 3)
    ]
    expect(resolve(events).address).toBe(custom)
    expect(resolve([...events, event('RemovedVault', custom, 10, 4, replacementManager)])).toMatchObject({
      address: null,
      reason: 'vault_removed_from_role_manager'
    })
  })
  it('keeps shared deployment governance separate from any number of vault assignments', () => {
    for (const target of [vault, addr(20)]) {
      expect(
        resolveAllocatorAssignment({
          vaultAddress: target,
          events: [
            { ...event('AddedNewVault', shared), vaultAddress: target, args: { vault: target, debtAllocator: shared } }
          ],
          at: blockEndPosition(10),
          roleManagerAddress: manager,
          deployments: [deployment]
        })
      ).toMatchObject({ address: shared, family: 'shared', support: 'supported' })
    }
  })
})

it('preserves assignment resolution when unrelated event history is removed', () => {
  const events = [
    event('AddedNewVault', old, 9),
    event('DebtUpdated', custom, 10, 1),
    event('NewDebtAllocator', shared, 10, 2),
    event('UpdateDebtAllocator', shared, 10, 4),
    event('UpdateRoleManager', custom, 11, 1, vault),
    { ...event('UpdateRoleManager', custom, 12, 1, vault), args: { roleManager: replacementManager, vault } },
    event('AddedNewVault', custom, 12, 2, replacementManager),
    event('RemovedVault', custom, 13, 1, replacementManager)
  ]
  const selected = allocatorAssignmentEvents(events)
  for (const block of [8, 9, 10, 11, 12, 13, 14]) expect(resolve(selected, block)).toEqual(resolve(events, block))
})
