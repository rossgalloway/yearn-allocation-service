import { afterEach, describe, expect, it, vi } from 'vitest'
import { decodeMulticall, encodeMulticall, MULTICALL3_ADDRESS } from './multicall'
import { readContractCalls } from './rpc'
import type { Address, Hash } from './types'

const address = '0x1234567890abcdef1234567890abcdef12345678' as Address
const uint = (n: number) => n.toString(16).padStart(64, '0')
const zero = `0x${uint(0)}` as Hash
// Independently constructed ABI return fixture: (bool,bytes)[] with three tuples.
const response =
  `0x${uint(32)}${uint(3)}${uint(96)}${uint(224)}${uint(352)}${uint(1)}${uint(64)}${uint(32)}${uint(0)}${uint(0)}${uint(64)}${uint(4)}deadbeef${'0'.repeat(56)}${uint(1)}${uint(64)}${uint(0)}` as Hash
const calls = (count: number, blockNumber = 123) =>
  Array.from({ length: count }, (_, i) => ({ key: String(i), address, data: '0x01e1d114' as Hash, blockNumber }))

function mockRpc(result: (request: { id: number; method: string; params: unknown[] }) => unknown) {
  const fetcher = vi.fn(async (_url: unknown, init: RequestInit) => {
    const requests = JSON.parse(String(init.body))
    return new Response(
      JSON.stringify(
        requests
          .map((request: { id: number; method: string; params: unknown[] }) => ({
            id: request.id,
            jsonrpc: '2.0',
            result: result(request)
          }))
          .reverse()
      )
    )
  })
  vi.stubGlobal('fetch', fetcher)
  vi.stubEnv('RPC_URL_1', 'https://rpc.example.test')
  return fetcher
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('Multicall3 archive reads', () => {
  it('encodes aggregate3 with correct nested offsets and allowFailure', () => {
    expect(encodeMulticall([{ address, data: '0x12345678' }])).toBe(
      `0x82ad56cb${uint(32)}${uint(1)}${uint(32)}${address.slice(2).padStart(64, '0')}${uint(1)}${uint(96)}${uint(4)}12345678${'0'.repeat(56)}`
    )
  })
  it('preserves zero, failed calls, and successful empty data separately', () => {
    expect(decodeMulticall(response, 3)).toEqual([zero, null, '0x'])
    expect(() => decodeMulticall(response, 2)).toThrow()
    expect(() => decodeMulticall(response.slice(0, -2) as Hash, 3)).toThrow()
    expect(() => decodeMulticall('0x' as Hash, 3)).toThrow()
  })
  it('replaces three same-block calls with one aggregate and preserves result keys', async () => {
    const f = mockRpc((r) => (r.method === 'eth_getCode' ? '0x6000' : response))
    expect(await readContractCalls(1, calls(3), { multicall: true })).toEqual(
      new Map([
        ['0', zero],
        ['1', null],
        ['2', '0x']
      ])
    )
    const batches = f.mock.calls.map(([, init]) => JSON.parse(String(init.body)))
    expect(batches[0]).toHaveLength(1)
    expect(batches[1]).toHaveLength(1)
    expect(batches[1][0].params).toEqual([{ to: MULTICALL3_ADDRESS, data: encodeMulticall(calls(3)) }, '0x7b'])
  })
  it('keeps distinct blocks separate, bounds page sizes, and matches unordered RPC results', async () => {
    const f = mockRpc((r) => (r.method === 'eth_getCode' ? '0x' : zero))
    const input = [...calls(51), ...calls(2, 124).map((x) => ({ ...x, key: `b${x.key}` }))]
    expect((await readContractCalls(1, input, { multicall: true })).size).toBe(53)
    const checks = JSON.parse(String(f.mock.calls[0][1].body))
    expect(checks.map((r: { params: unknown[] }) => r.params[1])).toEqual(['0x7b', '0x7c'])
    expect(JSON.parse(String(f.mock.calls[1][1].body))).toHaveLength(53)
  })
  it('bounds aggregate chunks to fifty and does not mix blocks', async () => {
    const f = mockRpc((r) => {
      if (r.method === 'eth_getCode') return '0x6000'
      const data = (r.params[0] as { data: string }).data
      if (!data.startsWith('0x82ad56cb')) return zero
      const count = Number(BigInt(`0x${data.slice(74, 138)}`))
      return `0x${uint(32)}${uint(count)}${Array.from({ length: count }, (_, i) => uint(count * 32 + i * 96)).join('')}${(`${uint(1)}${uint(64)}${uint(0)}`).repeat(count)}`
    })
    await readContractCalls(1, [...calls(51), ...calls(2, 124).map((x) => ({ ...x, key: `b${x.key}` }))], {
      multicall: true
    })
    const batch = JSON.parse(String(f.mock.calls[1][1].body))
    expect(batch).toHaveLength(3)
    expect(batch.map((r: { params: unknown[] }) => r.params[1])).toEqual(['0x7b', '0x7b', '0x7c'])
  })
  it('leaves unopted reads direct, without deployment checks', async () => {
    const f = mockRpc(() => zero)
    await readContractCalls(1, calls(3))
    expect(f).toHaveBeenCalledTimes(1)
    expect(JSON.parse(String(f.mock.calls[0][1].body))).toHaveLength(3)
  })
  it('fails outer errors without expensive direct fan-out', async () => {
    const f = mockRpc((r) => (r.method === 'eth_getCode' ? '0x6000' : null))
    await expect(readContractCalls(1, calls(3), { multicall: true })).rejects.toThrow('Multicall3 request failed')
    expect(f).toHaveBeenCalledTimes(2)
  })
  it('does not turn unavailable deployment evidence into a fallback', async () => {
    const f = mockRpc(() => null)
    await expect(readContractCalls(1, calls(3), { multicall: true })).rejects.toThrow(
      'historical Multicall3 deployment'
    )
    expect(f).toHaveBeenCalledTimes(1)
  })
})
