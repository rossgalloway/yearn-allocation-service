import type {
  AllocationSourceEvent,
  VaultAccountingCheckpoint,
  VaultAccountingCheckpointFailure,
  VaultAllocationCoverage
} from './types'

const EVENT_PAGE_SIZE = 1000
const CHECKPOINT_PAGE_SIZE = 1000
const REQUEST_TIMEOUT_MS = 15_000

const EVENT_FIELDS = `
  id chainId vaultAddress sourceAddress sourceType eventName signature
  normalizationVersion abiVariant blockNumber blockTimestamp blockHash
  transactionHash transactionIndex logIndex topLevelTransactionFrom
  topLevelTransactionTo topLevelInputSelector strategyAddress argsJson
`

const CHECKPOINT_FIELDS = `
  id chainId vaultAddress blockNumber blockTimestamp blockHash totalAssets
  totalDebt totalIdle accountingIdentityHolds canonicalBlockVerified source sourceEventIds
`

export class EnvioConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EnvioConfigurationError'
  }
}

export class EnvioUpstreamError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'EnvioUpstreamError'
  }
}

export class AllocationReplayLimitError extends Error {
  constructor(limit: number) {
    super(`Allocation history exceeds the configured replay limit of ${limit} events`)
    this.name = 'AllocationReplayLimitError'
  }
}

function graphqlUrl(): string {
  const value = process.env.ENVIO_ALLOCATION_GRAPHQL_URL?.trim()
  if (!value) {
    throw new EnvioConfigurationError('ENVIO_ALLOCATION_GRAPHQL_URL is not configured')
  }
  return value
}

async function graphqlRequest<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  const url = graphqlUrl()
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json'
  }
  const token = process.env.ENVIO_ALLOCATION_GRAPHQL_TOKEN?.trim()
  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store'
    })
  } catch (error) {
    throw new EnvioUpstreamError('Unable to reach Envio Allocation History', { cause: error })
  }

  if (!response.ok) {
    throw new EnvioUpstreamError(`Envio Allocation History returned HTTP ${response.status}`)
  }

  const payload = (await response.json()) as {
    data?: T
    errors?: Array<{ message?: string }>
  }
  if (payload.errors?.length) {
    const message = payload.errors.map((error) => error.message ?? 'Unknown GraphQL error').join('; ')
    throw new EnvioUpstreamError(`Envio GraphQL error: ${message}`)
  }
  if (!payload.data) {
    throw new EnvioUpstreamError('Envio GraphQL response did not contain data')
  }
  return payload.data
}

function parseKnownGaps(value: unknown): string[] {
  if (typeof value !== 'string') return ['invalid-known-gaps-payload']
  try {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')
      ? parsed
      : ['invalid-known-gaps-payload']
  } catch {
    return ['invalid-known-gaps-payload']
  }
}

interface RawCoverage extends Omit<VaultAllocationCoverage, 'knownGaps'> {
  knownGapsJson: string
}

export async function fetchAllocationCoverage(input: {
  chainId: number
  vaultAddress: string
  coverageRevision?: string
  allowUnsafe: boolean
}): Promise<VaultAllocationCoverage | null> {
  const revision = input.coverageRevision ?? process.env.ENVIO_ALLOCATION_COVERAGE_REVISION?.trim()
  const revisionClause = revision ? 'coverageRevision: { _eq: $coverageRevision }' : ''
  const safetyClause = !revision && !input.allowUnsafe ? 'safeForTimeline: { _eq: true }' : ''
  const query = `
    query AllocationCoverage(
      $chainId: Int!
      $vaultAddress: String!
      ${revision ? '$coverageRevision: String!' : ''}
    ) {
      VaultAllocationCoverage(
        where: {
          chainId: { _eq: $chainId }
          vaultAddress: { _eq: $vaultAddress }
          ${revisionClause}
          ${safetyClause}
        }
        order_by: [{ validatedAt: desc }, { coverageRevision: desc }]
        limit: 1
      ) {
        id chainId vaultAddress coverageStartBlock coverageStartBlockHash
        validatedThroughBlock validatedThroughBlockHash vaultDiscoveryComplete
        eventHistoryComplete allocatorDeploymentHistoryComplete allocatorAssignmentHistoryComplete
        checkpointTriggerAuditComplete safeForTimeline knownGapsJson coverageRevision producerCommit validatedAt
      }
    }
  `
  const data = await graphqlRequest<{ VaultAllocationCoverage: RawCoverage[] }>(query, {
    chainId: input.chainId,
    vaultAddress: input.vaultAddress,
    ...(revision ? { coverageRevision: revision } : {})
  })
  const row = data.VaultAllocationCoverage[0]
  if (!row) return null
  const { knownGapsJson, ...coverage } = row
  return { ...coverage, knownGaps: parseKnownGaps(knownGapsJson) }
}

function eventCursor(row: AllocationSourceEvent) {
  return {
    blockNumber: row.blockNumber,
    transactionIndex: row.transactionIndex,
    logIndex: row.logIndex,
    id: row.id
  }
}

