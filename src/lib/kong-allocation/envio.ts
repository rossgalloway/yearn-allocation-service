import { AllocationReplayLimitError, envioGraphqlRequest } from '@/lib/envio/client'
import type { Address, AllocationSourceEvent, AllocatorDeploymentEvidence, Hash } from './types'

const EVENT_PAGE_SIZE = 1000
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/
const HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/
const NORMALIZED_SUPPLEMENT_EVENT_NAMES = [
  'AddedNewVault',
  'UpdateDebtAllocator',
  'RemovedVault',
  'UpdateRoleManager',
  'UpdateStrategyDebtRatio',
  'UpdateStrategyDebtRatios',
  'UpdateKeeper',
  'GovernanceTransferred'
] as const

interface EventDefinition {
  table: string
  eventName: string
  signature: Hash
  fields: string
  sourceLabel: AllocationSourceEvent['sourceLabel']
  sourceAddressField: string
  strategyField?: string
  args: (row: Record<string, unknown>) => Record<string, unknown>
}

interface EventCursor {
  blockNumber: number
  transactionIndex: number
  logIndex: number
  id: string
}

const commonFields = `
  blockHash blockNumber blockTimestamp chainId id logIndex transactionFrom
  transactionHash transactionIndex
`

function decimal(value: unknown): string | null {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
  return typeof value === 'string' && /^\d+$/.test(value) ? value : null
}

function address(value: unknown): Address | null {
  return typeof value === 'string' && ADDRESS_PATTERN.test(value) ? (value.toLowerCase() as Address) : null
}

function addresses(value: unknown): Address[] {
  return Array.isArray(value) ? value.map(address).filter((item): item is Address => item !== null) : []
}

