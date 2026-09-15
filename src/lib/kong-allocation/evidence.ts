import type { Address, AllocationSourceEvent, AllocatorDeploymentEvidence } from './types'
import type { TestVault } from './vaults'

/** The input boundary shared by an Envio adapter here and Kong's stored-event reader. */
export interface EventCoverage {
  source: 'envio' | 'fixture'
  status: 'verified' | 'unverified'
  fromBlock: number
  throughBlock: number
  fromBlockHash: string | null
  throughBlockHash: string | null
  sourceRevision: string | null
  evidenceDigest: string
  limitations: string[]
}

export interface AllocationEvidence {
  chainId: number
  vaultAddress: Address
  events: AllocationSourceEvent[]
  deployments: AllocatorDeploymentEvidence[]
  coverage: EventCoverage
}

export interface AllocationEventReader {
  read(input: { vault: TestVault; finalizedBlock: number; maxEvents: number }): Promise<AllocationEvidence>
}

export class AllocationCoverageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AllocationCoverageError'
  }
}

export function isAllocationTransitionEvent(event: AllocationSourceEvent): boolean {
  return event.eventName !== 'Deposit' && event.eventName !== 'Withdraw'
}

export function assertEvidence(
  input: AllocationEvidence,
  vault: { chainId: number; address: Address },
  finalizedBlock: number
): void {
  const coverage = input.coverage
  if (input.chainId !== vault.chainId || input.vaultAddress.toLowerCase() !== vault.address.toLowerCase()) {
    throw new AllocationCoverageError('Event evidence belongs to a different vault')
  }
  if (
    !Number.isSafeInteger(coverage.fromBlock) ||
    !Number.isSafeInteger(coverage.throughBlock) ||
    coverage.fromBlock < 0 ||
    coverage.throughBlock < coverage.fromBlock ||
    coverage.throughBlock > finalizedBlock
  )
    throw new AllocationCoverageError('Event evidence has invalid coverage bounds')
  if (
    coverage.status === 'verified' &&
    (!coverage.sourceRevision ||
      coverage.limitations.length > 0 ||
      !/^0x[a-fA-F0-9]{64}$/.test(coverage.fromBlockHash ?? '') ||
      !/^0x[a-fA-F0-9]{64}$/.test(coverage.throughBlockHash ?? ''))
  )
    throw new AllocationCoverageError('Verified event evidence lacks coverage provenance')
  if (coverage.status === 'unverified' && coverage.limitations.length === 0) {
    throw new AllocationCoverageError('Unverified event evidence must explain its limitations')
  }
  if (
    input.events.some(
      (event) =>
        event.blockNumber > coverage.throughBlock || (event.chainId !== undefined && event.chainId !== vault.chainId)
    )
  ) {
    throw new AllocationCoverageError('Events fall outside the selected chain or safe range')
  }
}

/** Pinned input fixtures exercise the same reconstruction pipeline without Envio. */
export function fixtureEventReader(evidence: AllocationEvidence): AllocationEventReader {
  return {
    async read({ vault, finalizedBlock, maxEvents }) {
      assertEvidence(evidence, vault, finalizedBlock)
      if (evidence.events.length > maxEvents) throw new AllocationCoverageError('Fixture exceeds the event limit')
      return structuredClone(evidence)
    }
  }
}
