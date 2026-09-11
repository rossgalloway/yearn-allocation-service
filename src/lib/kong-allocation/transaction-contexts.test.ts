import { afterEach, expect, it, vi } from 'vitest'
import { readTransactionContexts } from './rpc'
import type { Address, Hash } from './types'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

it('reduces each trace page before requesting the next, retaining every transaction context', async () => {
  vi.stubEnv('RPC_URL_1', 'https://rpc.test')
  const vault = `0x${'1'.repeat(40)}` as Address
  const sender = `0x${'2'.repeat(40)}` as Address
  const hashes = Array.from({ length: 105 }, (_, i) => `0x${i.toString(16).padStart(64, '0')}` as Hash)
  const reduced = new Set<string>()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: unknown, init: RequestInit) => {
      const requests = JSON.parse(String(init.body)) as { id: number; method: string; params: string[] }[]
      if (requests[0].params[0] === hashes[100]) expect(reduced.size).toBe(100)
      const payload = requests.map((request) => ({
        id: request.id,
        result:
          request.method === 'trace_transaction'
            ? [
                {
                  type: 'call',
                  action: { from: sender, to: vault },
                  get traceAddress() {
                    reduced.add(request.params[0])
                    return []
                  }
                }
              ]
            : { from: sender, to: vault, input: '0x12345678' }
      }))
      return { ok: true, json: async () => payload }
    })
  )
  const contexts = await readTransactionContexts(1, [...hashes, hashes[0]], vault)
  expect(contexts.size).toBe(105)
  for (const hash of hashes)
    expect(contexts.get(hash)).toMatchObject({ from: sender, to: vault, inputSelector: '0x12345678' })
  expect(fetch).toHaveBeenCalledTimes(4)
})
