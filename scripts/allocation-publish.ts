import { readFile } from 'node:fs/promises'
import { Pool, type PoolClient } from 'pg'
import { ALLOCATION_MATERIALIZER_VERSION } from '@/lib/kong-allocation/quality'
import { listTestVaults } from '@/lib/kong-allocation/vaults'

// This publishes the hosted reference schema, not the worker's RPC cache.
const schema = 'allocation_reference'
const batchSize = 100
const apply = process.argv.includes('--apply')
const argument = (name: string) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=')
const cohortFile = argument('vaults-file')
if (!cohortFile) throw new Error('--vaults-file is required')
process.env.ALLOCATION_VAULTS_JSON = await readFile(cohortFile, 'utf8')
const vaults = listTestVaults()
if (new Set(vaults.map((vault) => `${vault.chainId}:${vault.address.toLowerCase()}`)).size !== vaults.length) {
  throw new Error('Duplicate vaults in publication cohort')
}
const maxBytes = Number(argument('max-target-bytes') ?? '400000000')
if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('Invalid target size ceiling')
const sourceUrl = process.env.ALLOCATION_SOURCE_DATABASE_URL
const targetUrl = process.env.ALLOCATION_PUBLISH_DATABASE_URL
if (!sourceUrl || !targetUrl || sourceUrl === targetUrl)
  throw new Error('Distinct source and publication database URLs are required')
const source = new Pool({ connectionString: sourceUrl, max: 1, connectionTimeoutMillis: 15000 })
const target = new Pool({ connectionString: targetUrl, max: 1, connectionTimeoutMillis: 15000 })

interface Projection {
  id: string
  active_run_id: string
  json: string
}
interface Run {
  id: string
  entry_count: number
  safe_block: string
  json: string
}
interface Fingerprint {
  count: number
  snapshots: number
  digest: string | null
}
async function fingerprint(client: PoolClient, runId: string): Promise<Fingerprint> {
  return (
    await client.query<Fingerprint>(
      `SELECT count(*)::integer AS count,
      count(*) FILTER (WHERE kind = 'current_snapshot')::integer AS snapshots,
      md5(string_agg(md5(to_jsonb(e)::text), '' ORDER BY entry_id)) AS digest
     FROM ${schema}.allocation_history_entry e WHERE run_id = $1::bigint`,
      [runId]
    )
  ).rows[0]
}
async function size(client: PoolClient): Promise<number> {
  return Number(
    (await client.query<{ bytes: string }>('SELECT pg_database_size(current_database())::text AS bytes')).rows[0].bytes
  )
}

