import { databasePool } from '@/lib/database/client'
import { runDatabaseMigrations } from '@/lib/database/migrations'

try {
  const applied = await runDatabaseMigrations()
  console.log(applied.length === 0 ? 'Database schema is current' : `Applied migrations: ${applied.join(', ')}`)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  await databasePool()
    .end()
    .catch(() => undefined)
}
