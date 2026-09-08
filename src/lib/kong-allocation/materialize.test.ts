import { beforeEach, describe, expect, it, vi } from 'vitest'
import { materializeStates } from './materialize'
import {
  contractSelectors,
  encodeAddressCall,
  encodeAddressPairCall,
  readAllocatorCode,
  readContractCalls,
  readVaultRoleManagers
} from './rpc'
import type { Address, AllocationSourceEvent, AllocatorDeploymentEvidence, Hash } from './types'

vi.mock('./rpc', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rpc')>()),
  readAllocatorCode: vi.fn(),
  readContractCalls: vi.fn(),
  readVaultRoleManagers: vi.fn()
}))
const addr = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
const vault = addr(1),
  manager = addr(2),
  allocator = addr(3),
  strategy = addr(4)
const words = (...values: number[]) => `0x${values.map((n) => n.toString(16).padStart(64, '0')).join('')}` as Hash
const event: AllocationSourceEvent = {
  id: 'assignment',
  sourceAddress: manager,
  sourceLabel: 'roleManager',
  eventName: 'AddedNewVault',
  vaultAddress: vault,
  args: { debtAllocator: allocator, vault },
  blockNumber: 1,
  blockTimestamp: 1,
  transactionIndex: 0,
  logIndex: 0,
  transactionHash: words(1),
  signature: words(1),
  transactionFrom: null,
  transactionTo: null,
  inputSelector: null
}
const deployment: AllocatorDeploymentEvidence = {
  allocatorAddress: allocator,
  family: 'shared',
  boundVaultAddress: null,
  governanceAddress: addr(5),
  factoryAddress: addr(6),
  createdBlock: 1,
  sourceEventId: 'created',
  abiVariant: 'shared-v1'
}
const input = {
  chainId: 8453,
  vaultAddress: vault,
  blocks: [{ blockNumber: 2, blockTimestamp: 2, stateGranularity: 'latest' as const }],
  events: [
    event,
    {
      ...event,
      id: 'debt',
      sourceAddress: vault,
      sourceLabel: 'vault' as const,
      eventName: 'DebtUpdated',
      strategyAddress: strategy
    }
  ]
}

describe('allocator state enrichment', () => {
  beforeEach(() => {
    vi.mocked(readVaultRoleManagers).mockResolvedValue(new Map([[2, manager]]))
    vi.mocked(readAllocatorCode).mockResolvedValue(new Map([[`2:${allocator}`, 'code']]))
    vi.mocked(readContractCalls).mockImplementation(
      async (_chain, calls) =>
        new Map(
          calls.map((call) => [
            call.key,
            call.key.includes('strategyConfig')
              ? words(1, 0, 0, 1, 0)
              : call.key.includes(':strategy:')
                ? words(1, 1, 0, 100)
                : words(call.key.endsWith('totalDebt') ? 0 : 100)
          ])
        )
    )
  })
  it.each([
    'shared',
    'vault_bound'
  ] as const)('reads %s configuration and preserves genuine zero ratios', async (family) => {
    const result = await materializeStates({
      ...input,
      deployments: [{ ...deployment, family, boundVaultAddress: family === 'vault_bound' ? vault : null }]
    })
    expect(result.states[0]).toMatchObject({
      allocatorAddress: allocator,
      allocatorResolution: { support: 'supported', family },
      strategies: [{ targetDebtRatioBps: 0, maxDebtRatioBps: 0 }]
    })
    const config = vi
      .mocked(readContractCalls)
      .mock.calls.at(-1)?.[1]
      .find((call) => call.key.includes('strategyConfig'))
    expect(config?.data).toBe(
      family === 'shared'
        ? encodeAddressPairCall(contractSelectors.strategyConfig, vault, strategy)
        : encodeAddressCall(contractSelectors.vaultBoundConfig, strategy)
    )
  })
  it('retains a no-code assigned address without inventing ratios', async () => {
    vi.mocked(readAllocatorCode).mockResolvedValue(new Map([[`2:${allocator}`, 'no_code']]))
    const result = await materializeStates(input)
    expect(result.states[0]).toMatchObject({
      allocatorAddress: allocator,
      allocatorResolution: { support: 'no_code' },
      strategies: [{ targetDebtRatioBps: null }]
    })
  })
  it('fails closed on unavailable strategy accounting instead of emitting zero debt', async () => {
    vi.mocked(readContractCalls).mockResolvedValue(
      new Map([
        ['2:totalAssets', words(100)],
        ['2:totalDebt', words(0)],
        ['2:totalIdle', words(100)]
      ])
    )
    await expect(materializeStates(input)).rejects.toThrow('Strategy accounting call failed')
  })
})
