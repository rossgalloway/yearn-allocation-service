import { createHash } from 'node:crypto'
import { EnvioUpstreamError, envioGraphqlRequest } from '@/lib/envio/client'
import { fetchCompleteKongAllocationEvents } from './envio'
import { AllocationCoverageError, type AllocationEventReader, type EventCoverage } from './evidence'

interface CoverageRow {
  coverageStartBlock: number
  coverageStartBlockHash: string
  validatedThroughBlock: number
  validatedThroughBlockHash: string
  vaultDiscoveryComplete: boolean
  eventHistoryComplete: boolean
  allocatorAssignmentHistoryComplete: boolean
  knownGapsJson: string
  coverageRevision: string
}

async function readCoverage(chainId: number, vaultAddress: string): Promise<CoverageRow | null> {
  const revision = process.env.ENVIO_ALLOCATION_COVERAGE_REVISION?.trim()
  const data = await envioGraphqlRequest<{ rows: CoverageRow[] }>(
    `query AllocationEventCoverage($chainId: Int! $vault: String! ${revision ? '$revision: String!' : ''}) {
      rows: VaultAllocationCoverage(where: {chainId: {_eq: $chainId}, vaultAddress: {_eq: $vault}
        ${revision ? ', coverageRevision: {_eq: $revision}' : ''}}
        order_by: [{validatedAt: desc}, {coverageRevision: desc}] limit: 1) {
        coverageStartBlock coverageStartBlockHash validatedThroughBlock validatedThroughBlockHash
        vaultDiscoveryComplete eventHistoryComplete allocatorAssignmentHistoryComplete
        knownGapsJson coverageRevision
      }
    }`,
    { chainId, vault: vaultAddress.toLowerCase(), ...(revision ? { revision } : {}) }
  )
  if (!Array.isArray(data.rows)) throw new EnvioUpstreamError('Envio omitted event coverage')
  return data.rows[0] ?? null
}

async function optionalCoverage(chainId: number, vault: string): Promise<CoverageRow | null> {
  try {
    return await readCoverage(chainId, vault)
  } catch (error) {
    if (!(error instanceof EnvioUpstreamError)) throw error
    return null
  }
}

export const envioEventReader: AllocationEventReader = {
  async read({ vault, finalizedBlock, maxEvents }) {
    const [progress, row] = await Promise.all([
      envioGraphqlRequest<{ chain_metadata: { latest_processed_block: number }[] }>(
        'query AllocationProgress($chainId:Int!){chain_metadata(where:{chain_id:{_eq:$chainId}}){latest_processed_block}}',
        { chainId: vault.chainId }
      ),
      optionalCoverage(vault.chainId, vault.address)
    ])
    const indexed = progress.chain_metadata?.[0]?.latest_processed_block
    if (!Number.isSafeInteger(indexed) || indexed < 0)
      throw new AllocationCoverageError('Envio indexed progress is unavailable')
    const validRange =
      row &&
      Number.isSafeInteger(row.coverageStartBlock) &&
      Number.isSafeInteger(row.validatedThroughBlock) &&
      row.coverageStartBlock >= 0 &&
      row.coverageStartBlock <= row.validatedThroughBlock
    const throughBlock = Math.min(finalizedBlock, indexed, validRange ? row.validatedThroughBlock : Infinity)
    const fromBlock = validRange ? row.coverageStartBlock : 0
    if (throughBlock < fromBlock) throw new AllocationCoverageError('Event coverage does not contain a finalized block')
    const limitations: string[] = []
    if (!validRange)
      limitations.push('Verified event coverage is unavailable; history before the first observed event is unknown')
    if (row) {
      if (!row.vaultDiscoveryComplete || !row.eventHistoryComplete || !row.allocatorAssignmentHistoryComplete) {
        limitations.push('Required event discovery, history, or allocator-assignment coverage is incomplete')
      }
      if (!row.coverageRevision) limitations.push('Event source revision is unavailable')
      try {
        const gaps: unknown = JSON.parse(row.knownGapsJson)
        if (!Array.isArray(gaps) || !gaps.every((gap) => typeof gap === 'string')) throw new Error('Invalid gaps')
        limitations.push(...gaps)
      } catch {
        limitations.push('Event coverage gaps could not be decoded')
      }
    }
    // Initialization needs strategy, role and configuration history before the displayed range.
    const batch = await fetchCompleteKongAllocationEvents({
      chainId: vault.chainId,
      vaultAddress: vault.address,
      fromBlock: 0,
      toBlock: throughBlock,
      maxEvents
    })
    if (!batch.normalizedSupplementAvailable || batch.unresolvedEventIds.length > 0) {
      limitations.push('Allocator event evidence is unavailable or contains unresolved events')
    }
    if (row && JSON.stringify(await optionalCoverage(vault.chainId, vault.address)) !== JSON.stringify(row)) {
      throw new AllocationCoverageError('Event coverage changed during acquisition; retry the refresh')
    }
    const coverage: EventCoverage = {
      source: 'envio',
      status: limitations.length === 0 ? 'verified' : 'unverified',
      fromBlock,
      throughBlock,
      fromBlockHash: validRange ? row.coverageStartBlockHash : null,
      throughBlockHash: validRange && throughBlock === row.validatedThroughBlock ? row.validatedThroughBlockHash : null,
      sourceRevision: row?.coverageRevision || null,
      evidenceDigest: createHash('sha256')
        .update(JSON.stringify([batch.events, batch.deployments]))
        .digest('hex'),
      limitations: [...new Set(limitations)]
    }
    return {
      chainId: vault.chainId,
      vaultAddress: vault.address,
      events: batch.events,
      deployments: batch.deployments,
      coverage
    }
  }
}
