import type { Address } from './types'

export interface TestVault {
  chainId: 1 | 8453 | 747474
  address: Address
  label: string
}

const TEST_VAULTS: TestVault[] = [
  {
    chainId: 1,
    address: '0xBe53A109B494E5c9f97b9Cd39Fe969BE68BF6204',
    label: 'yvUSDC-1'
  },
  {
    chainId: 1,
    address: '0x310B7Ea7475A0B449Cfd73bE81522F1B88eFAFaa',
    label: 'yvUSDT-1'
  },
  {
    chainId: 1,
    address: '0x696d02Db93291651ED510704c9b286841d506987',
    label: 'yvUSD'
  }
]

export function findTestVault(chainId: number, address: string): TestVault | null {
  const normalized = address.toLowerCase()
  return (
    listTestVaults().find((vault) => vault.chainId === chainId && vault.address.toLowerCase() === normalized) ?? null
  )
}

export function listTestVaults(): readonly TestVault[] {
  const configured = process.env.ALLOCATION_VAULTS_JSON?.trim()
  if (!configured) return TEST_VAULTS
  const parsed: unknown = JSON.parse(configured)
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new Error('ALLOCATION_VAULTS_JSON must be a nonempty vault list')
  return parsed.map((item: unknown): TestVault => {
    if (!item || typeof item !== 'object') throw new Error('Invalid configured allocation vault')
    const row = item as Record<string, unknown>
    if (
      ![1, 8453, 747474].includes(Number(row.chainId)) ||
      typeof row.chainId !== 'number' ||
      typeof row.address !== 'string' ||
      !/^0x[a-fA-F0-9]{40}$/.test(row.address) ||
      typeof row.label !== 'string' ||
      !row.label.trim()
    )
      throw new Error('Invalid configured allocation vault')
    return { chainId: row.chainId as TestVault['chainId'], address: row.address as Address, label: row.label }
  })
}
