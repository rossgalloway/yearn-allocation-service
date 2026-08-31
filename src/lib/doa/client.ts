import { calculateDoaAllocationCoverage } from './coverage'
import { parseDoaOptimizations } from './schema'
import type { DoaOptimization, DoaOptimizationRecord, DoaOptimizationSource } from './types'

const OPTIMIZATION_KEY_PREFIX = 'doa:optimizations'
const OPTIMIZATION_KEY_PATTERN = /^doa:optimizations:(\d+):(.+)$/
const SCAN_PAGE_SIZE = 500
const GET_PIPELINE_SIZE = 100
const REQUEST_TIMEOUT_MS = 15_000
const CACHE_TTL_MS = 60_000
const DEFAULT_MAX_KEYS = 2_000
const MIN_UNIX_SECONDS = 946_684_800
const MAX_UNIX_SECONDS = 4_102_444_800

interface DoaConfiguration {
  url: string
  token: string
}

interface OptimizationKey {
  key: string
  chainId: number
  revision: string
  revisionUnixSeconds: number | null
  timestampUtc: string | null
  isLatestAlias: boolean
}

interface RawOptimizationPayload {
  key: OptimizationKey
  value: unknown
  comparableValue: string
}

interface UpstashResult<T> {
  result?: T
  error?: string
}

interface CachedOptimizations {
  expiresAt: number
  value: Promise<DoaOptimizationRecord[]>
}

const optimizationCache = new Map<number, CachedOptimizations>()

export class DoaConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DoaConfigurationError'
  }
}

export class DoaUpstreamError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DoaUpstreamError'
  }
}

function configuration(): DoaConfiguration {
  const url = process.env.UPSTASH_REDIS_REST_URL?.trim()
  const token = process.env.UPSTASH_REDIS_REST_TOKEN?.trim()
  if (!url || !token) {
    throw new DoaConfigurationError('UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN must both be configured')
  }
  return { url: url.replace(/\/+$/, ''), token }
}

function maxKeys(): number {
  const parsed = Number.parseInt(process.env.DOA_MAX_REDIS_KEYS ?? '', 10)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_KEYS
}

async function postUpstash(path: string, body: unknown): Promise<unknown> {
  const config = configuration()
  let response: Response
  try {
    response = await fetch(`${config.url}${path}`, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'yearn-allocation-service'
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: 'no-store'
    })
  } catch (error) {
    throw new DoaUpstreamError('Unable to reach the DOA optimization store', { cause: error })
  }

  if (!response.ok) {
    const category = response.status === 401 || response.status === 403 ? 'authentication failed' : 'request failed'
    throw new DoaUpstreamError(`DOA optimization store ${category} with HTTP ${response.status}`)
  }

  try {
    return await response.json()
  } catch (error) {
    throw new DoaUpstreamError('DOA optimization store returned invalid JSON', { cause: error })
  }
}

async function command<T>(parts: Array<string | number>): Promise<T> {
  const payload = (await postUpstash('', parts)) as UpstashResult<T>
  if (payload.error) throw new DoaUpstreamError(`DOA optimization store command failed: ${payload.error}`)
  if (!Object.hasOwn(payload, 'result'))
    throw new DoaUpstreamError('DOA optimization store response omitted its result')
  return payload.result as T
}

async function pipeline(commands: Array<Array<string | number>>): Promise<unknown[]> {
  const payload = await postUpstash('/pipeline', commands)
  if (!Array.isArray(payload) || payload.length !== commands.length) {
    throw new DoaUpstreamError('DOA optimization store returned an invalid pipeline response')
  }
  return payload.map((item, index) => {
    const result = item as UpstashResult<unknown>
    if (result.error) {
      throw new DoaUpstreamError(`DOA optimization store pipeline command ${index} failed: ${result.error}`)
    }
    if (!Object.hasOwn(result, 'result')) {
      throw new DoaUpstreamError(`DOA optimization store pipeline command ${index} omitted its result`)
    }
    return result.result
  })
}

function parseKey(key: string, expectedChainId: number): OptimizationKey {
  const match = key.match(OPTIMIZATION_KEY_PATTERN)
  if (!match) throw new DoaUpstreamError(`DOA optimization store returned an invalid key: ${key}`)
  const chainId = Number.parseInt(match[1], 10)
  if (chainId !== expectedChainId) {
    throw new DoaUpstreamError(`DOA optimization store returned a key for unexpected chain ${chainId}`)
  }
  const revision = match[2]
  const isLatestAlias = revision === 'latest'
  const parsedRevision = Number.parseInt(revision, 10)
  const revisionUnixSeconds =
    !isLatestAlias && /^\d+$/.test(revision) && parsedRevision >= MIN_UNIX_SECONDS && parsedRevision <= MAX_UNIX_SECONDS
      ? parsedRevision
      : null
  return {
    key,
    chainId,
    revision,
    revisionUnixSeconds,
    timestampUtc: revisionUnixSeconds === null ? null : new Date(revisionUnixSeconds * 1000).toISOString(),
    isLatestAlias
  }
}

