/**
 * BrainOracleService
 *
 * Bridges Galeon Brain (off-chain) → Monad GaleonBrain contract (on-chain)
 *
 * Responsibilities:
 * 1. Push trade decisions to Monad after VotingSystem scores a symbol
 * 2. Run Micro-Execution Loop: check active positions every block (0.8s)
 * 3. Manage DCA entry, partial take-profit, dynamic stop-loss, emergency exit
 *
 * Integration points:
 * - GainerScanner: calls publishDecision() after scoreSymbol()
 * - AutoTradeService: calls startMicroPosition() for Monad chain trades
 * - ExitMonitor logic: reused in microExecutionLoop()
 */

const { ethers } = require('ethers');
const chainConfig = require('../../config/chains');
const contractsConfig = require('../../config/contracts');
const BaseAgent = require('./core/BaseAgent');
const AgentBus = require('./core/AgentBus');

// GaleonBrain ABI (write functions used by oracle)
const BRAIN_ABI = [
  'function publishDecision(string asset, uint8 direction, uint8 confidence, uint8 riskLevel, int256 entryPrice, int256 stopLoss, int256 takeProfit, string reasoning, uint16 similarSetups, uint8 historicalWinRate) returns (uint256 decisionId)',
  'function getTradeDecision(string asset) view returns (uint8 direction, uint8 confidence, uint8 riskLevel, int256 entryPrice, int256 stopLoss, int256 takeProfit, string reasoning, uint16 similarSetups, uint8 historicalWinRate, uint256 timestamp)',
  'function decisionCount() view returns (uint256)',
];

// GaleonRouter ABI (write functions for micro-execution)
const ROUTER_ABI = [
  'function openMicroPosition(address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOutMin, uint256 decisionId) returns (uint256 positionId)',
  'function addToPosition(uint256 positionId, uint256 amountIn, uint256 amountOutMin)',
  'function partialExit(uint256 positionId, uint256 tokenAmount, uint256 amountOutMin)',
  'function emergencyExit(uint256 positionId, uint256 amountOutMin)',
  'function closePosition(uint256 positionId, uint256 amountOutMin)',
  'function microPositions(uint256 positionId) view returns (address trader, address tokenIn, address tokenOut, uint256 totalAmountIn, uint256 totalTokenAmount, uint256 realizedPnl, uint8 stepCount, uint256 decisionId, uint256 endorsedTradeId, bool isOpen, uint256 openedAt)',
];

class BrainOracleService extends BaseAgent {
  constructor(learningEngine, votingSystem) {
    super('Brain Oracle', 'oracle');
    AgentBus.register(this);

    this.learningEngine = learningEngine;
    this.votingSystem = votingSystem;
    this.provider = null;
    this.wallet = null;
    this.brainContract = null;
    this.routerContract = null;
    this.initialized = false;

    // Decision cache (in-memory, for API queries)
    this.latestDecisions = new Map(); // asset => { votingResult, evidence, decisionId, timestamp }

    // Active micro-positions (tracked for loop)
    this.activeMicroPositions = new Map(); // positionId => { positionData, dcaPlan, tpPlan }

    // Micro-execution loop state
    this.microLoopInterval = null;
    this.microLoopRunning = false;
  }

