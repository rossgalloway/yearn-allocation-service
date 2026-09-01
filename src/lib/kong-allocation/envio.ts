import { envioGraphqlRequest } from '@/lib/envio/client'
import type { Address, AllocationSourceEvent, Hash } from './types'

const EVENT_PAGE_SIZE = 1000
const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/
const HASH_PATTERN = /^0x[a-fA-F0-9]{64}$/

interface EventDefinition {
  table: string
  eventName: string
  signature: Hash
  fields: string
  sourceLabel: AllocationSourceEvent['sourceLabel']
  sourceAddressField: string
  strategyField?: string
  contextOnly?: boolean
  args: (row: Record<string, unknown>) => Record<string, unknown>
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

function queryAddress(value: unknown): string | null {
  return typeof value === 'string' && ADDRESS_PATTERN.test(value) ? value : null
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
    contextOnly: true,
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
    contextOnly: true,
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

const CONTEXT_ONLY_EVENT_NAMES = new Set(
  VAULT_EVENTS.filter((definition) => definition.contextOnly === true).map((definition) => definition.eventName)
)

export function isAllocationTransitionEvent(event: AllocationSourceEvent): boolean {
  return !CONTEXT_ONLY_EVENT_NAMES.has(event.eventName)
}

const FACTORY_EVENT: EventDefinition = {
  table: 'NewDebtAllocator',
  eventName: 'NewDebtAllocator',
  signature: '0xb87aa110ff22ca00092bbab091c1b6464f413dcfe6391c7fcfc0454f8e1989cb',
  fields: 'vault allocator factoryAddress',
  sourceLabel: 'debtManagerFactory',
  sourceAddressField: 'factoryAddress',
  args: (row) => ({ allocator: address(row.allocator), vault: address(row.vault) })
}

const ALLOCATOR_EVENTS: EventDefinition[] = [
  {
    table: 'UpdateStrategyDebtRatios',
    eventName: 'UpdateStrategyDebtRatios',
    signature: '0x7f2bbad10e91f21c5aaf78550279b42e2863496b6c7e73b661ec891b730c33fb',
    fields: 'allocatorAddress strategy newTargetRatio newMaxRatio newTotalDebtRatio',
    sourceLabel: 'debtAllocator',
    sourceAddressField: 'allocatorAddress',
    strategyField: 'strategy',
    args: (row) => ({
      strategy: address(row.strategy),
      newTargetRatio: decimal(row.newTargetRatio),
      newMaxRatio: decimal(row.newMaxRatio),
      newTotalDebtRatio: decimal(row.newTotalDebtRatio)
    })
  },
  {
    table: 'UpdateKeeper',
    eventName: 'UpdateKeeper',
    signature: '0x465c356447ab4144076254f033e216e3ba04a16610457682ed579a7fdaebd776',
    fields: 'allocatorAddress keeper allowed',
    sourceLabel: 'debtAllocator',
    sourceAddressField: 'allocatorAddress',
    args: (row) => ({ keeper: address(row.keeper), allowed: row.allowed === true })
  },
  {
    table: 'GovernanceTransferred',
    eventName: 'GovernanceTransferred',
    signature: '0x5f56bee8cffbe9a78652a74a60705edede02af10b0bbb888ca44b79a0d42ce80',
    fields: 'allocatorAddress previousGovernance newGovernance',
    sourceLabel: 'debtAllocator',
    sourceAddressField: 'allocatorAddress',
    args: (row) => ({
      previousGovernance: address(row.previousGovernance),
      newGovernance: address(row.newGovernance)
    })
  }
]

function eventSelection(alias: string, definition: EventDefinition, where: string): string {
  return `${alias}: ${definition.table}(
    where: { ${where} blockNumber: { _lte: $toBlock } }
    order_by: [{ blockNumber: desc }, { transactionIndex: desc }, { logIndex: desc }, { id: desc }]
    limit: $pageSize
  ) { ${commonFields} ${definition.fields} }`
}

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

function rows(data: Record<string, unknown>, alias: string): Record<string, unknown>[] {
  const value = data[alias]
  if (!Array.isArray(value)) throw new Error(`Envio response omitted ${alias}`)
  return value as Record<string, unknown>[]
}

export interface EnvioEventBatch {
  events: AllocationSourceEvent[]
  truncatedEventFamilies: string[]
}

export async function fetchKongAllocationEvents(input: {
  chainId: number
  vaultAddress: Address
  toBlock: number
}): Promise<EnvioEventBatch> {
  const vaultSelections = VAULT_EVENTS.map((definition, index) =>
    eventSelection(`v${index}`, definition, 'chainId: { _eq: $chainId } vaultAddress: { _eq: $vaultAddress }')
  )
  vaultSelections.push(
    eventSelection('factory', FACTORY_EVENT, 'chainId: { _eq: $chainId } vault: { _eq: $vaultAddress }')
  )
  const vaultData = await envioGraphqlRequest<Record<string, unknown>>(
    `query KongAllocationVaultEvents($chainId: Int!, $vaultAddress: String!, $toBlock: Int!, $pageSize: Int!) {
      ${vaultSelections.join('\n')}
    }`,
    { chainId: input.chainId, vaultAddress: input.vaultAddress, toBlock: input.toBlock, pageSize: EVENT_PAGE_SIZE }
  )

  const events = VAULT_EVENTS.flatMap((definition, index) =>
    rows(vaultData, `v${index}`).map((row) => sourceEvent(definition, row))
  )
  const factoryRows = rows(vaultData, 'factory')
  events.push(...factoryRows.map((row) => sourceEvent(FACTORY_EVENT, row)))

  const allocatorAddresses = [
    ...new Set(factoryRows.map((row) => queryAddress(row.allocator)).filter((item): item is string => item !== null))
  ]
  const truncatedEventFamilies = VAULT_EVENTS.filter(
    (_, index) => rows(vaultData, `v${index}`).length === EVENT_PAGE_SIZE
  ).map((definition) => definition.eventName)

  if (allocatorAddresses.length > 0) {
    const allocatorSelections = ALLOCATOR_EVENTS.map((definition, index) =>
      eventSelection(
        `a${index}`,
        definition,
        'chainId: { _eq: $chainId } allocatorAddress: { _in: $allocatorAddresses }'
      )
    )
    const allocatorData = await envioGraphqlRequest<Record<string, unknown>>(
      `query KongAllocationAllocatorEvents(
        $chainId: Int!
        $allocatorAddresses: [String!]!
        $toBlock: Int!
        $pageSize: Int!
      ) { ${allocatorSelections.join('\n')} }`,
      { chainId: input.chainId, allocatorAddresses, toBlock: input.toBlock, pageSize: EVENT_PAGE_SIZE }
    )
    for (const [index, definition] of ALLOCATOR_EVENTS.entries()) {
      const eventRows = rows(allocatorData, `a${index}`)
      events.push(...eventRows.map((row) => sourceEvent(definition, row)))
      if (eventRows.length === EVENT_PAGE_SIZE) truncatedEventFamilies.push(definition.eventName)
    }
  }

  events.sort(
    (left, right) =>
      left.blockNumber - right.blockNumber ||
      left.transactionIndex - right.transactionIndex ||
      left.logIndex - right.logIndex ||
      left.id.localeCompare(right.id)
  )
  return { events, truncatedEventFamilies }
}