async function readKeys(chainId: number): Promise<OptimizationKey[]> {
  const keys: string[] = []
  let cursor = '0'
  do {
    const result = await command<unknown>([
      'SCAN',
      cursor,
      'MATCH',
      `${OPTIMIZATION_KEY_PREFIX}:${chainId}:*`,
      'COUNT',
      SCAN_PAGE_SIZE
    ])
    if (!Array.isArray(result) || result.length !== 2 || !Array.isArray(result[1])) {
      throw new DoaUpstreamError('DOA optimization store returned an invalid SCAN response')
    }
    cursor = String(result[0])
    for (const key of result[1]) {
      if (typeof key !== 'string') throw new DoaUpstreamError('DOA optimization SCAN returned a non-string key')
      keys.push(key)
    }
    if (keys.length > maxKeys()) {
      throw new DoaUpstreamError(`DOA optimization history exceeds the configured limit of ${maxKeys()} Redis keys`)
    }
  } while (cursor !== '0')

  return [...new Set(keys)].map((key) => parseKey(key, chainId))
}

async function readPayloads(keys: readonly OptimizationKey[]): Promise<RawOptimizationPayload[]> {
  const payloads: RawOptimizationPayload[] = []
  for (let start = 0; start < keys.length; start += GET_PIPELINE_SIZE) {
    const page = keys.slice(start, start + GET_PIPELINE_SIZE)
    const values = await pipeline(page.map(({ key }) => ['GET', key]))
    values.forEach((value, index) => {
      if (value === null || value === undefined) return
      const key = page[index]
      payloads.push({
        key,
        value,
        comparableValue: typeof value === 'string' ? value : JSON.stringify(value)
      })
    })
  }
  return payloads
}

function latestAliasTimestamp(
  payload: RawOptimizationPayload,
  payloads: readonly RawOptimizationPayload[]
): string | null {
  if (!payload.key.isLatestAlias) return null
  const timestamps = payloads
    .filter(
      (candidate) => candidate.key.revisionUnixSeconds !== null && candidate.comparableValue === payload.comparableValue
    )
    .map((candidate) => candidate.key.revisionUnixSeconds as number)
  const latest = timestamps.length === 0 ? null : Math.max(...timestamps)
  return latest === null ? null : new Date(latest * 1000).toISOString()
}

function parsePayloadValue(payload: RawOptimizationPayload): unknown {
  if (typeof payload.value !== 'string') return payload.value
  try {
    return JSON.parse(payload.value)
  } catch (error) {
    throw new DoaUpstreamError(`DOA optimization payload ${payload.key.key} is not valid JSON`, { cause: error })
  }
}

function sourceFor(
  payload: RawOptimizationPayload,
  payloads: readonly RawOptimizationPayload[]
): DoaOptimizationSource {
  return {
    key: payload.key.key,
    chainId: payload.key.chainId,
    revision: payload.key.revision,
    isLatestAlias: payload.key.isLatestAlias,
    timestampUtc: payload.key.timestampUtc,
    latestMatchedTimestampUtc: latestAliasTimestamp(payload, payloads)
  }
}

function optimizationTimestamp(source: DoaOptimizationSource): string | null {
  return source.isLatestAlias ? source.latestMatchedTimestampUtc : source.timestampUtc
}

function vaultKey(optimization: DoaOptimization & { source: DoaOptimizationSource }): string {
  return `${optimization.source.chainId}:${optimization.vault.toLowerCase()}`
}

function attachMetadata(
  optimizations: readonly (DoaOptimization & { source: DoaOptimizationSource })[]
): DoaOptimizationRecord[] {
  const latestByVault = new Map<string, string>()
  for (const optimization of optimizations) {
    const timestamp = optimizationTimestamp(optimization.source)
    const key = vaultKey(optimization)
    const current = latestByVault.get(key)
    if (timestamp !== null && (current === undefined || timestamp > current)) latestByVault.set(key, timestamp)
  }
  return optimizations.map((optimization) => ({
    ...optimization,
    allocationCoverage: calculateDoaAllocationCoverage(optimization.strategyDebtRatios),
    freshness: {
      optimizationTimestampUtc: optimizationTimestamp(optimization.source),
      latestAvailableTimestampUtc: latestByVault.get(vaultKey(optimization)) ?? null
    }
  }))
}

async function fetchOptimizations(chainId: number): Promise<DoaOptimizationRecord[]> {
  const keys = await readKeys(chainId)
  if (keys.length === 0) return []
  const payloads = await readPayloads(keys)
  try {
    const optimizations = payloads.flatMap((payload) => {
      const source = sourceFor(payload, payloads)
      return parseDoaOptimizations(parsePayloadValue(payload), `Redis payload ${payload.key.key}`).map(
        (optimization) => ({ ...optimization, source })
      )
    })
    return attachMetadata(optimizations)
  } catch (error) {
    if (error instanceof DoaUpstreamError) throw error
    throw new DoaUpstreamError(error instanceof Error ? error.message : 'Invalid DOA optimization payload', {
      cause: error
    })
  }
}

export async function readDoaOptimizations(chainId: number): Promise<DoaOptimizationRecord[]> {
  const cached = optimizationCache.get(chainId)
  if (cached && cached.expiresAt > Date.now()) return cached.value

  const value = fetchOptimizations(chainId)
  optimizationCache.set(chainId, { value, expiresAt: Date.now() + CACHE_TTL_MS })
  try {
    return await value
  } catch (error) {
    optimizationCache.delete(chainId)
    throw error
  }
}

export function clearDoaOptimizationCache(): void {
  optimizationCache.clear()
}
