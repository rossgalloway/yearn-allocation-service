import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AllocationReplayLimitError, envioGraphqlRequest } from '@/lib/envio/client'
import { fetchCompleteKongAllocationEvents } from './envio'
import type { Address } from './types'

vi.mock('@/lib/envio/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/envio/client')>()
  return { ...actual, envioGraphqlRequest: vi.fn() }
})

const vault = '0x00000000000000000000000000000000000000aa' as Address
const strategy = '0x00000000000000000000000000000000000000bb'

function debtUpdatedRow(blockNumber: number) {
  const transactionHash = `0x${blockNumber.toString(16).padStart(64, '0')}`
  return {
    id: `debt-updated:${blockNumber}`,
    blockHash: `0x${'1'.repeat(64)}`,
    blockNumber,
    blockTimestamp: blockNumber * 10,
    chainId: 1,
    logIndex: 0,
    transactionFrom: vault,
    transactionHash,
    transactionIndex: 0,
    vaultAddress: vault,
    strategy,
    current_debt: String(blockNumber - 1),
    new_debt: String(blockNumber)
  }
}

describe('complete Envio allocation event paging', () => {
  beforeEach(() => {
    vi.mocked(envioGraphqlRequest).mockReset()
  })

  it('walks beyond the first 1,000 rows with a stable keyset cursor', async () => {
    vi.mocked(envioGraphqlRequest).mockImplementation(async (query, variables) => {
      if (query.includes('AllocationSourceEvent(')) return { AllocationSourceEvent: [] } as never
      if (!query.includes('items: DebtUpdated(')) return { items: [] } as never
      if (variables.cursorBlock === undefined) {
        return { items: Array.from({ length: 1_000 }, (_, index) => debtUpdatedRow(index + 1)) } as never
      }
      expect(variables).toMatchObject({ cursorBlock: 1_000, cursorTransaction: 0, cursorLog: 0 })
      return { items: [debtUpdatedRow(1_001)] } as never
    })

    const result = await fetchCompleteKongAllocationEvents({
      chainId: 1,
      vaultAddress: vault,
      fromBlock: 1,
      toBlock: 1_001,
      maxEvents: 2_000
    })

    expect(result.events).toHaveLength(1_001)
    expect(result.events.at(-1)?.blockNumber).toBe(1_001)
    expect(result.truncatedEventFamilies).toEqual([])
    expect(result.normalizedSupplementAvailable).toBe(true)
  })

  it('fails instead of publishing a truncated event family', async () => {
    vi.mocked(envioGraphqlRequest).mockImplementation(async (query) => {
      if (query.includes('AllocationSourceEvent(')) return { AllocationSourceEvent: [] } as never
      if (query.includes('items: DebtUpdated(')) {
        return { items: Array.from({ length: 1_000 }, (_, index) => debtUpdatedRow(index + 1)) } as never
      }
      return { items: [] } as never
    })

    await expect(
      fetchCompleteKongAllocationEvents({
        chainId: 1,
        vaultAddress: vault,
        fromBlock: 1,
        toBlock: 1_001,
        maxEvents: 999
      })
    ).rejects.toBeInstanceOf(AllocationReplayLimitError)
  })
})
