import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { databaseQuery } from '@/lib/database/client'

export interface HistoricalRequest {
  method: string
  params: unknown[]
}
export interface HistoricalResponse {
  id: number
  result?: unknown
  error?: { code?: number; message?: string }
}
export type HistoricalTransport = (requests: HistoricalRequest[]) => Promise<HistoricalResponse[]>
export interface FinalizedBlock {
  number: number
  hash: string
  timestamp: number
}
interface CacheRow {
  cache_key: string
  chain_id: number
  block_number: number
  block_hash: string
  namespace: string
  payload: unknown
}
export interface CacheStats {
  rpcHits: number
  rpcMisses: number
  rpcMethods: number
  statesReused: number
  statesBuilt: number
}
const storage = new AsyncLocalStorage<HistoricalCache>()
export const historicalCache = () => storage.getStore()
export function evidenceHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
const hashPattern = /^0x[0-9a-fA-F]{64}$/
function parseBlock(value: unknown): FinalizedBlock {
  const row = value as { number?: string; hash?: string; timestamp?: string } | null
  if (
    !row ||
    !/^0x[0-9a-fA-F]+$/.test(row.number ?? '') ||
    !hashPattern.test(row.hash ?? '') ||
    !/^0x[0-9a-fA-F]+$/.test(row.timestamp ?? '')
  )
    throw new Error('RPC did not return a finalized canonical block')
  const number = Number(BigInt(row.number as string))
  const timestamp = Number(BigInt(row.timestamp as string))
  if (!Number.isSafeInteger(number) || !Number.isSafeInteger(timestamp)) throw new Error('Invalid finalized block')
  return { number, hash: (row.hash as string).toLowerCase(), timestamp }
}