  async initialize() {
    try {
      const monadConfig = chainConfig.Monad;
      if (!monadConfig) {
        this.log('⚠️ Monad chain config not found, skipping initialization');
        return;
      }

      const oracleKey = process.env.MONAD_ORACLE_PRIVATE_KEY;
      if (!oracleKey) {
        this.log('⚠️ MONAD_ORACLE_PRIVATE_KEY not set, running in read-only mode');
        this.provider = new ethers.JsonRpcProvider(monadConfig.rpcUrl);
        this.initialized = true;
        return;
      }

      // Connect to Monad
      this.provider = new ethers.JsonRpcProvider(monadConfig.rpcUrl);
      this.wallet = new ethers.Wallet(oracleKey, this.provider);

      // Init contracts
      const brainAddress = contractsConfig.Monad?.GaleonBrain;
      const routerAddress = contractsConfig.Monad?.GaleonRouter;

      if (brainAddress) {
        this.brainContract = new ethers.Contract(brainAddress, BRAIN_ABI, this.wallet);
        this.log(`✅ GaleonBrain contract: ${brainAddress}`);
      }

      if (routerAddress) {
        this.routerContract = new ethers.Contract(routerAddress, ROUTER_ABI, this.wallet);
        this.log(`✅ GaleonRouter contract: ${routerAddress}`);
      }

      this.initialized = true;
      this.log(`✅ BrainOracleService initialized on Monad (${monadConfig.rpcUrl})`);
      this.log(`   Oracle address: ${this.wallet.address}`);

    } catch (error) {
      this.log(`❌ BrainOracleService initialization failed: ${error.message}`);
    }
  }

  // ========================================================
  // DECISION PUBLISHING
  // ========================================================

  /**
   * Push a VotingSystem result to Monad chain
   * Called by GainerScanner after scoreSymbol()
   *
   * @param {string} asset - Token symbol (e.g. 'MON', 'WETH')
   * @param {object} votingResult - VotingSystem.scoreSymbol() output
   * @param {object} evidence - Historical evidence from LearningEngine
   */
  async publishDecision(asset, votingResult, evidence = {}) {
    // Always cache locally (for API queries even without chain push)
    this.latestDecisions.set(asset, {
      votingResult,
      evidence,
      decisionId: null,
      timestamp: Date.now(),
    });

    // Skip chain push to save gas (enable for hackathon demo)
    if (process.env.BRAIN_PUSH_ONCHAIN !== 'true') {
      return null;
    }

    // Push to chain if contract available
    if (!this.brainContract) {
      this.log(`📋 [${asset}] Decision cached locally (no chain contract)`);
      return null;
    }

    try {
      const direction = votingResult.direction === 'LONG' ? 1 :
                        votingResult.direction === 'SHORT' ? 2 : 0;
      const confidence = Math.min(Math.max(Math.round(votingResult.confidence || 0), 0), 100);
      const riskLevel = confidence >= 70 ? 0 : confidence >= 55 ? 1 : 2; // LOW/MEDIUM/HIGH

      // Price to 18 decimals
      const price = votingResult.price || 0;
      const entryPrice = ethers.parseUnits(price.toFixed(8), 18);
      const stopLoss = votingResult.sl ? ethers.parseUnits(votingResult.sl.toFixed(8), 18) : 0n;
      const takeProfit = votingResult.tp1 ? ethers.parseUnits(votingResult.tp1.toFixed(8), 18) : 0n;

      // Build reasoning string (concise)
      const topVotes = votingResult.votes
        .filter(v => Math.abs(v.score) >= 1)
        .sort((a, b) => Math.abs(b.score) - Math.abs(a.score))
        .slice(0, 5)
        .map(v => `${v.dim}:${v.score > 0 ? '+' : ''}${v.score}`)
        .join(', ');
      const reasoning = topVotes || 'No strong signals';

      const similarSetups = Math.min(evidence.similarSetups || 0, 65535);
      const winRate = Math.min(Math.max(Math.round(evidence.winRate || 0), 0), 100);

      const tx = await this.brainContract.publishDecision(
        asset,
        direction,
        confidence,
        riskLevel,
        entryPrice,
        stopLoss,
        takeProfit,
        reasoning,
        similarSetups,
        winRate
      );

      const receipt = await tx.wait();
      const decisionId = Number(await this.brainContract.decisionCount()) - 1;

      // Update cache with on-chain ID
      this.latestDecisions.get(asset).decisionId = decisionId;

      this.log(`🔗 [${asset}] Decision #${decisionId} published on-chain (${votingResult.direction} ${confidence}%) tx: ${receipt.hash}`);

      return decisionId;

    } catch (error) {
      this.log(`❌ [${asset}] Failed to publish decision: ${error.message}`);
      return null;
    }
  }

