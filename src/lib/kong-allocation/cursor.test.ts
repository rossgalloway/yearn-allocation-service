import { describe, expect, it } from 'vitest'
import { AllocationHistoryCursorError, decodeAllocationHistoryCursor, encodeAllocationHistoryCursor } from './cursor'

describe('allocation history cursor', () => {
  it('round-trips a versioned keyset cursor', () => {
    const encoded = encodeAllocationHistoryCursor({
      version: 2,
      projectionId: '12',
      runId: '34',
      projection: 'chart',
      direction: 'desc',
      endBlock: 100,
      entryId: 'allocation-entry:1:vault:99-100'
    })

    expect(decodeAllocationHistoryCursor(encoded, 'desc', 'chart')).toEqual({
      version: 2,
      projectionId: '12',
      runId: '34',
      projection: 'chart',
      direction: 'desc',
      endBlock: 100,
      entryId: 'allocation-entry:1:vault:99-100'
    })
  })

  it('rejects malformed and direction-mismatched cursors', () => {
    expect(() => decodeAllocationHistoryCursor('not-a-cursor', 'desc', 'full')).toThrow(AllocationHistoryCursorError)
    const asc = encodeAllocationHistoryCursor({
      version: 2,
      projectionId: '12',
      runId: '34',
      projection: 'full',
      direction: 'asc',
      endBlock: 100,
      entryId: 'entry'
    })
    expect(() => decodeAllocationHistoryCursor(asc, 'desc', 'full')).toThrow(AllocationHistoryCursorError)
    expect(() => decodeAllocationHistoryCursor(asc, 'asc', 'chart')).toThrow(AllocationHistoryCursorError)
    const oversized = encodeAllocationHistoryCursor({
      version: 2,
      projectionId: '9223372036854775808',
      runId: '34',
      projection: 'full',
      direction: 'desc',
      endBlock: 100,
      entryId: 'entry'
    })
    expect(() => decodeAllocationHistoryCursor(oversized, 'desc', 'full')).toThrow(AllocationHistoryCursorError)
  })
})
