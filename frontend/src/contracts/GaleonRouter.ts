/**
 * GaleonRouter — Jupiter-powered AI Swap Router on Solana
 *
 * Uses Jupiter V6 API for best-price swaps.
 * Positions are tracked by the backend; frontend builds and signs transactions.
 */

import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { getSolanaConnection, JUPITER_API_URL, SOLANA_TOKENS } from '../config/monad';
import { getPhantomProvider } from '../services/monadSmartAccount';

export interface JupiterQuote {
  inputMint: string;
  outputMint: string;
  inAmount: string;
  outAmount: string;
  priceImpactPct: number;
  routePlan: any[];
}

export interface MicroPosition {
  positionId: string;
  trader: string;
  tokenIn: string;
  tokenOut: string;
  totalAmountIn: number;
  totalTokenAmount: number;
  realizedPnl: number;
  stepCount: number;
  decisionId: number;
  endorsedTradeId: number;
  isOpen: boolean;
  openedAt: number;
}

/**
 * Get Jupiter swap quote
 */
export async function getSwapQuote(
  inputMint: string,
  outputMint: string,
  amount: number, // in smallest unit (lamports for SOL, etc.)
  slippageBps: number = 50 // 0.5%
): Promise<JupiterQuote | null> {
  try {
    const params = new URLSearchParams({
      inputMint,
      outputMint,
      amount: amount.toString(),
      slippageBps: slippageBps.toString(),
    });
    const resp = await fetch(`${JUPITER_API_URL}/quote?${params}`);
    if (!resp.ok) return null;
    return await resp.json();
  } catch (error) {
    console.error('Jupiter quote failed:', error);
    return null;
  }
}

/**
 * Execute a Jupiter swap via Phantom wallet
 */
export async function executeSwap(
  quote: JupiterQuote,
  userPublicKey: string
): Promise<string | null> {
  try {
    const phantom = getPhantomProvider();
    if (!phantom) throw new Error('Phantom wallet not connected');

    // Get serialized transaction from Jupiter
    const resp = await fetch(`${JUPITER_API_URL}/swap`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey,
        wrapAndUnwrapSol: true,
      }),
    });

    if (!resp.ok) throw new Error('Jupiter swap API failed');
    const { swapTransaction } = await resp.json();

    // Deserialize and sign
    const txBuf = Buffer.from(swapTransaction, 'base64');
    const tx = VersionedTransaction.deserialize(txBuf);
    const signed = await phantom.signTransaction(tx as any);

    // Send
    const connection = getSolanaConnection();
    const txId = await connection.sendRawTransaction((signed as any).serialize(), {
      skipPreflight: false,
      maxRetries: 2,
    });

    await connection.confirmTransaction(txId, 'confirmed');
    return txId;
  } catch (error) {
    console.error('Swap execution failed:', error);
    return null;
  }
}

/**
 * Quick swap SOL → Token
 */
export async function swapSolToToken(
  tokenMint: string,
  solAmount: number, // in SOL (e.g. 0.1)
  userPublicKey: string,
  slippageBps: number = 50
): Promise<string | null> {
  const lamports = Math.floor(solAmount * 1e9);
  const quote = await getSwapQuote(SOLANA_TOKENS.SOL.toBase58(), tokenMint, lamports, slippageBps);
  if (!quote) return null;
  return executeSwap(quote, userPublicKey);
}

/**
 * Quick swap Token → SOL
 */
export async function swapTokenToSol(
  tokenMint: string,
  tokenAmount: number, // in smallest unit
  userPublicKey: string,
  slippageBps: number = 50
): Promise<string | null> {
  const quote = await getSwapQuote(tokenMint, SOLANA_TOKENS.SOL.toBase58(), tokenAmount, slippageBps);
  if (!quote) return null;
  return executeSwap(quote, userPublicKey);
}

/**
 * Fetch trader positions — from backend API (not on-chain)
 */
export async function fetchTraderPositions(traderAddress: string): Promise<MicroPosition[]> {
  return [];
}

/**
 * Fetch a specific position — from backend API
 */
export async function fetchMicroPosition(positionId: string): Promise<MicroPosition | null> {
  return null;
}
