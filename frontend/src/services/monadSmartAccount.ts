/**
 * Multi-chain Wallet Service
 * Phantom for Solana, MetaMask for Monad (EVM)
 */

import { PublicKey, Transaction } from '@solana/web3.js';
import { getSolanaConnection } from '../config/monad';

// ============ Phantom (Solana) ============

interface PhantomProvider {
  isPhantom?: boolean;
  publicKey?: PublicKey;
  isConnected?: boolean;
  connect: (opts?: { onlyIfTrusted?: boolean }) => Promise<{ publicKey: PublicKey }>;
  disconnect: () => Promise<void>;
  signTransaction: (tx: Transaction) => Promise<Transaction>;
  signAllTransactions: (txs: Transaction[]) => Promise<Transaction[]>;
  signMessage: (message: Uint8Array) => Promise<{ signature: Uint8Array }>;
  on: (event: string, handler: (...args: any[]) => void) => void;
}

function getPhantom(): PhantomProvider | null {
  if (typeof window === 'undefined') return null;
  const provider = (window as any).phantom?.solana || (window as any).solana;
  if (provider?.isPhantom) return provider;
  return null;
}

export async function connectPhantomWallet(): Promise<string | null> {
  const phantom = getPhantom();
  if (!phantom) {
    window.open('https://phantom.app/', '_blank');
    return null;
  }
  try {
    const resp = await phantom.connect();
    return resp.publicKey.toBase58();
  } catch (e) {
    console.error('Phantom connect failed:', e);
    return null;
  }
}

export async function getConnectedAddress(): Promise<string | null> {
  const phantom = getPhantom();
  if (!phantom || !phantom.isConnected || !phantom.publicKey) return null;
  return phantom.publicKey.toBase58();
}

export async function disconnectWallet(): Promise<void> {
  const phantom = getPhantom();
  if (phantom) await phantom.disconnect();
}

export function getPhantomProvider(): PhantomProvider | null {
  return getPhantom();
}

export async function getSolBalance(address: string): Promise<number> {
  const connection = getSolanaConnection();
  const balance = await connection.getBalance(new PublicKey(address));
  return balance / 1e9;
}

// ============ MetaMask (Monad EVM) ============

function getEthereum(): any | null {
  if (typeof window === 'undefined') return null;
  return (window as any).ethereum || null;
}

export async function connectMetaMaskWallet(): Promise<string | null> {
  const ethereum = getEthereum();
  if (!ethereum) {
    window.open('https://metamask.io/download/', '_blank');
    return null;
  }
  try {
    // Request account access
    const accounts = await ethereum.request({ method: 'eth_requestAccounts' });
    if (!accounts || accounts.length === 0) return null;

    // Switch to Monad network
    const monadChainId = process.env.REACT_APP_MONAD_CHAIN_ID || '143';
    const chainIdHex = '0x' + parseInt(monadChainId).toString(16);
    try {
      await ethereum.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: chainIdHex }],
      });
    } catch (switchError: any) {
      // Chain not added yet, add it
      if (switchError.code === 4902) {
        await ethereum.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: chainIdHex,
            chainName: 'Monad',
            rpcUrls: [process.env.REACT_APP_MONAD_RPC_URL || 'https://rpc.monad.xyz'],
            nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
            blockExplorerUrls: [process.env.REACT_APP_MONAD_EXPLORER_URL || 'https://monadscan.com'],
          }],
        });
      }
    }

    return accounts[0];
  } catch (e) {
    console.error('MetaMask connect failed:', e);
    return null;
  }
}

export async function getEvmConnectedAddress(): Promise<string | null> {
  const ethereum = getEthereum();
  if (!ethereum) return null;
  try {
    const accounts = await ethereum.request({ method: 'eth_accounts' });
    return accounts && accounts.length > 0 ? accounts[0] : null;
  } catch {
    return null;
  }
}

export async function disconnectEvmWallet(): Promise<void> {
  // MetaMask doesn't have a programmatic disconnect
  // State is managed on the frontend side
}

export async function getMonBalance(address: string): Promise<number> {
  const ethereum = getEthereum();
  if (!ethereum) return 0;
  try {
    const balance = await ethereum.request({
      method: 'eth_getBalance',
      params: [address, 'latest'],
    });
    return parseInt(balance, 16) / 1e18;
  } catch {
    return 0;
  }
}

