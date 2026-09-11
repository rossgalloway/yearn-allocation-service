import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { databasePool, databaseQuery } from '@/lib/database/client'
import { runDatabaseMigrations } from '@/lib/database/migrations'
import {
  type HistoricalRequest,
  type HistoricalTransport,
  historicalCache,
  withHistoricalCache
} from './historical-cache'

const enabled = process.env.TEST_DATABASE_URL && process.env.TEST_DATABASE_URL === process.env.DATABASE_URL
const suite = enabled ? describe.sequential : describe.skip
const chainId = 987650
const blockHash = `0x${'a'.repeat(64)}`
let hash = blockHash
const request: HistoricalRequest = {
  method: 'eth_call',
  params: [{ to: `0x${'1'.repeat(40)}`, data: '0x12345678' }, '0x64']
}
let getterCalls = 0
const transport: HistoricalTransport = async (requests) =>
  requests.map((r, i) => {
    if (r.method === 'eth_chainId') return { id: i + 1, result: `0x${chainId.toString(16)}` }
    if (r.method === 'eth_getBlockByNumber') return { id: i + 1, result: { number: '0x64', timestamp: '0x3e8', hash } }
    getterCalls++
    return { id: i + 1, result: '0x00' }
  })
suite('persistent finalized cache', () => {
  beforeAll(async () => {
    await runDatabaseMigrations()
    await databaseQuery('DELETE FROM allocation_historical_cache WHERE chain_id=$1', [chainId])
    await databaseQuery('DELETE FROM allocation_finalized_block WHERE chain_id=$1', [chainId])
  })
  afterAll(async () => {
    await databaseQuery('DELETE FROM allocation_historical_cache WHERE chain_id=$1', [chainId])
    await databaseQuery('DELETE FROM allocation_finalized_block WHERE chain_id=$1', [chainId])
    await databasePool().end()
  })
  it('persists reads across independent refresh contexts', async () => {
    const work = async () => {
      const c = historicalCache()
      if (!c) throw new Error('Missing scope')
      return c.execute([request], transport)
    }
    const first = await withHistoricalCache(chainId, transport, work)
    const second = await withHistoricalCache(chainId, transport, work)
    expect(first.result[0].result).toBe('0x00')
    expect(second.result).toEqual(first.result)
    expect(getterCalls).toBe(1)
    expect(second.stats.rpcHits).toBe(1)
  })
  it('rejects reuse when a saved finalized anchor changes', async () => {
    hash = `0x${'b'.repeat(64)}`
    await expect(withHistoricalCache(chainId, transport, async () => null)).rejects.toThrow(
      'Finalized block hash changed'
    )
    expect(getterCalls).toBe(1)
  })
})
