import {
  decodeMulticall,
  encodeMulticall,
  MULTICALL3_ADDRESS,
  MULTICALL3_CHAINS,
  MULTICALL3_PAGE_SIZE
} from './multicall'
import type {
  Address,
  AllocatorFamily,
  AllocatorTriggerReplay,
  Hash,
  RpcTransactionContext,
  VaultAllocationVault
} from './types'

const REQUEST_TIMEOUT_MS = 30_000
const RPC_BATCH_SIZE = 100
const DEFAULT_SAFE_BLOCK_LAG = 12

const SELECTOR = {
  name: '0x06fdde03',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  asset: '0x38d52e0f',
  totalAssets: '0x01e1d114',
  totalDebt: '0xfc7b9c18',
  totalIdle: '0x9aa7df94',
  strategies: '0x39ebf823',
  roleManager: '0x79b98917',
  strategyConfig: '0x0dedca24',
  vaultBoundConfig: '0xe48a5f7b',
  shouldUpdateDebt: '0x4ad0f1d0',
  vaultBoundShouldUpdateDebt: '0x05e4ae83'
} as const

interface RpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params: unknown[]
}

interface RpcResponse {
  id: number
  result?: unknown
  error?: { code?: number; message?: string }
}

export interface ContractCall {
  key: string
  address: Address
  data: Hash
  blockNumber: number
}

export class ArchiveRpcConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveRpcConfigurationError'
  }
}

export class ArchiveRpcUpstreamError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ArchiveRpcUpstreamError'
  }
}

function rpcUrl(chainId: number): string {
  const value = process.env[`RPC_URL_${chainId}`]?.trim()
  if (!value) throw new ArchiveRpcConfigurationError(`RPC_URL_${chainId} is not configured`)
  return value
}

async function rpcHttpFailure(response: Response): Promise<string> {
  let message = ''
  try {
    const payload = (await response.json()) as
      | { error?: { message?: unknown } }
      | Array<{ error?: { message?: unknown } }>
    const item = Array.isArray(payload) ? payload[0] : payload
    message = typeof item?.error?.message === 'string' ? item.error.message.toLowerCase() : ''
  } catch {
    // The status code remains useful when a provider returns HTML or an empty body.
  }

  if (message.includes('balance exceeded')) return ': provider balance exceeded'
  if (message.includes('rate limit') || message.includes('quota')) return ': provider rate limit or quota exceeded'
  if (message.includes('unauthorized') || message.includes('forbidden') || message.includes('invalid key')) {
    return ': provider authentication rejected'
  }
  return ''
}

async function rpcBatch(chainId: number, requests: RpcRequest[]): Promise<Map<number, RpcResponse>> {
  let response: Response
  try {
    response = await fetch(rpcUrl(chainId), {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(requests),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store'
    })
  } catch (error) {
    throw new ArchiveRpcUpstreamError(`Unable to reach the archive RPC for chain ${chainId}`, { cause: error })
  }
  if (!response.ok) {
    const failure = await rpcHttpFailure(response)
    throw new ArchiveRpcUpstreamError(`Archive RPC returned HTTP ${response.status}${failure}`)
  }

  const payload = (await response.json()) as unknown
  if (!Array.isArray(payload)) throw new ArchiveRpcUpstreamError('Archive RPC returned an invalid batch response')
  return new Map((payload as RpcResponse[]).map((item) => [item.id, item]))
}

async function batchedRequests(
  chainId: number,
  requests: Omit<RpcRequest, 'jsonrpc' | 'id'>[]
): Promise<RpcResponse[]> {
  const responses: RpcResponse[] = []
  for (let start = 0; start < requests.length; start += RPC_BATCH_SIZE) {
    const page = requests.slice(start, start + RPC_BATCH_SIZE)
    const encoded = page.map(
      (request, index): RpcRequest => ({
        jsonrpc: '2.0',
        id: start + index + 1,
        ...request
      })
    )
    const result = await rpcBatch(chainId, encoded)
    for (const request of encoded) {
      responses.push(result.get(request.id) ?? { id: request.id, error: { message: 'Missing RPC batch item' } })
    }
  }
  return responses
}

