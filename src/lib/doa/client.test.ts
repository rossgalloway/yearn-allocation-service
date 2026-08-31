import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearDoaOptimizationCache, readDoaOptimizations } from './client'

const originalUrl = process.env.UPSTASH_REDIS_REST_URL
const originalToken = process.env.UPSTASH_REDIS_REST_TOKEN

function payload() {
  return JSON.stringify([
    {
      vault: '0x00000000000000000000000000000000000000aa',
      strategyDebtRatios: [
        {
          strategy: '0x00000000000000000000000000000000000000bb',
          name: 'Strategy',
          currentRatio: 4000,
          targetRatio: 5000
        }
      ],
      currentApr: 100,
      proposedApr: 200,
      explain: 'optimization'
    }
  ])
}

describe('readDoaOptimizations', () => {
  beforeEach(() => {
    clearDoaOptimizationCache()
    process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example'
    process.env.UPSTASH_REDIS_REST_TOKEN = 'secret'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    clearDoaOptimizationCache()
    if (originalUrl === undefined) delete process.env.UPSTASH_REDIS_REST_URL
    else process.env.UPSTASH_REDIS_REST_URL = originalUrl
    if (originalToken === undefined) delete process.env.UPSTASH_REDIS_REST_TOKEN
    else process.env.UPSTASH_REDIS_REST_TOKEN = originalToken
  })

  it('scans and pipelines DOA history without an SDK', async () => {
    const raw = payload()
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ result: ['0', ['doa:optimizations:1:1713776400', 'doa:optimizations:1:latest']] })
        )
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([{ result: raw }, { result: raw }])))
    vi.stubGlobal('fetch', fetchMock)

    const records = await readDoaOptimizations(1)

    expect(records).toHaveLength(2)
    expect(records.find((record) => record.source.isLatestAlias)?.freshness.optimizationTimestampUtc).toBe(
      '2024-04-22T09:00:00.000Z'
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://redis.example',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(['SCAN', '0', 'MATCH', 'doa:optimizations:1:*', 'COUNT', 500])
      })
    )
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://redis.example/pipeline',
      expect.objectContaining({
        body: JSON.stringify([
          ['GET', 'doa:optimizations:1:1713776400'],
          ['GET', 'doa:optimizations:1:latest']
        ])
      })
    )
  })
})