async function fetchEventPage(input: {
  chainId: number
  vaultAddress: string
  fromBlock: number
  toBlock: number
  cursor?: ReturnType<typeof eventCursor>
}): Promise<AllocationSourceEvent[]> {
  const continuation = input.cursor
    ? `_or: [
        { blockNumber: { _gt: $blockNumber } }
        { blockNumber: { _eq: $blockNumber }, transactionIndex: { _gt: $transactionIndex } }
        {
          blockNumber: { _eq: $blockNumber }
          transactionIndex: { _eq: $transactionIndex }
          logIndex: { _gt: $logIndex }
        }
        {
          blockNumber: { _eq: $blockNumber }
          transactionIndex: { _eq: $transactionIndex }
          logIndex: { _eq: $logIndex }
          id: { _gt: $id }
        }
      ]`
    : ''
  const cursorVariables = input.cursor ? '$blockNumber: Int! $transactionIndex: Int! $logIndex: Int! $id: String!' : ''
  const query = `
    query AllocationEventPage(
      $chainId: Int! $vaultAddress: String! $fromBlock: Int! $toBlock: Int! $limit: Int!
      ${cursorVariables}
    ) {
      AllocationSourceEvent(
        where: {
          chainId: { _eq: $chainId }
          vaultAddress: { _eq: $vaultAddress }
          blockNumber: { _gte: $fromBlock, _lte: $toBlock }
          ${continuation}
        }
        order_by: [
          { blockNumber: asc }
          { transactionIndex: asc }
          { logIndex: asc }
          { id: asc }
        ]
        limit: $limit
      ) { ${EVENT_FIELDS} }
    }
  `
  const data = await graphqlRequest<{ AllocationSourceEvent: AllocationSourceEvent[] }>(query, {
    chainId: input.chainId,
    vaultAddress: input.vaultAddress,
    fromBlock: input.fromBlock,
    toBlock: input.toBlock,
    limit: EVENT_PAGE_SIZE,
    ...(input.cursor ?? {})
  })
  return data.AllocationSourceEvent
}

export async function fetchAllocationEvents(input: {
  chainId: number
  vaultAddress: string
  fromBlock: number
  toBlock: number
  maxEvents: number
}): Promise<AllocationSourceEvent[]> {
  const events: AllocationSourceEvent[] = []
  let cursor: ReturnType<typeof eventCursor> | undefined

  while (true) {
    const page = await fetchEventPage({ ...input, cursor })
    if (page.length === 0) break
    events.push(...page)
    if (events.length > input.maxEvents) {
      throw new AllocationReplayLimitError(input.maxEvents)
    }
    if (page.length < EVENT_PAGE_SIZE) break
    const lastEvent = page.at(-1)
    if (!lastEvent) break
    cursor = eventCursor(lastEvent)
  }
  return events
}

export async function fetchAccountingCheckpoints(input: {
  chainId: number
  vaultAddress: string
  fromBlock: number
  toBlock: number
}): Promise<VaultAccountingCheckpoint[]> {
  const checkpoints: VaultAccountingCheckpoint[] = []
  let afterBlock = input.fromBlock - 1

  while (true) {
    const query = `
      query AccountingCheckpointPage(
        $chainId: Int! $vaultAddress: String! $afterBlock: Int! $toBlock: Int! $limit: Int!
      ) {
        VaultAccountingCheckpoint(
          where: {
            chainId: { _eq: $chainId }
            vaultAddress: { _eq: $vaultAddress }
            blockNumber: { _gt: $afterBlock, _lte: $toBlock }
          }
          order_by: [{ blockNumber: asc }]
          limit: $limit
        ) { ${CHECKPOINT_FIELDS} }
      }
    `
    const data = await graphqlRequest<{ VaultAccountingCheckpoint: VaultAccountingCheckpoint[] }>(query, {
      chainId: input.chainId,
      vaultAddress: input.vaultAddress,
      afterBlock,
      toBlock: input.toBlock,
      limit: CHECKPOINT_PAGE_SIZE
    })
    const page = data.VaultAccountingCheckpoint
    if (page.length === 0) break
    checkpoints.push(...page)
    if (page.length < CHECKPOINT_PAGE_SIZE) break
    const lastCheckpoint = page.at(-1)
    if (!lastCheckpoint) break
    afterBlock = lastCheckpoint.blockNumber
  }
  return checkpoints
}

export async function fetchUnresolvedCheckpointFailures(input: {
  chainId: number
  vaultAddress: string
  fromBlock: number
  toBlock: number
}): Promise<VaultAccountingCheckpointFailure[]> {
  const query = `
    query UnresolvedCheckpointFailures(
      $chainId: Int! $vaultAddress: String! $fromBlock: Int! $toBlock: Int!
    ) {
      VaultAccountingCheckpointFailure(
        where: {
          chainId: { _eq: $chainId }
          vaultAddress: { _eq: $vaultAddress }
          blockNumber: { _gte: $fromBlock, _lte: $toBlock }
          resolved: { _eq: false }
        }
        order_by: [{ blockNumber: asc }]
      ) { id blockNumber expectedBlockHash reason sourceEventIds }
    }
  `
  const data = await graphqlRequest<{
    VaultAccountingCheckpointFailure: VaultAccountingCheckpointFailure[]
  }>(query, {
    chainId: input.chainId,
    vaultAddress: input.vaultAddress,
    fromBlock: input.fromBlock,
    toBlock: input.toBlock
  })
  return data.VaultAccountingCheckpointFailure
}