function blockTag(blockNumber: number): Hash {
  return `0x${blockNumber.toString(16)}`
}

function hexData(value: unknown): Hash | null {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value) ? (value.toLowerCase() as Hash) : null
}

function word(data: Hash, index: number): string | null {
  const body = data.slice(2)
  const start = index * 64
  return body.length >= start + 64 ? body.slice(start, start + 64) : null
}

export function decodeUint(data: Hash | null, index = 0): bigint | null {
  if (!data) return null
  const value = word(data, index)
  return value ? BigInt(`0x${value}`) : null
}

export function decodeAddress(data: Hash | null, index = 0): Address | null {
  if (!data) return null
  const value = word(data, index)
  if (!value) return null
  const candidate = `0x${value.slice(24)}`
  return /^0x[a-fA-F0-9]{40}$/.test(candidate) ? (candidate.toLowerCase() as Address) : null
}

export function decodeString(data: Hash | null): string | null {
  if (!data) return null
  const body = data.slice(2)
  if (body.length < 64) return null
  const offset = Number(BigInt(`0x${body.slice(0, 64)}`)) * 2
  if (Number.isSafeInteger(offset) && offset >= 0 && body.length >= offset + 64) {
    const length = Number(BigInt(`0x${body.slice(offset, offset + 64)}`))
    const valueStart = offset + 64
    if (Number.isSafeInteger(length) && body.length >= valueStart + length * 2) {
      try {
        return new TextDecoder().decode(
          Uint8Array.from(Buffer.from(body.slice(valueStart, valueStart + length * 2), 'hex'))
        )
      } catch {
        return null
      }
    }
  }

  try {
    const bytes = Buffer.from(body.slice(0, 64), 'hex')
    return new TextDecoder().decode(Uint8Array.from(bytes)).replace(/\0+$/, '') || null
  } catch {
    return null
  }
}

export function encodeAddressCall(selector: Hash, value: Address): Hash {
  return `${selector}${value.slice(2).toLowerCase().padStart(64, '0')}` as Hash
}

export function encodeAddressPairCall(selector: Hash, first: Address, second: Address): Hash {
  return `${selector}${first.slice(2).toLowerCase().padStart(64, '0')}${second
    .slice(2)
    .toLowerCase()
    .padStart(64, '0')}` as Hash
}

export function allocatorConfigurationCall(family: AllocatorFamily, vault: Address, strategy: Address): Hash | null {
  if (family === 'shared') return encodeAddressPairCall(SELECTOR.strategyConfig, vault, strategy)
  if (family === 'vault_bound') return encodeAddressCall(SELECTOR.vaultBoundConfig, strategy)
  return null
}

export async function readAllocatorCode(
  chainId: number,
  inputs: readonly { address: Address; blockNumber: number }[]
): Promise<Map<string, 'code' | 'no_code' | 'unavailable'>> {
  const unique = [...new Map(inputs.map((input) => [`${input.blockNumber}:${input.address}`, input])).entries()]
  const responses = await batchedRequests(
    chainId,
    unique.map(([, input]) => ({ method: 'eth_getCode', params: [input.address, blockTag(input.blockNumber)] }))
  )
  return new Map(
    unique.map(([key], index) => {
      const code = hexData(responses[index]?.result)
      return [key, code === null ? 'unavailable' : code === '0x' ? 'no_code' : 'code']
    })
  )
}