  // ========================================================
  // RISK ASSESSMENT (for Brain Link API)
  // ========================================================

  /**
   * Assess risk for a proposed trade
   * Called by Brain Link API: POST /api/brain-link/assess-risk
   *
   * @param {string} walletAddress
   * @param {object} proposedTrade - { asset, direction, amount }
   * @returns {object} { riskScore, action, suggestedAmount, reason }
   */
  async assessRisk(walletAddress, proposedTrade) {
    const { asset, direction, amount } = proposedTrade;

    // Get latest decision for this asset
    const decision = this.latestDecisions.get(asset);
    if (!decision) {
      return {
        riskScore: 50,
        action: 'PASS',
        suggestedAmount: amount,
        reason: 'No Brain decision available for this asset',
      };
    }

    const vr = decision.votingResult;
    let riskScore = 50;
    let suggestedAmount = amount;
    const reasons = [];

    // 1. Direction alignment
    if (direction && vr.direction && direction !== vr.direction) {
      riskScore += 30;
      reasons.push(`Direction conflict: Brain says ${vr.direction}, you want ${direction}`);
    }

    // 2. Confidence-based sizing
    if (vr.confidence < 60) {
      riskScore += 15;
      suggestedAmount = Math.round(amount * 0.3);
      reasons.push(`Low confidence (${vr.confidence}%), reduce to 30%`);
    } else if (vr.confidence < 70) {
      riskScore += 5;
      suggestedAmount = Math.round(amount * 0.5);
      reasons.push(`Medium confidence (${vr.confidence}%), reduce to 50%`);
    } else if (vr.confidence >= 75) {
      suggestedAmount = Math.round(amount * 0.7);
      reasons.push(`Good confidence (${vr.confidence}%), suggest 70% position`);
    }

    // 3. Fatal combo warning
    if (!vr.passed && vr.reason) {
      riskScore += 25;
      reasons.push(`Brain blocked: ${vr.reason}`);
    }

    // 4. Market regime
    if (vr.marketData) {
      const { fr, rsi } = vr.marketData;
      if (fr && Math.abs(fr) > 0.001) {
        riskScore += 10;
        reasons.push(`Extreme funding rate: ${fr.toFixed(4)}`);
      }
      if (rsi && (rsi > 80 || rsi < 25)) {
        riskScore += 10;
        reasons.push(`Extreme RSI: ${rsi.toFixed(0)}`);
      }
    }

    // Determine action
    riskScore = Math.min(riskScore, 100);
    let action = 'PASS';
    if (riskScore >= 80) action = 'REJECT';
    else if (riskScore >= 50 || suggestedAmount < amount) action = 'ADJUST';

    return { riskScore, action, suggestedAmount, reason: reasons.join('; ') || 'Trade looks reasonable' };
  }

  // ========================================================
  // MICRO-EXECUTION LOOP
  // ========================================================

  /**
   * Start the micro-execution monitoring loop
   * Checks all active positions every block (~0.8s)
   */
  startMicroExecutionLoop() {
    if (this.microLoopInterval) return;

    const blockTime = chainConfig.Monad?.blockTime || 800;
    this.microLoopInterval = setInterval(async () => {
      if (this.microLoopRunning) return; // Skip if previous iteration still running
      this.microLoopRunning = true;

      try {
        await this._runMicroLoop();
      } catch (error) {
        this.log(`❌ Micro-execution loop error: ${error.message}`);
      } finally {
        this.microLoopRunning = false;
      }
    }, blockTime);

    this.log(`🔄 Micro-execution loop started (every ${blockTime}ms)`);
  }

