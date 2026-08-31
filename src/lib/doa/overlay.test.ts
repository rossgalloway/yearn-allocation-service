import { describe, expect, it } from 'vitest'
import type { AllocationTimeline } from '@/lib/allocation/service'
import { calculateDoaAllocationCoverage } from './coverage'
import { enrichDoaOptimization, selectVaultDoaOptimizations } from './overlay'
import type { DoaOptimizationRecord } from './types'

const vault = '0x00000000000000000000000000000000000000aa'
const optimizedStrategy = '0x00000000000000000000000000000000000000bb'
const omittedStrategy = '0x00000000000000000000000000000000000000cc'

function optimization(overrides: Partial<DoaOptimizationRecord> = {}): DoaOptimizationRecord {
  const strategyDebtRatios = [
    {
      strategy: optimizedStrategy,
      name: 'Optimized strategy',
      currentRatio: 4157,
      targetRatio: 4157
    }
  ]
  return {
    vault,
    strategyDebtRatios,
    currentApr: 100,
    proposedApr: 110,
    explain: 'optimizer intent',
    source: {
      key: 'doa:optimizations:1:1000',
      chainId: 1,
      revision: '1000',
      isLatestAlias: false,
      timestampUtc: '1970-01-01T00:16:40.000Z',
      latestMatchedTimestampUtc: null
    },
    allocationCoverage: calculateDoaAllocationCoverage(strategyDebtRatios),
    freshness: {
      optimizationTimestampUtc: '1970-01-01T00:16:40.000Z',
      latestAvailableTimestampUtc: '1970-01-01T00:16:40.000Z'
    },
    ...overrides
  }
}

function timeline(): AllocationTimeline {
  return {
    chainId: 1,
    vaultAddress: vault,
    coverage: {
      id: 'revision:1:vault',
      chainId: 1,
      vaultAddress: vault,
      coverageStartBlock: 1,
      coverageStartBlockHash: `0x${'1'.repeat(64)}`,
      validatedThroughBlock: 2,
      validatedThroughBlockHash: `0x${'2'.repeat(64)}`,
      vaultDiscoveryComplete: true,
      eventHistoryComplete: true,
      allocatorDeploymentHistoryComplete: true,
      allocatorAssignmentHistoryComplete: true,
      checkpointTriggerAuditComplete: true,
      safeForTimeline: true,
      knownGaps: [],
      coverageRevision: 'revision',
      producerCommit: 'a'.repeat(40),
      validatedAt: '1000'
    },
    complete: true,
    provisional: false,
    sourceEventCount: 1,
    checkpointCount: 1,
    unresolvedCheckpointFailures: [],
    states: [
      {
        id: 'state',
        chainId: 1,
        vaultAddress: vault,
        blockNumber: 2,
        blockTimestamp: 1000,
        timestampUtc: '1970-01-01T00:16:40.000Z',
        blockHash: `0x${'2'.repeat(64)}`,
        totalAssets: '10000',
        totalDebt: '9998',
        totalIdle: '2',
        unallocatedBps: 2,
        strategies: [
          {
            strategyAddress: optimizedStrategy,
            name: null,
            currentDebt: '4157',
            currentDebtBps: 4157,
            maxDebt: null,
            maxDebtBps: null,
            targetDebtRatioBps: 4200,
            isActive: true
          },
          {
            strategyAddress: omittedStrategy,
            name: null,
            currentDebt: '5841',
            currentDebtBps: 5841,
            maxDebt: null,
            maxDebtBps: null,
            targetDebtRatioBps: null,
            isActive: true
          }
        ],
        sourceEventIds: ['event'],
        accountingIdentityHolds: true,
        canonicalBlockVerified: true,
        complete: true,
        issues: []
      }
    ]
  }
}

describe('DOA allocation overlay', () => {
  it('uses indexed state for current allocation while retaining optimizer intent', () => {
    const enriched = enrichDoaOptimization(optimization(), timeline())

    expect(enriched.allocationCoverage.currentResidualBps).toBe(5843)
    expect(enriched.allocationCoverage.unallocatedBps).toBe(2)
    expect(enriched.allocationSnapshot.complete).toBe(true)
    expect(enriched.allocationSnapshot.strategies).toEqual([
      expect.objectContaining({
        address: optimizedStrategy,
        currentBps: 4157,
        optimizerCurrentBps: 4157,
        targetBps: 4157,
        indexedTargetDebtRatioBps: 4200,
        optimizerScope: 'optimized'
      }),
      expect.objectContaining({
        address: omittedStrategy,
        currentBps: 5841,
        optimizerCurrentBps: null,
        targetBps: null,
        optimizerScope: 'unknown'
      })
    ])
  })

  it('returns an honest fallback when certified indexed state is unavailable', () => {
    const enriched = enrichDoaOptimization(optimization(), null)

    expect(enriched.allocationCoverage.unallocatedBps).toBeNull()
    expect(enriched.allocationSnapshot).toEqual(
      expect.objectContaining({ complete: false, source: null, strategies: [], unallocatedBps: null })
    )
  })

  it('does not extend the last indexed state beyond its proven timeline horizon', () => {
    const outOfRange = optimization({
      freshness: {
        optimizationTimestampUtc: '1970-01-01T00:16:41.000Z',
        latestAvailableTimestampUtc: '1970-01-01T00:16:41.000Z'
      }
    })

    expect(enrichDoaOptimization(outOfRange, timeline()).allocationSnapshot).toEqual(
      expect.objectContaining({ complete: false, source: null, strategies: [], unallocatedBps: null })
    )
  })

  it('deduplicates the latest alias when its timestamped record is present', () => {
    const timestamped = optimization()
    const latest = optimization({
      source: {
        ...timestamped.source,
        key: 'doa:optimizations:1:latest',
        revision: 'latest',
        isLatestAlias: true,
        timestampUtc: null,
        latestMatchedTimestampUtc: timestamped.freshness.optimizationTimestampUtc
      }
    })

    expect(selectVaultDoaOptimizations([latest, timestamped], vault, 10)).toEqual([timestamped])
  })
})
