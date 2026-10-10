/**
 * BrainChainContext — provides chain-specific config based on URL prefix (/monad or /solana)
 */
import React, { createContext, useContext, useMemo } from 'react';
import { useLocation } from 'react-router-dom';

export type ChainType = 'monad' | 'solana';

export interface ChainConfig {
  chain: ChainType;
  chainName: string;
  dex: string;
  wallet: string;
  nativeToken: string;
  stableToken: string;
  explorer: string;
  explorerName: string;
  basePath: string;
  tagline: string;
}

const MONAD_CONFIG: ChainConfig = {
  chain: 'monad',
  chainName: 'Monad',
  dex: 'Kuru DEX',
  wallet: 'MetaMask',
  nativeToken: 'MON',
  stableToken: 'USDC',
  explorer: 'https://monadscan.com',
  explorerName: 'Monadscan',
  basePath: '/monad',
  tagline: 'Before every trade on Monad, ask Galeon.',
};

const SOLANA_CONFIG: ChainConfig = {
  chain: 'solana',
  chainName: 'Solana',
  dex: 'Jupiter',
  wallet: 'Phantom',
  nativeToken: 'SOL',
  stableToken: 'USDC',
  explorer: 'https://solscan.io',
  explorerName: 'Solscan',
  basePath: '/solana',
  tagline: 'Before every trade on Solana, ask Galeon.',
};

const BrainChainContext = createContext<ChainConfig>(SOLANA_CONFIG);

export function useBrainChain(): ChainConfig {
  return useContext(BrainChainContext);
}

export const BrainChainProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const location = useLocation();

  const config = useMemo(() => {
    if (location.pathname.startsWith('/monad')) return MONAD_CONFIG;
    return SOLANA_CONFIG;
  }, [location.pathname]);

  return (
    <BrainChainContext.Provider value={config}>
      {children}
    </BrainChainContext.Provider>
  );
};

export default BrainChainContext;