export async function getEvmTokenBalance(address: string, tokenContract: string): Promise<number> {
  const ethereum = getEthereum();
  if (!ethereum) return 0;
  try {
    // ERC20 balanceOf(address) selector: 0x70a08231
    const data = '0x70a08231' + address.slice(2).padStart(64, '0');
    const result = await ethereum.request({
      method: 'eth_call',
      params: [{ to: tokenContract, data }, 'latest'],
    });
    return parseInt(result, 16) / 1e6; // USDC has 6 decimals
  } catch {
    return 0;
  }
}

// ============ On-chain Contract Calls (Monad) ============

const GALEON_ROUTER = process.env.REACT_APP_GALEON_ROUTER_ADDRESS || '0xB7D5aD3ff190B556de41832204530FdA006a85A2';
const MONAD_USDC = process.env.REACT_APP_MONAD_USDC_ADDRESS || '0xf817257fed379853cDe0fa4F97AB987181B1E5Ea';

/**
 * Approve USDC spending to GaleonRouter contract
 */
export async function approveUsdcToRouter(userAddress: string, amount: number): Promise<string> {
  const ethereum = getEthereum();
  if (!ethereum) throw new Error('MetaMask not found');

  // approve(address spender, uint256 amount)
  const amountWei = BigInt(Math.floor(amount * 1e6)); // USDC 6 decimals
  const spender = GALEON_ROUTER.slice(2).padStart(64, '0');
  const amountHex = amountWei.toString(16).padStart(64, '0');
  const data = '0x095ea7b3' + spender + amountHex; // approve selector

  const txHash = await ethereum.request({
    method: 'eth_sendTransaction',
    params: [{
      from: userAddress,
      to: MONAD_USDC,
      data,
    }],
  });
  return txHash;
}

/**
 * Call GaleonRouter.enableAutoTrade(maxPerTrade, totalLimit, durationDays)
 */
export async function enableAutoTradeOnChain(
  userAddress: string,
  maxPerTrade: number, // in USDT/USDC
  totalLimit: number,
  durationDays: number = 30
): Promise<string> {
  const ethereum = getEthereum();
  if (!ethereum) throw new Error('MetaMask not found');

  // enableAutoTrade(uint256 maxPerTrade, uint256 totalLimit, uint256 durationDays)
  const selector = '0xa7672bf7'; // keccak256("enableAutoTrade(uint256,uint256,uint256)")[:4]
  const maxWei = BigInt(Math.floor(maxPerTrade * 1e6)).toString(16).padStart(64, '0');
  const totalWei = BigInt(Math.floor(totalLimit * 1e6)).toString(16).padStart(64, '0');
  const days = BigInt(durationDays).toString(16).padStart(64, '0');
  const data = selector + maxWei + totalWei + days;

  const txHash = await ethereum.request({
    method: 'eth_sendTransaction',
    params: [{
      from: userAddress,
      to: GALEON_ROUTER,
      data,
    }],
  });
  return txHash;
}

/**
 * Call GaleonRouter.revokeAutoTrade()
 */
export async function revokeAutoTradeOnChain(userAddress: string): Promise<string> {
  const ethereum = getEthereum();
  if (!ethereum) throw new Error('MetaMask not found');

  // revokeAutoTrade() selector
  const data = '0xc5529ede'; // keccak256("revokeAutoTrade()")[:4]
  const txHash = await ethereum.request({
    method: 'eth_sendTransaction',
    params: [{
      from: userAddress,
      to: GALEON_ROUTER,
      data,
    }],
  });
  return txHash;
}

/**
 * Check if user is authorized on-chain (read-only)
 */
export async function checkAutoTradeAuthorized(userAddress: string): Promise<boolean> {
  const ethereum = getEthereum();
  if (!ethereum) return false;
  try {
    // userAuths(address) returns (bool enabled, uint256 maxPerTrade, uint256 totalLimit, uint256 totalUsed, uint256 expiresAt)
    const addrPadded = userAddress.slice(2).padStart(64, '0');
    const data = '0xa675ab23' + addrPadded; // keccak256("userAuths(address)")[:4]
    const result = await ethereum.request({
      method: 'eth_call',
      params: [{ to: GALEON_ROUTER, data }, 'latest'],
    });
    // First 32 bytes = enabled (bool)
    if (!result || result === '0x') return false;
    const enabledHex = result.slice(2, 66);
    return parseInt(enabledHex, 16) === 1;
  } catch {
    return false;
  }
}

// Legacy alias
export const connectMetaMaskToMonad = connectMetaMaskWallet;