const VAULT_EVENTS: EventDefinition[] = [
  {
    table: 'Deposit',
    eventName: 'Deposit',
    signature: '0xdcbc1c05240f31ff3ad067ef1ee35ce4997762752e3a095284754544f4c709d7',
    fields: 'vaultAddress sender owner assets shares',
    sourceLabel: 'vault',
    sourceAddressField: 'vaultAddress',
    args: (row) => ({
      sender: address(row.sender),
      owner: address(row.owner),
      assets: decimal(row.assets),
      shares: decimal(row.shares)
    })
  },
  {
    table: 'Withdraw',
    eventName: 'Withdraw',
    signature: '0xfbde797d201c681b91056529119e0b02407c7bb96a4a2c75c01fc9667232c8db',
    fields: 'vaultAddress sender receiver owner assets shares',
    sourceLabel: 'vault',
    sourceAddressField: 'vaultAddress',
    args: (row) => ({
      sender: address(row.sender),
      receiver: address(row.receiver),
      owner: address(row.owner),
      assets: decimal(row.assets),
      shares: decimal(row.shares)
    })
  },
  {
    table: 'DebtUpdated',
    eventName: 'DebtUpdated',
    signature: '0x5e2b8821ad6e0e26207e0cb4d242d07eeb1cbb1cfd853e645bdcd27cc5484f95',
    fields: 'vaultAddress strategy current_debt new_debt',
    sourceLabel: 'vault',
    sourceAddressField: 'vaultAddress',
    strategyField: 'strategy',
    args: (row) => ({
      strategy: address(row.strategy),
      currentDebt: decimal(row.current_debt),
      newDebt: decimal(row.new_debt)
    })
  },
  {
    table: 'StrategyReported',
    eventName: 'StrategyReported',
    signature: '0x7f2ad1d3ba35276f35ef140f83e3e0f17b23064fd710113d3f7a5ab30d267811',
    fields: 'vaultAddress strategy gain loss current_debt protocol_fees total_fees total_refunds',
    sourceLabel: 'vault',
    sourceAddressField: 'vaultAddress',
    strategyField: 'strategy',
    args: (row) => ({
      strategy: address(row.strategy),
      gain: decimal(row.gain),
      loss: decimal(row.loss),
      currentDebt: decimal(row.current_debt),
      protocolFees: decimal(row.protocol_fees),
      totalFees: decimal(row.total_fees),
      totalRefunds: decimal(row.total_refunds)
    })
  },
  {
    table: 'StrategyChanged',
    eventName: 'StrategyChanged',
    signature: '0xde8ff765a5c5dad48d27bc9faa99836fb81f3b07c9dc62cfe005475d6b83a2ca',
    fields: 'vaultAddress strategy change_type',
    sourceLabel: 'vault',
    sourceAddressField: 'vaultAddress',
    strategyField: 'strategy',
    args: (row) => ({ strategy: address(row.strategy), changeType: decimal(row.change_type) })
  },
  {
    table: 'UpdatedMaxDebtForStrategy',
    eventName: 'UpdatedMaxDebtForStrategy',
    signature: '0xb3eef2123fec1523a6bbc90aceb203000154c1a4974335fe06b544c7534d4b89',
    fields: 'vaultAddress sender strategy new_debt',
    sourceLabel: 'vault',
    sourceAddressField: 'vaultAddress',
    strategyField: 'strategy',
    args: (row) => ({ sender: address(row.sender), strategy: address(row.strategy), newDebt: decimal(row.new_debt) })
  },
  {
    table: 'DebtPurchased',
    eventName: 'DebtPurchased',
    signature: '0xe94e7f88819f66c19b097748cb754149f63b1a176ed425dee1f1ee933e6d09b0',
    fields: 'vaultAddress strategy amount',
    sourceLabel: 'vault',
    sourceAddressField: 'vaultAddress',
    strategyField: 'strategy',
    args: (row) => ({ strategy: address(row.strategy), amount: decimal(row.amount) })
  },
  {
    table: 'UpdateDefaultQueue',
    eventName: 'UpdateDefaultQueue',
    signature: '0x0bc0cb8c5ccee13e6a2fd26a699f57ad7ff6e454e6aae97ec41cd2eb9ebd63a5',
    fields: 'vaultAddress new_default_queue',
    sourceLabel: 'vault',
    sourceAddressField: 'vaultAddress',
    args: (row) => ({ newDefaultQueue: addresses(row.new_default_queue) })
  },
  {
    table: 'UpdateUseDefaultQueue',
    eventName: 'UpdateUseDefaultQueue',
    signature: '0x1f88e73ebc721f227812938fe07a069ec1f7136aafacb397ed460bd15dee13f1',
    fields: 'vaultAddress use_default_queue',
    sourceLabel: 'vault',
    sourceAddressField: 'vaultAddress',
    args: (row) => ({ useDefaultQueue: row.use_default_queue === true })
  },
  {
    table: 'RoleSet',
    eventName: 'RoleSet',
    signature: '0x78557646b1d8efa2cd49740d66df5aca39eb610ca8ca0e1ccac08979b6b2c46e',
    fields: 'vaultAddress account role',
    sourceLabel: 'vault',
    sourceAddressField: 'vaultAddress',
    args: (row) => ({ account: address(row.account), role: decimal(row.role) })
  },
  {
    table: 'RoleStatusChanged',
    eventName: 'RoleStatusChanged',
    signature: '0xfe075e51fb76b038a5d44dd2e56b16e6c928e35c0f3cc237312ad09bbca5aee5',
    fields: 'vaultAddress role status',
    sourceLabel: 'vault',
    sourceAddressField: 'vaultAddress',
    args: (row) => ({ role: decimal(row.role), status: decimal(row.status) })
  },
  {
    table: 'UpdateRoleManager',
    eventName: 'UpdateRoleManager',
    signature: '0xce93baa0b608a7d420822b6b90cfcccb70574363ba4fd26ef5ac17dd465016c4',
    fields: 'vaultAddress role_manager',
    sourceLabel: 'vault',
    sourceAddressField: 'vaultAddress',
    args: (row) => ({ roleManager: address(row.role_manager) })
  },
  {
    table: 'UpdateAccountant',
    eventName: 'UpdateAccountant',
    signature: '0x28709a2dab2a5d5e8688e96159011151c51644ab21839a8a45b449634d7c8b2b',
    fields: 'vaultAddress accountant',
    sourceLabel: 'vault',
    sourceAddressField: 'vaultAddress',
    args: (row) => ({ accountant: address(row.accountant) })
  }
]

function safeInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`Envio returned an invalid ${field}`)
  return parsed
}

function hash(value: unknown, field: string): Hash {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) throw new Error(`Envio returned an invalid ${field}`)
  return value.toLowerCase() as Hash
}

function sourceEvent(definition: EventDefinition, row: Record<string, unknown>): AllocationSourceEvent {
  const sourceAddress = address(row[definition.sourceAddressField])
  if (!sourceAddress) throw new Error(`Envio returned an invalid source address for ${definition.eventName}`)
  const transactionHash = hash(row.transactionHash, 'transaction hash')
  const logIndex = safeInteger(row.logIndex, 'log index')
  const transactionFrom = address(row.transactionFrom)
  const strategyAddress = definition.strategyField ? address(row[definition.strategyField]) : undefined
  return {
    id: `${safeInteger(row.chainId, 'chain ID')}:${transactionHash}:${logIndex}`,
    sourceAddress,
    chainId: safeInteger(row.chainId, 'chain ID'),
    vaultAddress: address(row.vaultAddress),
    blockHash: hash(row.blockHash, 'block hash'),
    sourceLabel: definition.sourceLabel,
    eventName: definition.eventName,
    signature: definition.signature,
    blockNumber: safeInteger(row.blockNumber, 'block number'),
    blockTimestamp: safeInteger(row.blockTimestamp, 'block timestamp'),
    transactionHash,
    transactionIndex: safeInteger(row.transactionIndex, 'transaction index'),
    logIndex,
    transactionFrom,
    transactionTo: null,
    inputSelector: null,
    ...(definition.strategyField ? { strategyAddress: strategyAddress ?? null } : {}),
    args: definition.args(row)
  }
}

function normalizedSourceEvent(row: Record<string, unknown>): AllocationSourceEvent {
  const sourceAddress = address(row.sourceAddress)
  if (!sourceAddress) throw new Error('Envio returned an invalid normalized source address')
  const transactionHash = hash(row.transactionHash, 'transaction hash')
  const logIndex = safeInteger(row.logIndex, 'log index')
  const eventName = typeof row.eventName === 'string' ? row.eventName : null
  if (!eventName) throw new Error('Envio returned an invalid normalized event name')
  let args: Record<string, unknown>
  try {
    const parsed = typeof row.argsJson === 'string' ? JSON.parse(row.argsJson) : null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid args')
    args = parsed as Record<string, unknown>
  } catch {
    throw new Error(`Envio returned invalid normalized args for ${eventName}`)
  }
  const sourceType = typeof row.sourceType === 'string' ? row.sourceType.toLowerCase() : ''
  const sourceLabel: AllocationSourceEvent['sourceLabel'] = sourceType.includes('factory')
    ? 'debtManagerFactory'
    : sourceType === 'rolemanager'
      ? 'roleManager'
      : sourceType.includes('allocator')
        ? 'debtAllocator'
        : sourceType === 'vault'
          ? 'vault'
          : 'unknown'
  return {
    id: `${safeInteger(row.chainId, 'chain ID')}:${transactionHash}:${logIndex}`,
    sourceAddress,
    chainId: safeInteger(row.chainId, 'chain ID'),
    vaultAddress: address(row.vaultAddress),
    scope: row.scope === 'allocator' ? 'allocator' : 'vault',
    abiVariant: String(row.abiVariant),
    associationEvidence: String(row.associationEvidence),
    normalizationVersion: safeInteger(row.normalizationVersion, 'normalization version'),
    blockHash: hash(row.blockHash, 'block hash'),
    sourceLabel,
    eventName,
    signature: hash(row.signature, 'event signature'),
    blockNumber: safeInteger(row.blockNumber, 'block number'),
    blockTimestamp: safeInteger(row.blockTimestamp, 'block timestamp'),
    transactionHash,
    transactionIndex: safeInteger(row.transactionIndex, 'transaction index'),
    logIndex,
    transactionFrom: address(row.topLevelTransactionFrom),
    transactionTo: address(row.topLevelTransactionTo),
    inputSelector:
      typeof row.topLevelInputSelector === 'string' && /^0x[a-fA-F0-9]{8}$/.test(row.topLevelInputSelector)
        ? (row.topLevelInputSelector.toLowerCase() as Hash)
        : null,
    strategyAddress: address(row.strategyAddress),
    args
  }
}

