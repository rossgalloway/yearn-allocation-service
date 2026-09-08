import { databasePool } from '@/lib/database/client'
import { runDatabaseMigrations } from '@/lib/database/migrations'
import {
  completeMaterializationRun,
  failMaterializationRun,
  startMaterializationRun
} from '@/lib/kong-allocation/repository'
import { materializeCompleteKongAllocationHistory } from '@/lib/kong-allocation/service'
import { listTestVaults } from '@/lib/kong-allocation/vaults'

function argument(name: string): string | null {
  const prefix = `--${name}=`
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null
}

const mode = argument('mode')
if (mode !== 'backfill' && mode !== 'refresh') throw new Error('--mode must be backfill or refresh')
const selectedChain = argument('chain')
const selectedVault = argument('vault')?.toLowerCase() ?? null
const vaults = listTestVaults().filter(
  (vault) =>
    (selectedChain === null || vault.chainId === Number(selectedChain)) &&
    (selectedVault === null ||
      vault.label.toLowerCase() === selectedVault ||
      vault.address.toLowerCase() === selectedVault)
)
if (vaults.length === 0) throw new Error(`Unknown test vault: ${selectedVault}`)

let failures = 0
try {
  await runDatabaseMigrations()
  for (const vault of vaults) {
    let run: Awaited<ReturnType<typeof startMaterializationRun>> | null = null
    try {
      run = await startMaterializationRun({ vault, mode })
      console.log(`${mode === 'backfill' ? 'Backfilling' : 'Refreshing'} ${vault.label}`)
      const result = await materializeCompleteKongAllocationHistory(vault)
      await completeMaterializationRun({ run, ...result })
      console.log(
        `${vault.label}: activated ${result.coverage.safeForTimeline ? 'certified' : 'PROVISIONAL'} run ${run.id} with ${result.entries.length} entries through block ${result.safeBlock.blockNumber}`
      )
    } catch (error) {
      failures += 1
      if (run) await failMaterializationRun(run.id, error).catch(() => undefined)
      console.error(`${vault.label}: ${error instanceof Error ? error.message : error}`)
    }
  }
} finally {
  await databasePool()
    .end()
    .catch(() => undefined)
}

if (failures > 0) process.exitCode = 1
