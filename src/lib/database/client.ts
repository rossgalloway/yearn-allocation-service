import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg'

const DEFAULT_MAX_CONNECTIONS = 5
const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000
const DEFAULT_IDLE_TIMEOUT_MS = 10_000
const DEFAULT_QUERY_TIMEOUT_MS = 30_000

export class DatabaseConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DatabaseConfigurationError'
  }
}

export class DatabaseUpstreamError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DatabaseUpstreamError'
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === '') return fallback
  const parsed = Number.parseInt(value ?? '', 10)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new DatabaseConfigurationError(`Invalid positive integer database setting: ${value}`)
  }
  return parsed
}

function databaseUrl(): string {
  const value = process.env.DATABASE_URL?.trim()
  if (!value) throw new DatabaseConfigurationError('DATABASE_URL is not configured')
  return value
}

export function databaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim())
}

declare global {
  var __yearnAllocationDatabasePool: Pool | undefined
}

export function databasePool(): Pool {
  if (!globalThis.__yearnAllocationDatabasePool) {
    const pool = new Pool({
      connectionString: databaseUrl(),
      max: positiveInteger(process.env.DATABASE_MAX_CONNECTIONS, DEFAULT_MAX_CONNECTIONS),
      connectionTimeoutMillis: positiveInteger(
        process.env.DATABASE_CONNECTION_TIMEOUT_MS,
        DEFAULT_CONNECTION_TIMEOUT_MS
      ),
      idleTimeoutMillis: positiveInteger(process.env.DATABASE_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS),
      query_timeout: positiveInteger(process.env.DATABASE_QUERY_TIMEOUT_MS, DEFAULT_QUERY_TIMEOUT_MS),
      allowExitOnIdle: true
    })
    pool.on('error', () => {
      console.error('An idle Postgres client encountered an error')
    })
    globalThis.__yearnAllocationDatabasePool = pool
  }
  return globalThis.__yearnAllocationDatabasePool
}

export interface DatabaseQueryable {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[]
  ): Promise<QueryResult<Row>>
}

export async function databaseQuery<Row extends QueryResultRow = QueryResultRow>(
  text: string,
  values: readonly unknown[] = []
): Promise<QueryResult<Row>> {
  try {
    return await databasePool().query<Row>(text, [...values])
  } catch (error) {
    if (error instanceof DatabaseConfigurationError) throw error
    throw new DatabaseUpstreamError('Postgres query failed', { cause: error })
  }
}

export async function withDatabaseTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  let client: PoolClient
  try {
    client = await databasePool().connect()
  } catch (error) {
    if (error instanceof DatabaseConfigurationError) throw error
    throw new DatabaseUpstreamError('Unable to connect to Postgres', { cause: error })
  }
  try {
    await client.query('BEGIN')
    const value = await work(client)
    await client.query('COMMIT')
    return value
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    if (error instanceof DatabaseConfigurationError || error instanceof DatabaseUpstreamError) throw error
    throw new DatabaseUpstreamError('Postgres transaction failed', { cause: error })
  } finally {
    client.release()
  }
}