export async function readContractCalls(
  chainId: number,
  calls: readonly ContractCall[],
  options: { multicall?: boolean } = {}
): Promise<Map<string, Hash | null>> {
  if (calls.length === 0) return new Map()
  // Opt-in only: Multicall changes msg.sender and must not wrap trigger replay.
  const groups = new Map<number, ContractCall[]>()
  for (const call of calls) {
    const group = groups.get(call.blockNumber) ?? []
    group.push(call)
    groups.set(call.blockNumber, group)
  }
  const eligible =
    options.multicall && MULTICALL3_CHAINS.has(chainId)
      ? [...groups.entries()].filter(([, group]) => group.length > 1)
      : []
  const code = await batchedRequests(
    chainId,
    eligible.map(([block]) => ({
      method: 'eth_getCode',
      params: [MULTICALL3_ADDRESS, blockTag(block)]
    }))
  )
  const available = new Set<number>()
  eligible.forEach(([block], index) => {
    const value = hexData(code[index]?.result)
    if (value === null) throw new ArchiveRpcUpstreamError('Unable to verify historical Multicall3 deployment')
    if (value !== '0x') available.add(block)
  })
  const pages: { calls: ContractCall[]; aggregate: boolean }[] = []
  for (const [block, group] of groups) {
    if (!available.has(block)) {
      for (const call of group) pages.push({ calls: [call], aggregate: false })
    } else {
      for (let start = 0; start < group.length; start += MULTICALL3_PAGE_SIZE) {
        const page = group.slice(start, start + MULTICALL3_PAGE_SIZE)
        pages.push({ calls: page, aggregate: page.length > 1 })
      }
    }
  }
  const responses = await batchedRequests(
    chainId,
    pages.map((page) => ({
      method: 'eth_call',
      params: [
        {
          to: page.aggregate ? MULTICALL3_ADDRESS : page.calls[0].address,
          data: page.aggregate ? encodeMulticall(page.calls) : page.calls[0].data
        },
        blockTag(page.calls[0].blockNumber)
      ]
    }))
  )
  const results = new Map<string, Hash | null>()
  pages.forEach((page, index) => {
    const value = hexData(responses[index]?.result)
    if (!page.aggregate) {
      results.set(page.calls[0].key, value)
      return
    }
    // Do not fan an upstream failure out into dozens of paid fallback calls.
    if (value === null) throw new ArchiveRpcUpstreamError('Multicall3 request failed')
    let decoded: (Hash | null)[]
    try {
      decoded = decodeMulticall(value, page.calls.length)
    } catch {
      throw new ArchiveRpcUpstreamError('Invalid Multicall3 response')
    }
    page.calls.forEach((call, i) => {
      results.set(call.key, decoded[i])
    })
  })
  return results
}

export async function readBlockTimestamps(
  chainId: number,
  blockNumbers: readonly number[]
): Promise<Map<number, number>> {
  const unique = [...new Set(blockNumbers)]
  const responses = await batchedRequests(
    chainId,
    unique.map((blockNumber) => ({ method: 'eth_getBlockByNumber', params: [blockTag(blockNumber), false] }))
  )
  return new Map(
    unique.map((blockNumber, index) => {
      const block = responses[index]?.result as { timestamp?: unknown } | null | undefined
      const timestamp = hexData(block?.timestamp)
      if (!timestamp) throw new ArchiveRpcUpstreamError(`Archive RPC did not return block ${blockNumber}`)
      return [blockNumber, Number(BigInt(timestamp))]
    })
  )
}

export async function readLatestSafeBlock(chainId: number): Promise<{ blockNumber: number; blockTimestamp: number }> {
  const [latestResponse] = await batchedRequests(chainId, [{ method: 'eth_blockNumber', params: [] }])
  const latestHex = hexData(latestResponse?.result)
  if (!latestHex) throw new ArchiveRpcUpstreamError('Archive RPC did not return the latest block number')
  const latest = Number(BigInt(latestHex))
  const configuredLag = Number.parseInt(process.env.ALLOCATION_TEST_SAFE_BLOCK_LAG ?? '', 10)
  const lag = Number.isSafeInteger(configuredLag) && configuredLag >= 0 ? configuredLag : DEFAULT_SAFE_BLOCK_LAG
  const blockNumber = Math.max(0, latest - lag)
  const timestamps = await readBlockTimestamps(chainId, [blockNumber])
  return { blockNumber, blockTimestamp: timestamps.get(blockNumber) as number }
}

