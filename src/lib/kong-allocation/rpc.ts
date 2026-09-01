import type { Address, Hash, RpcTransactionContext, VaultAllocationVault } from './types'

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
  targetRatio: '0x0b90938b',
  maxRatio: '0x18043a36'
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
  if (!response.ok) throw new ArchiveRpcUpstreamError(`Archive RPC returned HTTP ${response.status}`)

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

export async function readContractCalls(
  chainId: number,
  calls: readonly ContractCall[]
): Promise<Map<string, Hash | null>> {
  if (calls.length === 0) return new Map()
  const responses = await batchedRequests(
    chainId,
    calls.map((call) => ({
      method: 'eth_call',
      params: [{ to: call.address, data: call.data }, blockTag(call.blockNumber)]
    }))
  )
  return new Map(calls.map((call, index) => [call.key, hexData(responses[index]?.result)]))
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
  transactionHashes: readonly Hash[]
): Promise<Map<Hash, RpcTransactionContext>> {
  const unique = [...new Set(transactionHashes)]
  const responses = await batchedRequests(
    chainId,
    unique.map((transactionHash) => ({ method: 'eth_getTransactionByHash', params: [transactionHash] }))
  )
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
      return [transactionHash, { from, to, inputSelector }]
    })
  )
}

export async function readVaultMetadata(
  chainId: number,
  vaultAddress: Address,
  blockNumber: number
): Promise<VaultAllocationVault> {
  const vaultResults = await readContractCalls(chainId, [
    { key: 'name', address: vaultAddress, data: SELECTOR.name, blockNumber },
    { key: 'symbol', address: vaultAddress, data: SELECTOR.symbol, blockNumber },
    { key: 'asset', address: vaultAddress, data: SELECTOR.asset, blockNumber }
  ])
  const assetAddress = decodeAddress(vaultResults.get('asset') ?? null)
  let assetSymbol: string | null = null
  let assetDecimals: number | null = null
  if (assetAddress) {
    const assetResults = await readContractCalls(chainId, [
      { key: 'symbol', address: assetAddress, data: SELECTOR.symbol, blockNumber },
      { key: 'decimals', address: assetAddress, data: SELECTOR.decimals, blockNumber }
    ])
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
    }))
  )
  return new Map(unique.map((contractAddress) => [contractAddress, decodeString(results.get(contractAddress) ?? null)]))
}

export const contractSelectors = SELECTOR
