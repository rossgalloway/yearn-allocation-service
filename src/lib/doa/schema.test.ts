import { describe, expect, it } from 'vitest'
import { parseDoaOptimizations } from './schema'

describe('parseDoaOptimizations', () => {
  it('accepts and normalizes the DOA Redis record contract', () => {
    const [record] = parseDoaOptimizations([
      {
        vault: '0x00000000000000000000000000000000000000AA',
        strategyDebtRatios: [
          {
            strategy: '0x00000000000000000000000000000000000000BB',
            name: 'Strategy',
            currentRatio: 4000,
            targetRatio: 5000,
            currentApr: 100,
            targetApr: 200
          }
        ],
        currentApr: 100,
        proposedApr: 200,
        explain: 'optimization'
      }
    ])

    expect(record.vault).toBe('0x00000000000000000000000000000000000000aa')
    expect(record.strategyDebtRatios[0].strategy).toBe('0x00000000000000000000000000000000000000bb')
  })

  it('rejects malformed ratios before they can reach consumers', () => {
    expect(() =>
      parseDoaOptimizations([
        {
          vault: '0x00000000000000000000000000000000000000aa',
          strategyDebtRatios: [
            {
              strategy: '0x00000000000000000000000000000000000000bb',
              currentRatio: 10_001,
              targetRatio: 0
            }
          ],
          currentApr: 100,
          proposedApr: 200,
          explain: ''
        }
      ])
    ).toThrow('strategyDebtRatios.0.currentRatio')
  })
})