export async function readTransactionContexts(
  chainId: number,
  transactionHashes: readonly Hash[],
  vaultAddress: Address
): Promise<Map<Hash, RpcTransactionContext>> {
  const unique = [...new Set(transactionHashes)]
  const [responses, traces] = await Promise.all([
    batchedRequests(
      chainId,
      unique.map((transactionHash) => ({ method: 'eth_getTransactionByHash', params: [transactionHash] }))
    ),
    batchedRequests(
      chainId,
      unique.map((transactionHash) => ({ method: 'trace_transaction', params: [transactionHash] }))
    )
  ])
  return new Map(
    unique.map((transactionHash, index) => {
      const value = responses[index]?.result as { from?: unknown; to?: unknown; input?: unknown } | null | undefined
      const from =
        typeof value?.from === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value.from)
          ? (value.from.toLowerCase() as Address)
          : null
      const to =
        typeof value?.to === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value.to)
          ? (value.to.toLowerCase() as Address)
          : null
      const inputSelector =
        typeof value?.input === 'string' && /^0x[a-fA-F0-9]{8,}$/.test(value.input)
          ? (value.input.slice(0, 10).toLowerCase() as Hash)
          : null
      const trace = traceContext(traces[index]?.result, vaultAddress)
      return [transactionHash, { from, to, inputSelector, ...trace }]
    })
  )
}

interface TraceCall {
  from: Address
  to: Address
  traceAddress: number[]
}

function rpcAddress(value: unknown): Address | null {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value) ? (value.toLowerCase() as Address) : null
}

function traceCalls(value: unknown): TraceCall[] | null {
  if (!Array.isArray(value)) return null
  const calls = value.flatMap((item): TraceCall[] => {
    if (!item || typeof item !== 'object') return []
    const trace = item as { action?: unknown; traceAddress?: unknown; type?: unknown }
    if (trace.type !== 'call' || !trace.action || typeof trace.action !== 'object') return []
    const action = trace.action as { from?: unknown; to?: unknown }
    const from = rpcAddress(action.from)
    const to = rpcAddress(action.to)
    if (!from || !to || !Array.isArray(trace.traceAddress) || !trace.traceAddress.every(Number.isSafeInteger)) return []
    return [{ from, to, traceAddress: trace.traceAddress as number[] }]
  })
  return calls
}

function isTracePrefix(candidate: readonly number[], target: readonly number[]): boolean {
  return candidate.length <= target.length && candidate.every((value, index) => value === target[index])
}

function callPath(calls: readonly TraceCall[], target: TraceCall): Address[] {
  const ancestors = calls
    .filter((call) => isTracePrefix(call.traceAddress, target.traceAddress))
    .sort((left, right) => left.traceAddress.length - right.traceAddress.length)
  const path: Address[] = []
  for (const call of ancestors) {
    if (path.at(-1) !== call.from) path.push(call.from)
    if (path.at(-1) !== call.to) path.push(call.to)
  }
  return path
}

function traceContext(
  value: unknown,
  vaultAddress: Address
): Pick<RpcTransactionContext, 'traceStatus' | 'callPath' | 'immediateVaultCaller'> {
  const calls = traceCalls(value)
  if (!calls) return { traceStatus: 'unavailable', callPath: [], immediateVaultCaller: null }
  const vaultCalls = calls
    .filter((call) => call.to === vaultAddress.toLowerCase())
    .sort((left, right) => left.traceAddress.length - right.traceAddress.length)
  if (vaultCalls.length === 0) return { traceStatus: 'available', callPath: [], immediateVaultCaller: null }
  const callers = [...new Set(vaultCalls.map((call) => call.from))]
  return {
    traceStatus: 'available',
    callPath: callPath(calls, vaultCalls[0]),
    immediateVaultCaller: callers.length === 1 ? callers[0] : null
  }
}

