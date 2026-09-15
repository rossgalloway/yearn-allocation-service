import type { EventCoverage } from './evidence'

export const ALLOCATION_MATERIALIZER_VERSION = 'allocation-history-v2-event-reader'

export interface AllocationDataQuality {
  certification: 'certified' | 'provisional'
  limitations: string[]
  coverage: EventCoverage
  accounting: { source: 'archive_rpc'; status: 'reconciled'; granularity: 'block_end' }
  snapshot: { blockNumber: number; blockTimestamp: number }
  processingVersion: string
}

export function allocationDataQuality(
  coverage: EventCoverage,
  snapshot: AllocationDataQuality['snapshot']
): AllocationDataQuality {
  return {
    certification: coverage.status === 'verified' ? 'certified' : 'provisional',
    limitations: [...coverage.limitations],
    coverage,
    accounting: { source: 'archive_rpc', status: 'reconciled', granularity: 'block_end' },
    snapshot,
    processingVersion: ALLOCATION_MATERIALIZER_VERSION
  }
}
