/**
 * GaleonBrain — Solana on-chain AI Trading Intelligence Layer
 *
 * Reads AI decisions and trader stats from the Galeon Brain Solana program.
 * Decisions are published by the backend; the frontend is read-only.
 */

import { PublicKey } from '@solana/web3.js';
import { getSolanaConnection, SOLANA_PROGRAMS } from '../config/monad';

export const DIRECTION_LABELS: Record<number, string> = {
  0: 'WAIT',
  1: 'LONG',
  2: 'SHORT',
};

export const RISK_LABELS: Record<number, string> = {
  0: 'LOW',
  1: 'MEDIUM',
  2: 'HIGH',
};

export interface TradeDecision {
  asset: string;
  direction: number;
  directionLabel: string;
  confidence: number;
  riskLevel: number;
  riskLabel: string;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  reasoning: string;
  similarSetups: number;
  historicalWinRate: number;
  timestamp: number;
}

export interface TraderStats {
  totalTrades: number;
  winCount: number;
  totalPnlBps: number;
  totalMicroSteps: number;
  winRate: number;
}

export interface AIEndorsedTrade {
  tradeId: number;
  trader: string;
  token: string;
  amount: number;
  direction: number;
  confidence: number;
  riskLevel: number;
  similarSetups: number;
  historicalWinRate: number;
  decisionId: number;
  timestamp: number;
  settled: boolean;
  pnlBps: number;
  microSteps: number;
}

/**
 * Derive PDA for a decision account
 */
function getDecisionPDA(asset: string): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('decision'), Buffer.from(asset)],
    SOLANA_PROGRAMS.GaleonBrain
  );
}

/**
 * Derive PDA for trader stats
 */
function getTraderStatsPDA(trader: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from('trader_stats'), trader.toBuffer()],
    SOLANA_PROGRAMS.GaleonBrain
  );
}

/**
 * Fetch latest trade decision for an asset from on-chain PDA
 */
export async function fetchTradeDecision(asset: string): Promise<TradeDecision | null> {
  try {
    const connection = getSolanaConnection();
    const [pda] = getDecisionPDA(asset);
    const info = await connection.getAccountInfo(pda);

    if (!info || !info.data || info.data.length < 8) return null;

    // Anchor discriminator (8 bytes) + decode fields
    const data = info.data;
    const offset = 8; // skip anchor discriminator
    const direction = data[offset];
    const confidence = data[offset + 1];
    const riskLevel = data[offset + 2];
    const entryPrice = Number(data.readBigInt64LE(offset + 3)) / 1e6;
    const stopLoss = Number(data.readBigInt64LE(offset + 11)) / 1e6;
    const takeProfit = Number(data.readBigInt64LE(offset + 19)) / 1e6;
    const similarSetups = data.readUInt16LE(offset + 27);
    const historicalWinRate = data[offset + 29];
    const timestamp = Number(data.readBigInt64LE(offset + 30));
    // reasoning is a Borsh string: 4-byte length prefix + utf8
    const reasonLen = data.readUInt32LE(offset + 38);
    const reasoning = data.slice(offset + 42, offset + 42 + reasonLen).toString('utf8');

    return {
      asset,
      direction,
      directionLabel: DIRECTION_LABELS[direction] || 'UNKNOWN',
      confidence,
      riskLevel,
      riskLabel: RISK_LABELS[riskLevel] || 'UNKNOWN',
      entryPrice,
      stopLoss,
      takeProfit,
      reasoning,
      similarSetups,
      historicalWinRate,
      timestamp,
    };
  } catch (error) {
    console.error(`Failed to fetch decision for ${asset}:`, error);
    return null;
  }
}

/**
 * Fetch trader stats from on-chain PDA
 */
export async function fetchTraderStats(traderAddress: string): Promise<TraderStats | null> {
  try {
    const connection = getSolanaConnection();
    const trader = new PublicKey(traderAddress);
    const [pda] = getTraderStatsPDA(trader);
    const info = await connection.getAccountInfo(pda);

    if (!info || !info.data || info.data.length < 8) return null;

    const data = info.data;
    const offset = 8;
    return {
      totalTrades: data.readUInt32LE(offset),
      winCount: data.readUInt32LE(offset + 4),
      totalPnlBps: data.readInt32LE(offset + 8),
      totalMicroSteps: data.readUInt32LE(offset + 12),
      winRate: data[offset + 16],
    };
  } catch (error) {
    console.error(`Failed to fetch stats for ${traderAddress}:`, error);
    return null;
  }
}

/**
 * Fetch endorsed trades for a trader via backend API
 * (on-chain iteration is expensive; use API as index)
 */
export async function fetchTraderTrades(traderAddress: string): Promise<AIEndorsedTrade[]> {
  // Endorsed trades are indexed by the backend API, not fetched from chain directly
  // This keeps the frontend fast and avoids expensive on-chain iteration
  return [];
}

/**
 * Fetch a specific endorsed trade — placeholder, use backend API
 */
export async function fetchEndorsedTrade(tradeId: number): Promise<AIEndorsedTrade | null> {
  return null;
}
