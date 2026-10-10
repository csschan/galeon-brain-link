/**
 * Solana Chain Configuration
 * Used by Brain Link components and Phantom wallet integration
 */

import { Connection, PublicKey, clusterApiUrl } from '@solana/web3.js';

export const SOLANA_NETWORK = (process.env.REACT_APP_SOLANA_NETWORK || 'devnet') as 'mainnet-beta' | 'devnet' | 'testnet';

export const SOLANA_RPC_URL = process.env.REACT_APP_SOLANA_RPC_URL || clusterApiUrl(SOLANA_NETWORK);

export const SOLANA_EXPLORER_URL = SOLANA_NETWORK === 'mainnet-beta'
  ? 'https://solscan.io'
  : `https://solscan.io?cluster=${SOLANA_NETWORK}`;

export const SOLANA_PROGRAMS = {
  GaleonBrain: new PublicKey(process.env.REACT_APP_SOLANA_GALEON_BRAIN_ADDRESS || '11111111111111111111111111111111'),
  GaleonRouter: new PublicKey(process.env.REACT_APP_SOLANA_GALEON_ROUTER_ADDRESS || '11111111111111111111111111111111'),
};

// Well-known Solana token mints
export const SOLANA_TOKENS = {
  SOL: new PublicKey('So11111111111111111111111111111111111111112'),
  USDC: new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'),
  USDT: new PublicKey('Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'),
};

// Jupiter V6 API
export const JUPITER_API_URL = 'https://quote-api.jup.ag/v6';

let _connection: Connection | null = null;

/**
 * Get shared Solana connection instance
 */
export function getSolanaConnection(): Connection {
  if (!_connection) {
    _connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  }
  return _connection;
}

/**
 * Get explorer URL for a transaction or address
 */
export function getExplorerUrl(addressOrTx: string, type: 'tx' | 'address' = 'address'): string {
  const cluster = SOLANA_NETWORK === 'mainnet-beta' ? '' : `?cluster=${SOLANA_NETWORK}`;
  return `${SOLANA_EXPLORER_URL}/${type}/${addressOrTx}${cluster}`;
}
