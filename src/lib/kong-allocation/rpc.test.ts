import { describe, expect, it } from 'vitest'
import { decodeAddress, decodeString, decodeUint, encodeAddressCall, encodeAddressPairCall, triggerTarget } from './rpc'
import type { Address, Hash } from './types'

describe('archive RPC ABI helpers', () => {
  it('decodes uint and address words', () => {
    const encoded = `0x${'0'.repeat(63)}a${'0'.repeat(24)}1234567890abcdef1234567890abcdef12345678` as Hash

    expect(decodeUint(encoded)).toBe(10n)
    expect(decodeAddress(encoded, 1)).toBe('0x1234567890abcdef1234567890abcdef12345678')
  })

  it('decodes dynamic strings', () => {
    const value = Buffer.from('yvUSDC-1').toString('hex').padEnd(64, '0')
    const encoded = `0x${'20'.padStart(64, '0')}${'8'.padStart(64, '0')}${value}` as Hash

    expect(decodeString(encoded)).toBe('yvUSDC-1')
  })

  it('encodes address call arguments', () => {
    const address = '0x1234567890abcdef1234567890abcdef12345678' as Address
    expect(encodeAddressCall('0x12345678', address)).toBe(`0x12345678${address.slice(2).padStart(64, '0')}`)
  })

  it('encodes vault and strategy arguments for shared allocator calls', () => {
    const vault = '0x1234567890abcdef1234567890abcdef12345678' as Address
    const strategy = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as Address

    expect(encodeAddressPairCall('0x12345678', vault, strategy)).toBe(
      `0x12345678${vault.slice(2).padStart(64, '0')}${strategy.slice(2).padStart(64, '0')}`
    )
  })
})

describe('allocator trigger payloads', () => {
  it('validates the family selector and every address before interpreting a zero target', () => {
    const vault = '0x1234567890abcdef1234567890abcdef12345678' as Address
    const strategy = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' as Address
    const payload = `${encodeAddressPairCall('0xda5f3286', vault, strategy)}${'0'.repeat(64)}` as Hash
    expect(triggerTarget(payload, { family: 'shared', vaultAddress: vault, strategyAddress: strategy })).toBe(0n)
    expect(triggerTarget(payload, { family: 'vault_bound', vaultAddress: vault, strategyAddress: strategy })).toBeNull()
    expect(triggerTarget(payload, { family: 'shared', vaultAddress: strategy, strategyAddress: vault })).toBeNull()
  })
})