function rawEventCursor(row: Record<string, unknown>): EventCursor {
  if (typeof row.id !== 'string' || row.id.length === 0) throw new Error('Envio returned an invalid event cursor ID')
  return {
    blockNumber: safeInteger(row.blockNumber, 'block number'),
    transactionIndex: safeInteger(row.transactionIndex, 'transaction index'),
    logIndex: safeInteger(row.logIndex, 'log index'),
    id: row.id
  }
}

function cursorClause(cursor: EventCursor | undefined): string {
  if (!cursor) return ''
  return `_or: [
    { blockNumber: { _gt: $cursorBlock } }
    { blockNumber: { _eq: $cursorBlock }, transactionIndex: { _gt: $cursorTransaction } }
    {
      blockNumber: { _eq: $cursorBlock }
      transactionIndex: { _eq: $cursorTransaction }
      logIndex: { _gt: $cursorLog }
    }
    {
      blockNumber: { _eq: $cursorBlock }
      transactionIndex: { _eq: $cursorTransaction }
      logIndex: { _eq: $cursorLog }
      id: { _gt: $cursorId }
    }
  ]`
}

function cursorVariables(cursor: EventCursor | undefined): string {
  return cursor ? '$cursorBlock: Int! $cursorTransaction: Int! $cursorLog: Int! $cursorId: String!' : ''
}

function cursorValues(cursor: EventCursor | undefined): Record<string, unknown> {
  return cursor
    ? {
        cursorBlock: cursor.blockNumber,
        cursorTransaction: cursor.transactionIndex,
        cursorLog: cursor.logIndex,
        cursorId: cursor.id
      }
    : {}
}

async function fetchDefinitionRows(input: {
  definition: EventDefinition
  chainId: number
  fromBlock: number
  toBlock: number
  where: string
  variables: Record<string, unknown>
  variableDefinitions: string
  maxEvents: number
}): Promise<Record<string, unknown>[]> {
  const collected: Record<string, unknown>[] = []
  let cursor: EventCursor | undefined
  while (true) {
    const data = await envioGraphqlRequest<{ items: Record<string, unknown>[] }>(
      `query KongAllocationEventPage(
        $chainId: Int!
        $fromBlock: Int!
        $toBlock: Int!
        $pageSize: Int!
        ${input.variableDefinitions}
        ${cursorVariables(cursor)}
      ) {
        items: ${input.definition.table}(
          where: {
            ${input.where}
            blockNumber: { _gte: $fromBlock, _lte: $toBlock }
            ${cursorClause(cursor)}
          }
          order_by: [{ blockNumber: asc }, { transactionIndex: asc }, { logIndex: asc }, { id: asc }]
          limit: $pageSize
        ) { ${commonFields} ${input.definition.fields} }
      }`,
      {
        chainId: input.chainId,
        fromBlock: input.fromBlock,
        toBlock: input.toBlock,
        pageSize: EVENT_PAGE_SIZE,
        ...input.variables,
        ...cursorValues(cursor)
      }
    )
    if (!Array.isArray(data.items)) throw new Error(`Envio response omitted ${input.definition.eventName}`)
    collected.push(...data.items)
    if (collected.length > input.maxEvents) throw new AllocationReplayLimitError(input.maxEvents)
    if (data.items.length < EVENT_PAGE_SIZE) break
    const last = data.items.at(-1)
    if (!last) break
    const next = rawEventCursor(last)
    if (cursor && JSON.stringify(next) === JSON.stringify(cursor)) {
      throw new Error(`Envio pagination did not advance for ${input.definition.eventName}`)
    }
    cursor = next
  }
  return collected
}

const normalizedFields = `
  id chainId sourceAddress sourceType eventName signature blockNumber blockTimestamp blockHash
  transactionHash transactionIndex logIndex topLevelTransactionFrom topLevelTransactionTo
  topLevelInputSelector strategyAddress argsJson normalizationVersion abiVariant
`