function dynamicBytes(data: Hash | null, offsetWord: number): Hash | null {
  const offset = decodeUint(data, offsetWord)
  if (!data || offset === null || offset > BigInt(Number.MAX_SAFE_INTEGER)) return null
  const body = data.slice(2)
  const lengthWordStart = Number(offset) * 2
  if (body.length < lengthWordStart + 64) return null
  const length = BigInt(`0x${body.slice(lengthWordStart, lengthWordStart + 64)}`)
  if (length > BigInt(Number.MAX_SAFE_INTEGER)) return null
  const valueStart = lengthWordStart + 64
  const valueEnd = valueStart + Number(length) * 2
  return body.length >= valueEnd ? (`0x${body.slice(valueStart, valueEnd)}` as Hash) : null
}

export function triggerTarget(
  calldata: Hash | null,
  input: Pick<AllocatorTriggerReplayInput, 'family' | 'vaultAddress' | 'strategyAddress'>
): bigint | null {
  if (!calldata || input.family === 'unknown') return null
  const shared = input.family === 'shared'
  const selector = shared ? '0xda5f3286' : '0x0aeebf55'
  const prefix = shared
    ? encodeAddressPairCall(selector, input.vaultAddress, input.strategyAddress)
    : encodeAddressCall(selector, input.strategyAddress)
  if (!calldata.toLowerCase().startsWith(prefix) || calldata.length !== prefix.length + 64) return null
  return BigInt(`0x${calldata.slice(prefix.length)}`)
}

function bytesText(value: Hash | null): string | null {
  if (!value) return null
  try {
    return new TextDecoder().decode(Uint8Array.from(Buffer.from(value.slice(2), 'hex'))) || null
  } catch {
    return null
  }
}

export interface AllocatorTriggerReplayInput {
  family: AllocatorFamily
  transactionHash: Hash
  allocatorAddress: Address
  vaultAddress: Address
  strategyAddress: Address
  blockNumber: number
  expectedDebt: string
  matchTolerance: string
}

export async function readAllocatorTriggerReplays(
  chainId: number,
  inputs: readonly AllocatorTriggerReplayInput[]
): Promise<Map<Hash, AllocatorTriggerReplay[]>> {
  const calls = inputs.flatMap((input, index): ContractCall[] =>
    input.family === 'unknown'
      ? []
      : [
          {
            key: String(index),
            address: input.allocatorAddress,
            data:
              input.family === 'shared'
                ? encodeAddressPairCall(contractSelectors.shouldUpdateDebt, input.vaultAddress, input.strategyAddress)
                : encodeAddressCall(contractSelectors.vaultBoundShouldUpdateDebt, input.strategyAddress),
            blockNumber: Math.max(0, input.blockNumber - 1)
          }
        ]
  )
  const results = await readContractCalls(chainId, calls)
  const byTransaction = new Map<Hash, AllocatorTriggerReplay[]>()
  for (const [index, input] of inputs.entries()) {
    const result = results.get(String(index)) ?? null
    const shouldUpdateWord = decodeUint(result)
    const shouldUpdate = shouldUpdateWord === null ? null : shouldUpdateWord !== 0n
    const payload = dynamicBytes(result, 1)
    const recommended = shouldUpdate === true ? triggerTarget(payload, input) : null
    const expected = /^\d+$/.test(input.expectedDebt) ? BigInt(input.expectedDebt) : null
    const tolerance = /^\d+$/.test(input.matchTolerance) ? BigInt(input.matchTolerance) : 0n
    const difference =
      recommended !== null && expected !== null
        ? recommended >= expected
          ? recommended - expected
          : expected - recommended
        : null
    const status =
      shouldUpdate === null || (shouldUpdate && recommended === null)
        ? 'unavailable'
        : shouldUpdate && difference !== null && difference <= tolerance
          ? 'matched'
          : 'not_matched'
    const replay: AllocatorTriggerReplay = {
      strategyAddress: input.strategyAddress,
      allocatorAddress: input.allocatorAddress,
      readAtBlock: Math.max(0, input.blockNumber - 1),
      status,
      shouldUpdate,
      expectedDebt: input.expectedDebt,
      recommendedDebt: recommended?.toString() ?? null,
      absoluteDifference: difference?.toString() ?? null,
      matchTolerance: input.matchTolerance,
      reason:
        input.family === 'unknown'
          ? 'allocator_interface_unsupported'
          : shouldUpdate === null
            ? 'allocator_replay_unavailable'
            : shouldUpdate && recommended === null
              ? 'allocator_replay_payload_unavailable'
              : shouldUpdate === false
                ? bytesText(payload)
                : null
    }
    const current = byTransaction.get(input.transactionHash) ?? []
    current.push(replay)
    byTransaction.set(input.transactionHash, current)
  }
  return byTransaction
}

