import type { Address, Hash } from './types'

// Official deployments: https://github.com/mds1/multicall3/blob/main/deployments.json
export const MULTICALL3_ADDRESS: Address = '0xca11bde05977b3631167028862be2a173976ca11'
export const MULTICALL3_CHAINS = new Set([1, 8453, 747474])
export const MULTICALL3_PAGE_SIZE = 50

function uint(value: number): string {
  return value.toString(16).padStart(64, '0')
}

// aggregate3((address,bool,bytes)[]), with allowFailure=true for every read.
export function encodeMulticall(calls: readonly { address: Address; data: Hash }[]): Hash {
  const tuples = calls.map(({ address, data }) => {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address) || !/^0x(?:[0-9a-fA-F]{2})*$/.test(data))
      throw new Error('Invalid Multicall input')
    const bytes = data.slice(2)
    return (
      address.slice(2).padStart(64, '0') +
      uint(1) +
      uint(96) +
      uint(bytes.length / 2) +
      bytes.padEnd(Math.ceil(bytes.length / 64) * 64, '0')
    )
  })
  let offset = calls.length * 32
  const offsets = tuples.map((tuple) => {
    const value = uint(offset)
    offset += tuple.length / 2
    return value
  })
  return `0x82ad56cb${uint(32)}${uint(calls.length)}${offsets.join('')}${tuples.join('')}`
}

// A malformed outer result is an upstream failure, not a successful empty read.
export function decodeMulticall(data: Hash, count: number): (Hash | null)[] {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/.test(data)) throw new Error('Invalid Multicall response')
  const body = data.slice(2)
  const size = body.length / 2
  function numberAt(offset: number): number {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset + 32 > size) throw new Error('Invalid Multicall offset')
    const n = BigInt(`0x${body.slice(offset * 2, offset * 2 + 64)}`)
    if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid Multicall number')
    return Number(n)
  }
  if (numberAt(0) !== 32 || numberAt(32) !== count || 64 + count * 32 > size)
    throw new Error('Invalid Multicall result count')
  let expectedOffset = count * 32
  return Array.from({ length: count }, (_, i) => {
    const offset = numberAt(64 + i * 32)
    if (offset !== expectedOffset) throw new Error('Invalid Multicall tuple offset')
    const tuple = 64 + offset
    const success = numberAt(tuple)
    if (success !== 0 && success !== 1) throw new Error('Invalid Multicall success flag')
    if (numberAt(tuple + 32) !== 64) throw new Error('Invalid Multicall bytes offset')
    const length = numberAt(tuple + 64)
    const end = tuple + 96 + Math.ceil(length / 32) * 32
    if (end > size) throw new Error('Truncated Multicall bytes')
    expectedOffset = end - 64
    if (i === count - 1 && end !== size) throw new Error('Trailing Multicall bytes')
    return success === 1 ? (`0x${body.slice((tuple + 96) * 2, (tuple + 96 + length) * 2)}` as Hash) : null
  })
}
