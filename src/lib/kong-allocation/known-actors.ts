import type { Address } from './types'

interface KnownActor {
  address: Address
  label: string
}

const DOA_KEEPERS_BY_CHAIN: Readonly<Record<number, readonly KnownActor[]>> = {
  1: [
    {
      address: '0x283132390ea87d6ecc20255b59ba94329ee17961',
      label: 'Yearn TKS DOA keeper'
    }
  ]
}

export function knownDoaKeeper(chainId: number, address: Address | null): KnownActor | null {
  if (!address) return null
  return DOA_KEEPERS_BY_CHAIN[chainId]?.find((actor) => actor.address === address.toLowerCase()) ?? null
}