export async function readVaultMetadata(
  chainId: number,
  vaultAddress: Address,
  blockNumber: number
): Promise<VaultAllocationVault> {
  const vaultResults = await readContractCalls(
    chainId,
    [
      { key: 'name', address: vaultAddress, data: SELECTOR.name, blockNumber },
      { key: 'symbol', address: vaultAddress, data: SELECTOR.symbol, blockNumber },
      { key: 'asset', address: vaultAddress, data: SELECTOR.asset, blockNumber }
    ],
    { multicall: true }
  )
  const assetAddress = decodeAddress(vaultResults.get('asset') ?? null)
  let assetSymbol: string | null = null
  let assetDecimals: number | null = null
  if (assetAddress) {
    const assetResults = await readContractCalls(
      chainId,
      [
        { key: 'symbol', address: assetAddress, data: SELECTOR.symbol, blockNumber },
        { key: 'decimals', address: assetAddress, data: SELECTOR.decimals, blockNumber }
      ],
      { multicall: true }
    )
    assetSymbol = decodeString(assetResults.get('symbol') ?? null)
    const decimals = decodeUint(assetResults.get('decimals') ?? null)
    assetDecimals = decimals !== null && decimals <= 255n ? Number(decimals) : null
  }
  return {
    chainId,
    address: vaultAddress.toLowerCase() as Address,
    name: decodeString(vaultResults.get('name') ?? null),
    symbol: decodeString(vaultResults.get('symbol') ?? null),
    assetAddress,
    assetSymbol,
    assetDecimals
  }
}

export async function readContractNames(
  chainId: number,
  addresses: readonly Address[],
  blockNumber: number
): Promise<Map<Address, string | null>> {
  const unique = [...new Set(addresses)]
  const results = await readContractCalls(
    chainId,
    unique.map((contractAddress) => ({
      key: contractAddress,
      address: contractAddress,
      data: SELECTOR.name,
      blockNumber
    })),
    { multicall: true }
  )
  return new Map(unique.map((contractAddress) => [contractAddress, decodeString(results.get(contractAddress) ?? null)]))
}

export async function readVaultRoleManagers(
  chainId: number,
  vaultAddress: Address,
  blockNumbers: readonly number[]
): Promise<Map<number, Address | null>> {
  const unique = [...new Set(blockNumbers)]
  const results = await readContractCalls(
    chainId,
    unique.map((blockNumber) => ({
      key: String(blockNumber),
      address: vaultAddress,
      data: SELECTOR.roleManager,
      blockNumber
    }))
  )
  return new Map(unique.map((blockNumber) => [blockNumber, decodeAddress(results.get(String(blockNumber)) ?? null)]))
}

export const contractSelectors = SELECTOR
