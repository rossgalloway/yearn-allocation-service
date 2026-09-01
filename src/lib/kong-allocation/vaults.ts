import type { Address } from './types'

export interface TestVault {
  chainId: 1
  address: Address
  label: 'yvUSDC-1' | 'yvUSDT-1' | 'yvUSD'
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
  return TEST_VAULTS.find((vault) => vault.chainId === chainId && vault.address.toLowerCase() === normalized) ?? null
}

export function listTestVaults(): readonly TestVault[] {
  return TEST_VAULTS
}
