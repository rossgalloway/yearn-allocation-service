import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DoaConfigurationError, readDoaOptimizations } from '@/lib/doa/client'
import { type AllocationEvidence, fixtureEventReader } from './evidence'
import { materializeStates } from './materialize'
import { materializeCompleteKongAllocationHistory } from './refresh'
import { readBlockIdentities } from './rpc'
import type { AllocationState } from './types'

vi.mock('@/lib/doa/client', async (original) => ({
  ...(await original<typeof import('@/lib/doa/client')>()),
  readDoaOptimizations: vi.fn()
}))
vi.mock('./materialize', () => ({ materializeStates: vi.fn() }))
vi.mock('./rpc', () => ({
  readLatestSafeBlock: vi.fn(async () => ({ blockNumber: 100, blockTimestamp: 1000 })),
  readBlockIdentities: vi.fn(),
  readBlockTimestamps: vi.fn(async () => new Map()),
  readTransactionContexts: vi.fn(async () => new Map()),
  readAllocatorTriggerReplays: vi.fn(async () => new Map()),
  readContractNames: vi.fn(async () => new Map()),
  readVaultMetadata: vi.fn(async () => ({
    chainId: 1,
    address: vault.address,
    name: 'Test',
    symbol: 'yvTEST',
    assetAddress: vault.address,
    assetSymbol: 'TEST',
    assetDecimals: 6
  }))
}))

const vault = { chainId: 1 as const, address: '0x0000000000000000000000000000000000000001' as const, label: 'test' }
const hash = `0x${'1'.repeat(64)}`
function evidence(): AllocationEvidence {
  return {
    chainId: 1,
    vaultAddress: vault.address,
    events: [],
    deployments: [],
    coverage: {
      source: 'fixture',
      status: 'verified',
      fromBlock: 100,
      throughBlock: 100,
      fromBlockHash: hash,
      throughBlockHash: hash,
      sourceRevision: 'fixture-v1',
      evidenceDigest: 'a'.repeat(64),
      limitations: []
    }
  }
}
function state(): AllocationState {
  return {
    id: `allocation-state:1:${vault.address}:100`,
    stateGranularity: 'latest',
    blockNumber: 100,
    blockTimestamp: 1000,
    transactionHash: null,
    totalAssets: '0',
    totalDebt: '0',
    totalIdle: '0',
    allocatorAddress: null,
    sourceEventIds: [],
    strategies: []
  }
}

describe('shared reference refresh pipeline', () => {
  beforeEach(() => {
    vi.stubEnv('ALLOCATION_ALLOW_UNCERTIFIED_MATERIALIZATION', 'false')
    vi.stubEnv('ALLOCATION_MATERIALIZATION_TO_BLOCK', undefined)
    vi.mocked(readBlockIdentities).mockResolvedValue(new Map([[100, { number: 100, hash, timestamp: 1000 }]]))
    vi.mocked(readDoaOptimizations).mockRejectedValue(new DoaConfigurationError('Policy feed is optional'))
    vi.mocked(materializeStates).mockResolvedValue({ states: [state()], strategyAddresses: [] })
  })
  it('publishes an empty successful history snapshot from fixture input with optional policy unavailable', async () => {
    const result = await materializeCompleteKongAllocationHistory(vault, fixtureEventReader(evidence()))
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]).toMatchObject({
      kind: 'current_snapshot',
      after: { totalAssets: '0', totalIdle: '0', stateGranularity: 'block_end' }
    })
    expect(result.entries[0].after).not.toHaveProperty('unallocatedBps')
    expect(result.allowProvisional).toBe(false)
  })
  it('keeps a distinct current snapshot when an action occurs at the safe block', async () => {
    const input = evidence()
    input.events = [
      {
        id: 'role:100',
        chainId: 1,
        sourceAddress: vault.address,
        vaultAddress: vault.address,
        sourceLabel: 'vault',
        eventName: 'RoleSet',
        args: { account: vault.address, role: '96' },
        blockNumber: 100,
        blockTimestamp: 1000,
        blockHash: hash as `0x${string}`,
        transactionHash: hash as `0x${string}`,
        signature: hash as `0x${string}`,
        transactionIndex: 0,
        logIndex: 0,
        transactionFrom: vault.address,
        transactionTo: vault.address,
        inputSelector: null
      }
    ]
    const result = await materializeCompleteKongAllocationHistory(vault, fixtureEventReader(input))
    expect(result.entries).toHaveLength(2)
    expect(new Set(result.entries.map((entry) => entry.id)).size).toBe(2)
    expect(result.entries.filter((entry) => entry.kind === 'current_snapshot')).toHaveLength(1)
  })

  it('rejects invalid accounting even when event coverage is verified', async () => {
    vi.mocked(materializeStates).mockResolvedValue({
      states: [{ ...state(), totalAssets: '1' }],
      strategyAddresses: []
    })
    await expect(materializeCompleteKongAllocationHistory(vault, fixtureEventReader(evidence()))).rejects.toThrow(
      'accounting identity'
    )
  })
  it('keeps unverified event coverage provisional and requires explicit opt-in', async () => {
    const input = evidence()
    input.coverage.status = 'unverified'
    input.coverage.limitations = ['Earlier history is unknown']
    await expect(materializeCompleteKongAllocationHistory(vault, fixtureEventReader(input))).rejects.toThrow(
      'explicitly enabled'
    )
    vi.stubEnv('ALLOCATION_ALLOW_UNCERTIFIED_MATERIALIZATION', 'true')
    expect((await materializeCompleteKongAllocationHistory(vault, fixtureEventReader(input))).allowProvisional).toBe(
      true
    )
  })
  it('rejects conflicting block identity before reconstructing balances', async () => {
    const input = evidence()
    input.coverage.throughBlockHash = `0x${'2'.repeat(64)}`
    await expect(materializeCompleteKongAllocationHistory(vault, fixtureEventReader(input))).rejects.toThrow(
      'canonical block identity'
    )
    expect(materializeStates).not.toHaveBeenCalled()
  })
})
