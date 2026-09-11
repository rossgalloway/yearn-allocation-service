import { describe, expect, it, vi } from 'vitest'
import { cacheableResult, HistoricalCache, type HistoricalRequest } from './historical-cache'
import { stateEvidenceKeys } from './materialize'
import type { Address, AllocationSourceEvent, Hash } from './types'

const block = { number: 100, hash: `0x${'a'.repeat(64)}`, timestamp: 1000 }
const address = `0x${'1'.repeat(40)}` as Address
const tx = `0x${'b'.repeat(64)}`
const request: HistoricalRequest = { method: 'eth_call', params: [{ to: address, data: '0x12345678' }, '0x64'] }
function memoryCache() {
  const cache = new HistoricalCache(1, block, vi.fn())
  const rows = new Map<string, unknown>()
  vi.spyOn(cache, 'get').mockImplementation(
    async (keys) => new Map(keys.filter((k) => rows.has(k)).map((k) => [k, rows.get(k)]))
  )
  vi.spyOn(cache, 'put').mockImplementation(async (values) => {
    for (const row of values) rows.set(row.key, row.payload)
  })
  return { cache, rows }
}

describe('finalized historical RPC caching', () => {
  it('reuses successful zero across executions and keys by chain and block hash', async () => {
    const { cache, rows } = memoryCache()
    const load = vi.fn(async () => [{ id: 1, result: '0x00' }])
    await cache.execute([request], load)
    expect((await cache.execute([request], load))[0].result).toBe('0x00')
    expect(load).toHaveBeenLastCalledWith([])
    expect(rows.size).toBe(1)
    expect(cache.stats.rpcHits).toBe(1)
    expect(cache.key('rpc', block, request)).not.toBe(
      cache.key('rpc', { ...block, hash: `0x${'c'.repeat(64)}` }, request)
    )
    expect(cache.key('rpc', block, request)).not.toBe(
      new HistoricalCache(8453, block, vi.fn()).key('rpc', block, request)
    )
  })
  it('does not cache errors, null results, or unfinalized reads', async () => {
    const { cache, rows } = memoryCache()
    await cache.execute([request], async () => [{ id: 1, error: { message: 'quota' } }])
    await cache.execute([request], async () => [{ id: 1, result: null }])
    await cache.execute([{ ...request, params: [request.params[0], '0x65'] }], async () => [{ id: 1, result: '0x01' }])
    expect(rows.size).toBe(0)
  })
  it('preserves partial successes and only requests failed subcalls again', async () => {
    const { cache } = memoryCache()
    const other = { ...request, params: [{ to: address, data: '0x87654321' }, '0x64'] }
    await cache.execute([request, other], async () => [
      { id: 1, result: '0x00' },
      { id: 2, result: null }
    ])
    const load = vi.fn(async () => [{ id: 1, result: '0x01' }])
    const next = await cache.execute([request, other], load)
    expect(load).toHaveBeenCalledWith([other])
    expect(next.map((r) => r.result)).toEqual(['0x00', '0x01'])
  })
  it('checks event hash identity before binding transaction traces', async () => {
    const { cache } = memoryCache()
    await expect(
      cache.registerEvents([{ blockNumber: 100, blockHash: `0x${'c'.repeat(64)}`, transactionHash: tx }])
    ).rejects.toThrow('block hash mismatch')
    await cache.registerEvents([{ blockNumber: 100, blockHash: block.hash, transactionHash: tx }])
    expect(cache.transactions.get(tx)).toEqual(block)
  })
  it('requires mined transaction and trace identity, and rejects empty/malformed traces', () => {
    const r = { method: 'trace_transaction', params: [tx] }
    expect(cacheableResult(r, [], block)).toBe(false)
    expect(cacheableResult(r, [{ transactionHash: tx }], block)).toBe(false)
    const trace = [
      { transactionHash: tx, blockHash: block.hash, blockNumber: 100, action: {}, type: 'call', traceAddress: [] }
    ]
    expect(cacheableResult(r, trace, block)).toBe(true)
    expect(cacheableResult(r, trace, { ...block, hash: `0x${'c'.repeat(64)}` })).toBe(false)
    expect(
      cacheableResult(
        { method: 'eth_getTransactionByHash', params: [tx] },
        { hash: tx, blockHash: block.hash, blockNumber: '0x64', from: address, to: address, input: '0x' },
        block
      )
    ).toBe(true)
  })
})

function event(id: string, blockNumber: number, args: Record<string, unknown> = {}): AllocationSourceEvent {
  return {
    id,
    chainId: 1,
    sourceAddress: address,
    sourceLabel: 'vault',
    eventName: 'DebtUpdated',
    signature: tx as Hash,
    blockNumber,
    blockTimestamp: blockNumber * 10,
    transactionHash: tx as Hash,
    transactionIndex: 0,
    logIndex: 0,
    blockHash: block.hash as Hash,
    args
  }
}
describe('incremental state dependencies', () => {
  const blocks = [100, 110, 120].map((blockNumber) => ({
    blockNumber,
    blockTimestamp: blockNumber * 10,
    stateGranularity: 'block_end' as const
  }))
  const input = { chainId: 1, vaultAddress: address, blocks, events: [event('first', 100)] }
  it('reuses the earlier prefix when new events arrive', () => {
    const old = stateEvidenceKeys(input)
    const next = stateEvidenceKeys({ ...input, events: [...input.events, event('new', 115)] })
    expect(next.get(100)).toBe(old.get(100))
    expect(next.get(110)).toBe(old.get(110))
    expect(next.get(120)).not.toBe(old.get(120))
  })
  it('invalidates the affected suffix for corrected historical evidence', () => {
    const old = stateEvidenceKeys(input)
    const next = stateEvidenceKeys({ ...input, events: [event('first', 100, { newDebt: '9' })] })
    for (const n of [100, 110, 120]) expect(next.get(n)).not.toBe(old.get(n))
  })
  it('invalidates old states when late deployment provenance appears', () => {
    const old = stateEvidenceKeys(input)
    const next = stateEvidenceKeys({
      ...input,
      deployments: [
        {
          allocatorAddress: address,
          factoryAddress: address,
          family: 'shared',
          boundVaultAddress: null,
          governanceAddress: address,
          createdBlock: 105,
          sourceEventId: 'factory',
          abiVariant: 'shared'
        }
      ]
    })
    expect(next.get(100)).toBe(old.get(100))
    expect(next.get(110)).not.toBe(old.get(110))
  })
})
