import { describe, expect, it } from 'vitest'
import type { VaultAllocationCoverage } from '@/lib/envio/types'
import { allocationCoverageContractIssues } from './service'

function coverage(overrides: Partial<VaultAllocationCoverage> = {}): VaultAllocationCoverage {
  return {
    id: 'revision:1:vault',
    chainId: 1,
    vaultAddress: '0x00000000000000000000000000000000000000aa',
    coverageStartBlock: 100,
    coverageStartBlockHash: `0x${'1'.repeat(64)}`,
    validatedThroughBlock: 200,
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
    validatedAt: '1000',
    ...overrides
  }
}

describe('allocationCoverageContractIssues', () => {
  it('accepts a complete immutable safe row', () => {
    expect(allocationCoverageContractIssues(coverage())).toEqual([])
  })

  it('rejects a row marked safe when gates or known gaps disagree', () => {
    expect(
      allocationCoverageContractIssues(
        coverage({
          eventHistoryComplete: false,
          knownGaps: ['candidate parity not run']
        })
      )
    ).toEqual(['safe-row-has-incomplete-gates', 'safe-row-has-known-gaps'])
  })
})
