import { describe, expect, it } from 'vitest'
import { AllocationHistoryCursorError, decodeAllocationHistoryCursor, encodeAllocationHistoryCursor } from './cursor'

describe('allocation history cursor', () => {
  it('round-trips a versioned keyset cursor', () => {
    const encoded = encodeAllocationHistoryCursor({
      version: 1,
      projectionId: '12',
      runId: '34',
      direction: 'desc',
      endBlock: 100,
      entryId: 'allocation-entry:1:vault:99-100'
    })

    expect(decodeAllocationHistoryCursor(encoded, 'desc')).toEqual({
      version: 1,
      projectionId: '12',
      runId: '34',
      direction: 'desc',
      endBlock: 100,
      entryId: 'allocation-entry:1:vault:99-100'
    })
  })

  it('rejects malformed and direction-mismatched cursors', () => {
    expect(() => decodeAllocationHistoryCursor('not-a-cursor', 'desc')).toThrow(AllocationHistoryCursorError)
    const asc = encodeAllocationHistoryCursor({
      version: 1,
      projectionId: '12',
      runId: '34',
      direction: 'asc',
      endBlock: 100,
      entryId: 'entry'
    })
    expect(() => decodeAllocationHistoryCursor(asc, 'desc')).toThrow(AllocationHistoryCursorError)
    const oversized = encodeAllocationHistoryCursor({
      version: 1,
      projectionId: '9223372036854775808',
      runId: '34',
      direction: 'desc',
      endBlock: 100,
      entryId: 'entry'
    })
    expect(() => decodeAllocationHistoryCursor(oversized, 'desc')).toThrow(AllocationHistoryCursorError)
  })
})