export class HistoricalCache {
  readonly stats: CacheStats = { rpcHits: 0, rpcMisses: 0, rpcMethods: 0, statesReused: 0, statesBuilt: 0 }
  readonly blocks = new Map<number, FinalizedBlock>()
  readonly transactions = new Map<string, FinalizedBlock>()
  constructor(
    readonly chainId: number,
    readonly finalized: FinalizedBlock,
    private readonly transport: HistoricalTransport
  ) {
    this.blocks.set(finalized.number, finalized)
  }
  static async open(chainId: number, transport: HistoricalTransport): Promise<HistoricalCache> {
    const [network, head] = await transport([
      { method: 'eth_chainId', params: [] },
      { method: 'eth_getBlockByNumber', params: ['finalized', false] }
    ])
    if (
      typeof network?.result !== 'string' ||
      !/^0x[0-9a-fA-F]+$/.test(network.result) ||
      Number(BigInt(network.result)) !== chainId
    )
      throw new Error('RPC chain ID mismatch')
    const finalized = parseBlock(head?.result)
    const previous = await databaseQuery<{ block_number: string; block_hash: string }>(
      'SELECT block_number::text, block_hash FROM allocation_finalized_block WHERE chain_id=$1 ORDER BY block_number DESC LIMIT 1',
      [chainId]
    )
    if (previous.rows[0]) {
      const old = previous.rows[0]
      if (Number(old.block_number) > finalized.number)
        throw new Error('Finalized RPC head regressed; refusing historical cache reuse')
      const [proof] = await transport([
        { method: 'eth_getBlockByNumber', params: [`0x${Number(old.block_number).toString(16)}`, false] }
      ])
      if (parseBlock(proof?.result).hash !== old.block_hash)
        throw new Error('Finalized block hash changed; refusing historical cache reuse')
    }
    const cache = new HistoricalCache(chainId, finalized, transport)
    cache.stats.rpcMethods = previous.rows[0] ? 3 : 2
    await cache.saveBlocks([finalized])
    return cache
  }
  private async saveBlocks(blocks: FinalizedBlock[]) {
    if (!blocks.length) return
    await databaseQuery(
      `INSERT INTO allocation_finalized_block(chain_id,block_number,block_hash,block_timestamp)
      SELECT $1,x.number,x.hash,x.timestamp FROM jsonb_to_recordset($2::jsonb) AS x(number bigint,hash text,timestamp bigint)
      ON CONFLICT(chain_id,block_number) DO NOTHING`,
      [this.chainId, JSON.stringify(blocks)]
    )
  }
  async ensureBlocks(numbers: readonly number[]): Promise<void> {
    const needed = [...new Set(numbers)].filter((n) => n <= this.finalized.number && !this.blocks.has(n))
    if (!needed.length) return
    for (let i = 0; i < needed.length; i += 500) {
      const page = needed.slice(i, i + 500)
      const found = await databaseQuery<{ block_number: string; block_hash: string; block_timestamp: string }>(
        'SELECT block_number::text,block_hash,block_timestamp::text FROM allocation_finalized_block WHERE chain_id=$1 AND block_number=ANY($2::bigint[])',
        [this.chainId, page]
      )
      for (const b of found.rows)
        this.blocks.set(Number(b.block_number), {
          number: Number(b.block_number),
          hash: b.block_hash,
          timestamp: Number(b.block_timestamp)
        })
      const missing = page.filter((n) => !this.blocks.has(n))
      if (!missing.length) continue
      const responses = await this.transport(
        missing.map((n) => ({ method: 'eth_getBlockByNumber', params: [`0x${n.toString(16)}`, false] }))
      )
      const blocks = responses.map((r, j) => {
        const b = parseBlock(r.result)
        if (b.number !== missing[j])
          throw new Error(`RPC block identity mismatch: requested ${missing[j]}, received ${b.number}`)
        return b
      })
      await this.saveBlocks(blocks)
      for (const b of blocks) this.blocks.set(b.number, b)
    }
  }
  async registerEvents(events: readonly { blockNumber: number; blockHash?: string | null; transactionHash: string }[]) {
    await this.ensureBlocks(events.map((e) => e.blockNumber))
    for (const e of events) {
      const b = this.blocks.get(e.blockNumber)
      if (!b) continue
      if (!e.blockHash || b.hash !== e.blockHash.toLowerCase())
        throw new Error(`Envio block hash mismatch at ${e.blockNumber}`)
      const key = e.transactionHash.toLowerCase()
      const previous = this.transactions.get(key)
      if (previous && previous.hash !== b.hash) throw new Error('Conflicting transaction block identity')
      this.transactions.set(key, b)
    }
  }
  key(namespace: string, block: FinalizedBlock, input: unknown): string {
    return evidenceHash(['historical-cache-v1', this.chainId, block.hash, namespace, input])
  }
  async get(keys: string[]): Promise<Map<string, unknown>> {
    const result = new Map<string, unknown>()
    for (let i = 0; i < keys.length; i += 500) {
      const r = await databaseQuery<{ cache_key: string; payload: unknown }>(
        'SELECT cache_key,payload FROM allocation_historical_cache WHERE cache_key=ANY($1::text[])',
        [keys.slice(i, i + 500)]
      )
      for (const row of r.rows) result.set(row.cache_key, row.payload)
    }
    return result
  }
  async put(rows: { key: string; block: FinalizedBlock; namespace: string; payload: unknown }[]) {
    for (let i = 0; i < rows.length; i += 100) {
      const page = rows.slice(i, i + 100).map(
        (r) =>
          ({
            cache_key: r.key,
            chain_id: this.chainId,
            block_number: r.block.number,
            block_hash: r.block.hash,
            namespace: r.namespace,
            payload: r.payload
          }) satisfies CacheRow
      )
      await databaseQuery(
        `INSERT INTO allocation_historical_cache(cache_key,chain_id,block_number,block_hash,namespace,payload)
        SELECT cache_key,chain_id,block_number,block_hash,namespace,payload FROM jsonb_to_recordset($1::jsonb)
        AS x(cache_key text,chain_id integer,block_number bigint,block_hash text,namespace text,payload jsonb)
        ON CONFLICT(cache_key) DO NOTHING`,
        [JSON.stringify(page)]
      )
    }
  }
  private blockFor(request: HistoricalRequest): FinalizedBlock | undefined {
    if (['eth_call', 'eth_getCode'].includes(request.method)) {
      const tag = request.params[1]
      return typeof tag === 'string' && /^0x[0-9a-fA-F]+$/.test(tag) ? this.blocks.get(Number(BigInt(tag))) : undefined
    }
    if (['trace_transaction', 'eth_getTransactionByHash'].includes(request.method))
      return this.transactions.get(String(request.params[0]).toLowerCase())
    return undefined
  }
  async execute(requests: HistoricalRequest[], load: HistoricalTransport): Promise<HistoricalResponse[]> {
    const blockNumbers = requests.flatMap((r) =>
      ['eth_call', 'eth_getCode'].includes(r.method) &&
      typeof r.params[1] === 'string' &&
      /^0x[0-9a-fA-F]+$/.test(r.params[1])
        ? [Number(BigInt(r.params[1]))]
        : []
    )
    await this.ensureBlocks(blockNumbers)
    const identities = requests.map((r) => {
      const block = this.blockFor(r)
      return block ? { block, key: this.key('rpc', block, r) } : null
    })
    const stored = await this.get(identities.flatMap((x) => (x ? [x.key] : [])))
    const missing: number[] = []
    const output: HistoricalResponse[] = requests.map((_, i) => {
      const identity = identities[i]
      if (identity && stored.has(identity.key)) {
        this.stats.rpcHits++
        return { id: i + 1, result: stored.get(identity.key) }
      }
      missing.push(i)
      this.stats.rpcMisses++
      return { id: i + 1 }
    })
    const fresh = await load(missing.map((i) => requests[i]))
    const writes: { key: string; block: FinalizedBlock; namespace: string; payload: unknown }[] = []
    for (let j = 0; j < missing.length; j++) {
      const i = missing[j]
      const result = fresh[j] ?? { id: i + 1, error: { message: 'Missing RPC response' } }
      output[i] = { ...result, id: i + 1 }
      const identity = identities[i]
      if (identity && !result.error && cacheableResult(requests[i], result.result, identity.block))
        writes.push({ key: identity.key, block: identity.block, namespace: 'rpc', payload: result.result })
    }
    await this.put(writes)
    return output
  }
}
export function cacheableResult(request: HistoricalRequest, result: unknown, block: FinalizedBlock): boolean {
  if (result === null || result === undefined) return false
  if (['eth_call', 'eth_getCode'].includes(request.method))
    return typeof result === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(result)
  if (request.method === 'eth_getTransactionByHash') {
    const tx = result as {
      hash?: string
      blockHash?: string
      blockNumber?: string
      from?: string
      to?: string | null
      input?: string
    }
    return (
      /^0x[0-9a-fA-F]{40}$/.test(tx.from ?? '') &&
      (tx.to === null || /^0x[0-9a-fA-F]{40}$/.test(tx.to ?? '')) &&
      /^0x(?:[0-9a-fA-F]{2})*$/.test(tx.input ?? '') &&
      tx.hash?.toLowerCase() === String(request.params[0]).toLowerCase() &&
      tx.blockHash?.toLowerCase() === block.hash &&
      Number(tx.blockNumber) === block.number
    )
  }
  if (request.method === 'trace_transaction')
    return (
      Array.isArray(result) &&
      result.length > 0 &&
      result.every(
        (t) =>
          t &&
          typeof t === 'object' &&
          typeof t.action === 'object' &&
          t.action !== null &&
          typeof t.type === 'string' &&
          Array.isArray(t.traceAddress) &&
          t.traceAddress.every((part: unknown) => Number.isSafeInteger(part) && Number(part) >= 0) &&
          t.blockHash?.toLowerCase() === block.hash &&
          t.blockNumber === block.number &&
          t.transactionHash?.toLowerCase() === String(request.params[0]).toLowerCase()
      )
    )
  return false
}
export async function withHistoricalCache<T>(
  chainId: number,
  transport: HistoricalTransport,
  work: () => Promise<T>
): Promise<{ result: T; stats: CacheStats }> {
  const cache = await HistoricalCache.open(chainId, transport)
  return storage.run(cache, async () => ({ result: await work(), stats: cache.stats }))
}