let from: PoolClient | undefined
let to: PoolClient | undefined
try {
  from = await source.connect()
  to = await target.connect()
  await from.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  await from.query("SET LOCAL TIME ZONE 'UTC'")
  await to.query(apply ? 'BEGIN' : 'BEGIN READ ONLY')
  await to.query("SET LOCAL TIME ZONE 'UTC'")
  await to.query("SET LOCAL statement_timeout = '120s'")
  if (apply) {
    // Readers continue seeing the previous committed cohort until publication completes.
    await to.query(`LOCK TABLE ${schema}.allocation_history_projection, ${schema}.allocation_history_run,
      ${schema}.allocation_history_entry IN SHARE ROW EXCLUSIVE MODE`)
  }
  const beforeBytes = await size(to)
  if (beforeBytes > maxBytes) throw new Error(`Target already exceeds ${maxBytes} bytes`)
  const results: { label: string; chainId: number; runId: string; entries: number; copied: boolean; digest: string }[] =
    []
  const activations: Projection[] = []
  for (const vault of vaults) {
    const projection = (
      await from.query<Projection>(
        `SELECT id::text, active_run_id::text, to_jsonb(p)::text AS json
       FROM ${schema}.allocation_history_projection p WHERE chain_id = $1 AND vault_address = $2`,
        [vault.chainId, vault.address.toLowerCase()]
      )
    ).rows[0]
    if (!projection?.active_run_id) throw new Error(`${vault.label}: no active source run`)
    const run = (
      await from.query<Run>(
        `SELECT id::text, entry_count, safe_block::text, to_jsonb(r)::text AS json
       FROM ${schema}.allocation_history_run r
       WHERE id = $1::bigint AND projection_id = $2::bigint AND status = 'succeeded'
         AND materializer_version = $3 AND schema_version = 2
         AND data_quality->>'processingVersion' = $3`,
        [projection.active_run_id, projection.id, ALLOCATION_MATERIALIZER_VERSION]
      )
    ).rows[0]
    if (!run) throw new Error(`${vault.label}: source run is not a completed compatible run`)
    const coverage = JSON.parse(run.json).data_quality
    if (coverage.certification !== 'certified' && process.env.ALLOCATION_ALLOW_UNCERTIFIED_MATERIALIZATION !== 'true') {
      throw new Error(`${vault.label}: provisional publication must be explicitly enabled`)
    }
    const expected = await fingerprint(from, run.id)
    if (expected.count !== run.entry_count || expected.snapshots !== 1 || !expected.digest) {
      throw new Error(`${vault.label}: incomplete source entries`)
    }
    const existingProjection = await to.query<{
      id: string
      chain_id: number
      vault_address: string
      active_run_id: string | null
    }>(
      `SELECT id::text, chain_id, vault_address, active_run_id::text FROM ${schema}.allocation_history_projection
       WHERE id = $1::bigint OR (chain_id = $2 AND vault_address = $3)`,
      [projection.id, vault.chainId, vault.address.toLowerCase()]
    )
    for (const existing of existingProjection.rows) {
      if (
        existing.id !== projection.id ||
        existing.chain_id !== vault.chainId ||
        existing.vault_address !== vault.address.toLowerCase()
      ) {
        throw new Error(`${vault.label}: projection identity collision`)
      }
      if (existing.active_run_id && BigInt(existing.active_run_id) > BigInt(run.id)) {
        throw new Error(`${vault.label}: refusing to replace a newer target run`)
      }
      if (existing.active_run_id) {
        const active = (
          await to.query<{ safe_block: string }>(
            `SELECT safe_block::text FROM ${schema}.allocation_history_run WHERE id = $1`,
            [existing.active_run_id]
          )
        ).rows[0]
        if (!active || BigInt(active.safe_block) > BigInt(run.safe_block))
          throw new Error(`${vault.label}: target history would move backwards`)
      }
    }
    const existingRun = (
      await to.query<{ identical: boolean }>(
        `SELECT to_jsonb(r) = $2::jsonb AS identical FROM ${schema}.allocation_history_run r WHERE id = $1::bigint`,
        [run.id, run.json]
      )
    ).rows[0]
    if (existingRun) {
      if (!existingRun.identical || JSON.stringify(await fingerprint(to, run.id)) !== JSON.stringify(expected)) {
        throw new Error(`${vault.label}: immutable run collision or incomplete target entries`)
      }
    } else if (apply) {
      if (!existingProjection.rows.length) {
        await to.query(
          `INSERT INTO ${schema}.allocation_history_projection OVERRIDING SYSTEM VALUE
          SELECT * FROM jsonb_populate_record(NULL::${schema}.allocation_history_projection,
            jsonb_set($1::jsonb, '{active_run_id}', 'null'::jsonb))`,
          [projection.json]
        )
      }
      await to.query(
        `INSERT INTO ${schema}.allocation_history_run OVERRIDING SYSTEM VALUE
        SELECT * FROM jsonb_populate_record(NULL::${schema}.allocation_history_run, $1::jsonb)`,
        [run.json]
      )
      const storedRun = (
        await to.query<{ identical: boolean }>(
          `SELECT to_jsonb(r) = $2::jsonb AS identical FROM ${schema}.allocation_history_run r WHERE id = $1::bigint`,
          [run.id, run.json]
        )
      ).rows[0]
      if (!storedRun?.identical) throw new Error(`${vault.label}: copied run metadata differs`)
      for (let offset = 0; offset < run.entry_count; offset += batchSize) {
        const batch = (
          await from.query<{ payload: string }>(
            `SELECT jsonb_agg(to_jsonb(e))::text AS payload FROM
           (SELECT * FROM ${schema}.allocation_history_entry WHERE run_id = $1::bigint
            ORDER BY entry_id LIMIT $2 OFFSET $3) e`,
            [run.id, batchSize, offset]
          )
        ).rows[0].payload
        await to.query(
          `INSERT INTO ${schema}.allocation_history_entry
          SELECT * FROM jsonb_populate_recordset(NULL::${schema}.allocation_history_entry, $1::jsonb)`,
          [batch]
        )
      }
      if (JSON.stringify(await fingerprint(to, run.id)) !== JSON.stringify(expected))
        throw new Error(`${vault.label}: copied entries differ`)
      if ((await size(to)) > maxBytes) throw new Error('Publication exceeds the target size ceiling; rolling back')
    }
    activations.push(projection)
    results.push({
      label: vault.label,
      chainId: vault.chainId,
      runId: run.id,
      entries: run.entry_count,
      copied: apply && !existingRun,
      digest: expected.digest
    })
    console.log(`${apply ? 'Validated' : 'Planned'} ${vault.label}: run ${run.id}, ${run.entry_count} entries`)
  }
  if (apply) {
    for (const projection of activations) {
      await to.query(
        `UPDATE ${schema}.allocation_history_projection SET active_run_id = $2::bigint, updated_at = now()
        WHERE id = $1::bigint`,
        [projection.id, projection.active_run_id]
      )
    }
    for (const table of ['allocation_history_projection', 'allocation_history_run']) {
      await to.query(`SELECT setval(pg_get_serial_sequence('${schema}.${table}', 'id'), GREATEST(max(id), 1), true)
        FROM ${schema}.${table}`)
    }
  }
  const afterBytes = await size(to)
  if (afterBytes > maxBytes) throw new Error('Publication exceeds target size ceiling; rolling back')
  await to.query('COMMIT')
  await from.query('COMMIT')
  console.log(JSON.stringify({ applied: apply, beforeBytes, afterBytes, maxBytes, vaults: results }, null, 2))
} catch (error) {
  await to?.query('ROLLBACK').catch(() => undefined)
  await from?.query('ROLLBACK').catch(() => undefined)
  console.error(error instanceof Error ? error.message : 'Publication failed')
  process.exitCode = 1
} finally {
  from?.release()
  to?.release()
  await Promise.all([source.end(), target.end()])
}
