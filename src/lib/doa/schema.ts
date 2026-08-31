import type { DoaOptimization, DoaStrategyDebtRatio } from './types'

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/

function record(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${path} must be an object`)
  }
  return value as Record<string, unknown>
}

function address(value: unknown, path: string): string {
  if (typeof value !== 'string' || !ADDRESS_PATTERN.test(value)) {
    throw new Error(`${path} must be a 20-byte hex address`)
  }
  return value.toLowerCase()
}

function text(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new Error(`${path} must be ${allowEmpty ? 'a string' : 'a non-empty string'}`)
  }
  return value
}

function integer(value: unknown, path: string, maximum?: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    (maximum !== undefined && value > maximum)
  ) {
    throw new Error(`${path} must be an integer between 0 and ${maximum ?? Number.MAX_SAFE_INTEGER}`)
  }
  return value
}

function optionalInteger(value: unknown, path: string): number | undefined {
  return value === undefined ? undefined : integer(value, path)
}

function parseStrategy(value: unknown, path: string): DoaStrategyDebtRatio {
  const input = record(value, path)
  const name = input.name === undefined ? undefined : text(input.name, `${path}.name`)
  const currentApr = optionalInteger(input.currentApr, `${path}.currentApr`)
  const targetApr = optionalInteger(input.targetApr, `${path}.targetApr`)
  return {
    strategy: address(input.strategy, `${path}.strategy`),
    ...(name === undefined ? {} : { name }),
    targetRatio: integer(input.targetRatio, `${path}.targetRatio`, 10_000),
    currentRatio: integer(input.currentRatio, `${path}.currentRatio`, 10_000),
    ...(currentApr === undefined ? {} : { currentApr }),
    ...(targetApr === undefined ? {} : { targetApr })
  }
}

function parseOptimization(value: unknown, path: string): DoaOptimization {
  const input = record(value, path)
  if (!Array.isArray(input.strategyDebtRatios)) {
    throw new Error(`${path}.strategyDebtRatios must be an array`)
  }
  return {
    vault: address(input.vault, `${path}.vault`),
    strategyDebtRatios: input.strategyDebtRatios.map((strategy, index) =>
      parseStrategy(strategy, `${path}.strategyDebtRatios.${index}`)
    ),
    currentApr: integer(input.currentApr, `${path}.currentApr`),
    proposedApr: integer(input.proposedApr, `${path}.proposedApr`),
    explain: text(input.explain, `${path}.explain`, true)
  }
}

export function parseDoaOptimizations(value: unknown, sourceLabel = 'DOA optimization payload'): DoaOptimization[] {
  if (!Array.isArray(value)) {
    throw new Error(`${sourceLabel} must be an array`)
  }
  try {
    return value.map((optimization, index) => parseOptimization(optimization, `${sourceLabel}.${index}`))
  } catch (error) {
    throw new Error(`Invalid ${sourceLabel}: ${error instanceof Error ? error.message : String(error)}`)
  }
}
