import { createHash } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { databasePool } from './client'

const MIGRATION_LOCK_ID = 7_241_903_114

interface AppliedMigration {
  name: string
  checksum: string
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex')
}

export async function runDatabaseMigrations(
  directory = path.join(process.cwd(), 'db', 'migrations')
): Promise<string[]> {
  const files = (await readdir(directory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort()
  const client = await databasePool().connect()
  const appliedNow: string[] = []
  try {
    await client.query('BEGIN')
    await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_ID])
    await client.query(`CREATE TABLE IF NOT EXISTS allocation_schema_migration (
      name text PRIMARY KEY,
      checksum char(64) NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`)
    const applied = await client.query<AppliedMigration>('SELECT name, checksum FROM allocation_schema_migration')
    const byName = new Map(applied.rows.map((row) => [row.name, row.checksum]))

    for (const name of files) {
      const sql = await readFile(path.join(directory, name), 'utf8')
      const nextChecksum = checksum(sql)
      const previousChecksum = byName.get(name)
      if (previousChecksum) {
        if (previousChecksum !== nextChecksum) throw new Error(`Applied migration ${name} has changed`)
        continue
      }
      await client.query(sql)
      await client.query('INSERT INTO allocation_schema_migration (name, checksum) VALUES ($1, $2)', [
        name,
        nextChecksum
      ])
      appliedNow.push(name)
    }
    await client.query('COMMIT')
    return appliedNow
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw error
  } finally {
    client.release()
  }
}
