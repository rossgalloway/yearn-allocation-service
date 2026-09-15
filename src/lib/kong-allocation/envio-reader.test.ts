import { beforeEach, describe, expect, it, vi } from 'vitest'
import { envioGraphqlRequest } from '@/lib/envio/client'
import { fetchCompleteKongAllocationEvents } from './envio'
import { envioEventReader } from './envio-reader'

vi.mock('@/lib/envio/client', async (original) => ({
  ...(await original<typeof import('@/lib/envio/client')>()),
  envioGraphqlRequest: vi.fn()
}))
vi.mock('./envio', () => ({ fetchCompleteKongAllocationEvents: vi.fn() }))
const vault = { chainId: 1 as const, address: '0x0000000000000000000000000000000000000001' as const, label: 'test' }
const row = {
  coverageStartBlock: 10,
  coverageStartBlockHash: `0x${'1'.repeat(64)}`,
  validatedThroughBlock: 100,
  validatedThroughBlockHash: `0x${'2'.repeat(64)}`,
  vaultDiscoveryComplete: true,
  eventHistoryComplete: true,
  allocatorAssignmentHistoryComplete: true,
  knownGapsJson: '[]',
  coverageRevision: 'events-v1'
}

describe('Envio event reader', () => {
  beforeEach(() => {
    vi.mocked(fetchCompleteKongAllocationEvents).mockResolvedValue({
      events: [],
      deployments: [],
      normalizedSupplementAvailable: true,
      unresolvedEventIds: [],
      truncatedEventFamilies: []
    })
    vi.mocked(envioGraphqlRequest).mockImplementation(async (query) =>
      query.includes('AllocationProgress') ? { chain_metadata: [{ latest_processed_block: 100 }] } : { rows: [row] }
    )
  })
  it('uses event coverage without requesting accounting checkpoints and bounds reads by finality', async () => {
    const result = await envioEventReader.read({ vault, finalizedBlock: 90, maxEvents: 100 })
    expect(result.coverage).toMatchObject({
      status: 'verified',
      fromBlock: 10,
      throughBlock: 90,
      sourceRevision: 'events-v1',
      throughBlockHash: null
    })
    expect(fetchCompleteKongAllocationEvents).toHaveBeenCalledWith(
      expect.objectContaining({ fromBlock: 0, toBlock: 90 })
    )
    expect(
      vi
        .mocked(envioGraphqlRequest)
        .mock.calls.map(([query]) => query)
        .join('\n')
    ).not.toMatch(/Checkpoint|safeForTimeline/)
  })
  it('does not mistake indexed progress or empty rows for complete history', async () => {
    vi.mocked(envioGraphqlRequest).mockImplementation(async (query) =>
      query.includes('AllocationProgress') ? { chain_metadata: [{ latest_processed_block: 80 }] } : { rows: [] }
    )
    const result = await envioEventReader.read({ vault, finalizedBlock: 90, maxEvents: 100 })
    expect(result.coverage).toMatchObject({ status: 'unverified', throughBlock: 80, sourceRevision: null })
    expect(result.coverage.limitations.length).toBeGreaterThan(0)
  })
  it('rejects a coverage revision change during acquisition', async () => {
    let reads = 0
    vi.mocked(envioGraphqlRequest).mockImplementation(async (query) =>
      query.includes('AllocationProgress')
        ? { chain_metadata: [{ latest_processed_block: 100 }] }
        : { rows: [{ ...row, coverageRevision: `revision-${reads++}` }] }
    )
    await expect(envioEventReader.read({ vault, finalizedBlock: 90, maxEvents: 100 })).rejects.toThrow(
      'changed during acquisition'
    )
  })
})