async function fetchEvidenceRows(input: {
  table: string
  fields: string
  chainId: number
  toBlock: number
  maxEvents: number
  filter: string
  variables: Record<string, unknown>
  variableDefinitions: string
}): Promise<Record<string, unknown>[]> {
  const collected: Record<string, unknown>[] = []
  let cursor: EventCursor | undefined
  while (true) {
    const data = await envioGraphqlRequest<{ items: Record<string, unknown>[] }>(
      `query KongAllocationEvidencePage($chainId: Int! $toBlock: Int! $pageSize: Int!
        ${input.variableDefinitions} ${cursorVariables(cursor)}) {
        items: ${input.table}(where: {
          chainId: { _eq: $chainId } blockNumber: { _lte: $toBlock }
          ${input.filter} ${cursorClause(cursor)}
        } order_by: [{blockNumber: asc}, {transactionIndex: asc}, {logIndex: asc}, {id: asc}]
          limit: $pageSize) { ${input.fields} }
      }`,
      {
        chainId: input.chainId,
        toBlock: input.toBlock,
        pageSize: EVENT_PAGE_SIZE,
        ...input.variables,
        ...cursorValues(cursor)
      }
    )
    if (!Array.isArray(data.items)) throw new Error(`Envio response omitted ${input.table}`)
    collected.push(...data.items)
    if (collected.length > input.maxEvents) throw new AllocationReplayLimitError(input.maxEvents)
    if (data.items.length < EVENT_PAGE_SIZE) return collected
    const next = rawEventCursor(data.items[data.items.length - 1])
    if (cursor && JSON.stringify(next) === JSON.stringify(cursor))
      throw new Error('Envio evidence pagination did not advance')
    cursor = next
  }
}

async function fetchDeployments(input: {
  chainId: number
  toBlock: number
  maxEvents: number
  allocatorAddresses: Address[]
}): Promise<AllocatorDeploymentEvidence[]> {
  if (!input.allocatorAddresses.length) return []
  const deployments: AllocatorDeploymentEvidence[] = []
  for (const family of ['vault_bound', 'shared'] as const) {
    const table = family === 'shared' ? 'SharedDebtAllocatorDeployment' : 'DebtAllocatorDeployment'
    let afterId = ''
    while (true) {
      const data = await envioGraphqlRequest<{ items: Record<string, unknown>[] }>(
        `query KongAllocatorDeployments($chainId: Int! $toBlock: Int! $addresses: [String!]! $afterId: String! $pageSize: Int!) {
          items: ${table}(where: { chainId: {_eq: $chainId}, allocatorAddress: {_in: $addresses},
            createdBlock: {_lte: $toBlock}, id: {_gt: $afterId} } order_by: {id: asc} limit: $pageSize) {
            id allocatorAddress factoryAddress abiVariant createdBlock createdEventId
            ${family === 'shared' ? 'governanceAddress' : 'vaultAddress'}
          }
        }`,
        {
          chainId: input.chainId,
          toBlock: input.toBlock,
          addresses: input.allocatorAddresses,
          afterId,
          pageSize: EVENT_PAGE_SIZE
        }
      )
      if (!Array.isArray(data.items)) throw new Error(`Envio response omitted ${table}`)
      for (const row of data.items) {
        const allocatorAddress = address(row.allocatorAddress)
        const factoryAddress = address(row.factoryAddress)
        if (!allocatorAddress || !factoryAddress || typeof row.createdEventId !== 'string')
          throw new Error('Invalid allocator deployment evidence')
        deployments.push({
          allocatorAddress,
          factoryAddress,
          family,
          boundVaultAddress: address(row.vaultAddress),
          governanceAddress: address(row.governanceAddress),
          createdBlock: safeInteger(row.createdBlock, 'creation block'),
          sourceEventId: row.createdEventId,
          abiVariant: String(row.abiVariant)
        })
      }
      if (deployments.length > input.maxEvents) throw new AllocationReplayLimitError(input.maxEvents)
      if (data.items.length < EVENT_PAGE_SIZE) break
      const next = data.items.at(-1)?.id
      if (typeof next !== 'string' || next <= afterId) throw new Error('Envio deployment pagination did not advance')
      afterId = next
    }
  }
  return deployments
}