  stopMicroExecutionLoop() {
    if (this.microLoopInterval) {
      clearInterval(this.microLoopInterval);
      this.microLoopInterval = null;
      this.log('⏹️ Micro-execution loop stopped');
    }
  }

  /**
   * Single iteration of the micro-execution loop
   */
  async _runMicroLoop() {
    for (const [positionId, posData] of this.activeMicroPositions) {
      try {
        await this._checkMicroPosition(positionId, posData);
      } catch (error) {
        this.log(`⚠️ Position #${positionId} check failed: ${error.message}`);
      }
    }
  }

  /**
   * Check a single micro-position for DCA, TP, SL, or emergency exit
   */
  async _checkMicroPosition(positionId, posData) {
    const { asset, dcaPlan, tpPlan, direction } = posData;

    // Get current price from MarketDataCache
    const marketData = await this.votingSystem._fetchMarketData(asset + 'USDT');
    if (!marketData || !marketData.price) return;

    const currentPrice = marketData.price;
    const entryPrice = posData.avgEntryPrice;
    const pnlPercent = direction === 'LONG'
      ? ((currentPrice - entryPrice) / entryPrice) * 100
      : ((entryPrice - currentPrice) / entryPrice) * 100;

    // --- DCA: Check if should add to position ---
    if (dcaPlan && dcaPlan.nextStep && !dcaPlan.paused) {
      const step = dcaPlan.nextStep;

      if (direction === 'LONG' && currentPrice > entryPrice * (1 + step.confirmThreshold)) {
        // Price confirmed direction, add position
        this.log(`📈 [${asset}] DCA Step ${step.num}: price confirmed +${(step.confirmThreshold * 100).toFixed(1)}%, adding ${step.percent}%`);
        // TODO: Execute addToPosition via GaleonRouter
        posData.dcaPlan.nextStep = dcaPlan.steps.shift() || null;
      } else if (direction === 'LONG' && currentPrice < entryPrice * 0.995) {
        // Price went wrong direction, pause DCA
        this.log(`⏸️ [${asset}] DCA paused: price dropped below entry`);
        posData.dcaPlan.paused = true;
      }
    }

    // --- Take Profit: Check partial exits ---
    if (tpPlan && tpPlan.levels.length > 0) {
      const nextTP = tpPlan.levels[0];
      if (pnlPercent >= nextTP.triggerPercent) {
        this.log(`💰 [${asset}] TP${nextTP.level} hit at +${pnlPercent.toFixed(1)}%: sell ${nextTP.exitPercent}%`);
        // TODO: Execute partialExit via GaleonRouter
        tpPlan.levels.shift();

        // Move SL to breakeven after TP1
        if (nextTP.level === 1) {
          posData.stopLossPrice = entryPrice;
          this.log(`🛡️ [${asset}] SL moved to breakeven after TP1`);
        }
      }
    }

    // --- Stop Loss ---
    if (posData.stopLossPrice) {
      const slHit = direction === 'LONG'
        ? currentPrice <= posData.stopLossPrice
        : currentPrice >= posData.stopLossPrice;

      if (slHit) {
        this.log(`🛑 [${asset}] Stop loss triggered at ${currentPrice}`);
        // TODO: Execute emergencyExit via GaleonRouter
        this.activeMicroPositions.delete(positionId);
        return;
      }
    }

    // --- Fatal Combo Check: Emergency exit ---
    if (posData.lastComboCheck && Date.now() - posData.lastComboCheck < 30000) return; // Check every 30s
    posData.lastComboCheck = Date.now();

    const quickScore = await this.votingSystem.scoreSymbol(asset + 'USDT', marketData);
    if (quickScore && quickScore.reason && quickScore.reason.includes('FATAL')) {
      this.log(`🚨 [${asset}] Fatal Combo detected while holding! Emergency exit.`);
      // TODO: Execute emergencyExit via GaleonRouter
      this.activeMicroPositions.delete(positionId);
    }
  }

  // ========================================================
  // MICRO-EXECUTION: Start a new position
  // ========================================================