export interface EnvioEventBatch {
  events: AllocationSourceEvent[]
  deployments: AllocatorDeploymentEvidence[]
  unresolvedEventIds: string[]
  truncatedEventFamilies: string[]
  normalizedSupplementAvailable: boolean
}

export async function fetchCompleteKongAllocationEvents(input: {
  chainId: number
  vaultAddress: Address
  fromBlock: number
  toBlock: number
  maxEvents: number
}): Promise<EnvioEventBatch> {
  let normalizedSupplementAvailable = true
  let normalizedEvents: AllocationSourceEvent[] = []
  let deployments: AllocatorDeploymentEvidence[] = []
  let unresolvedEventIds: string[] = []
  try {
    // Assignment and policy history must start before the requested accounting range.
    const vaultRows = await fetchEvidenceRows({
      ...input,
      table: 'AllocationSourceEvent',
      fields: `${normalizedFields} vaultAddress scope associationEvidence`,
      filter: 'vaultAddress: {_eq: $vaultAddress} scope: {_eq: "vault"} eventName: {_in: $eventNames}',
      variableDefinitions: '$vaultAddress: String! $eventNames: [String!]!',
      variables: { vaultAddress: input.vaultAddress.toLowerCase(), eventNames: NORMALIZED_SUPPLEMENT_EVENT_NAMES }
    })
    normalizedEvents = vaultRows.map(normalizedSourceEvent)
    const allocatorAddresses = [
      ...new Set(
        normalizedEvents
          .filter((event) => ['AddedNewVault', 'UpdateDebtAllocator'].includes(event.eventName))
          .map((event) => address(event.args.debtAllocator))
          .filter((value): value is Address => value !== null && !/^0x0{40}$/.test(value))
      )
    ]
    deployments = await fetchDeployments({ ...input, allocatorAddresses })
    if (allocatorAddresses.length) {
      const sharedRows = await fetchEvidenceRows({
        ...input,
        table: 'AllocationSourceEvent',
        fields: `${normalizedFields} vaultAddress scope associationEvidence`,
        filter: 'sourceAddress: {_in: $addresses} scope: {_eq: "allocator"}',
        variableDefinitions: '$addresses: [String!]!',
        variables: { addresses: allocatorAddresses }
      })
      normalizedEvents.push(...sharedRows.map(normalizedSourceEvent))
      const unresolved = await fetchEvidenceRows({
        ...input,
        table: 'UnresolvedAllocationSourceEvent',
        fields: 'id blockNumber transactionIndex logIndex',
        filter: 'sourceAddress: {_in: $addresses} resolved: {_eq: false}',
        variableDefinitions: '$addresses: [String!]!',
        variables: { addresses: allocatorAddresses }
      })
      unresolvedEventIds = unresolved.map((row) => String(row.id))
    }
  } catch (error) {
    if (error instanceof AllocationReplayLimitError) throw error
    normalizedSupplementAvailable = false
  }
  const vaultRows = await Promise.all(
    VAULT_EVENTS.map(async (definition) => ({
      definition,
      rows: await fetchDefinitionRows({
        definition,
        ...input,
        where: 'chainId: { _eq: $chainId } vaultAddress: { _eq: $vaultAddress }',
        variables: { vaultAddress: input.vaultAddress },
        variableDefinitions: '$vaultAddress: String!'
      })
    }))
  )
  const eventsById = new Map(
    vaultRows
      .flatMap(({ definition, rows }) => rows.map((row) => sourceEvent(definition, row)))
      .map((event) => [event.id, event])
  )
  for (const event of normalizedEvents) eventsById.set(event.id, event)
  if (eventsById.size > input.maxEvents) throw new AllocationReplayLimitError(input.maxEvents)
  const events = [...eventsById.values()].sort(
    (left, right) =>
      left.blockNumber - right.blockNumber ||
      left.transactionIndex - right.transactionIndex ||
      left.logIndex - right.logIndex ||
      left.id.localeCompare(right.id)
  )
  return { events, deployments, unresolvedEventIds, truncatedEventFamilies: [], normalizedSupplementAvailable }
}