  /**
   * Register a new micro-position for monitoring
   *
   * @param {number} positionId - On-chain position ID from GaleonRouter
   * @param {string} asset - Token symbol
   * @param {string} direction - 'LONG' or 'SHORT'
   * @param {number} totalAmount - Total planned amount (USDC)
   * @param {number} avgEntryPrice - Initial entry price
   * @param {object} votingResult - VotingSystem result
   */
  registerMicroPosition(positionId, asset, direction, totalAmount, avgEntryPrice, votingResult) {
    // Build DCA plan: 30% → 30% → 40%
    const dcaPlan = {
      steps: [
        { num: 2, percent: 30, amount: Math.round(totalAmount * 0.3), confirmThreshold: 0.003 },
        { num: 3, percent: 40, amount: Math.round(totalAmount * 0.4), confirmThreshold: 0.005 },
      ],
      nextStep: null, // Will be set after step 1 completes
      paused: false,
    };
    dcaPlan.nextStep = dcaPlan.steps.shift();

    // Build TP plan: +5% → +10% → +15%
    const tpPlan = {
      levels: [
        { level: 1, triggerPercent: 5, exitPercent: 30 },
        { level: 2, triggerPercent: 10, exitPercent: 30 },
        { level: 3, triggerPercent: 15, exitPercent: 40 },
      ],
    };

    // Calculate SL from voting result
    const stopLossPrice = votingResult.sl || (
      direction === 'LONG'
        ? avgEntryPrice * 0.92
        : avgEntryPrice * 1.08
    );

    this.activeMicroPositions.set(positionId, {
      asset,
      direction,
      totalAmount,
      avgEntryPrice,
      stopLossPrice,
      dcaPlan,
      tpPlan,
      votingResult,
      lastComboCheck: 0,
      registeredAt: Date.now(),
    });

    this.log(`📝 Micro-position #${positionId} registered: ${asset} ${direction} $${totalAmount} @ ${avgEntryPrice}`);
  }

  // ========================================================
  // QUERY METHODS (for Brain Link API)
  // ========================================================

  /**
   * Get latest decision for an asset (from cache)
   */
  getDecision(asset) {
    return this.latestDecisions.get(asset) || null;
  }

  /**
   * Get all active decisions
   */
  getAllDecisions() {
    const result = [];
    for (const [asset, data] of this.latestDecisions) {
      result.push({ asset, ...data });
    }
    return result;
  }

  /**
   * Get active micro-positions
   */
  getActiveMicroPositions() {
    const result = [];
    for (const [positionId, data] of this.activeMicroPositions) {
      result.push({ positionId, ...data });
    }
    return result;
  }

  /**
   * Get micro-execution plan preview for a proposed trade
   */
  getMicroPlan(asset, amount, direction) {
    return {
      asset,
      totalAmount: amount,
      direction,
      steps: [
        { step: 1, type: 'DCA_IN', percent: 30, amount: Math.round(amount * 0.3), condition: 'Immediate' },
        { step: 2, type: 'DCA_IN', percent: 30, amount: Math.round(amount * 0.3), condition: 'Price confirms +0.3-0.5%' },
        { step: 3, type: 'DCA_IN', percent: 40, amount: Math.round(amount * 0.4), condition: 'Momentum holds' },
        { step: 4, type: 'PARTIAL_TP', percent: 30, condition: '+5%, SL → breakeven' },
        { step: 5, type: 'PARTIAL_TP', percent: 30, condition: '+10%, SL → TP1' },
        { step: 6, type: 'FULL_EXIT', percent: 40, condition: '+15% or reversal signal' },
      ],
      safety: `Price reverses before Step 2 → only $${Math.round(amount * 0.3)} at risk`,
      estimatedGas: '$0.02',
      note: 'Only possible on Monad (0.8s blocks, near-zero gas)',
    };
  }
}

module.exports = BrainOracleService;
