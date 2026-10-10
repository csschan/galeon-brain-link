/**
 * MonadAutoTradeService
 *
 * Connects Galeon Brain signals to real Kuru DEX trading on Monad.
 * Reuses existing Brain logic:
 *   - GainerScanner → VotingSystem → signal generation
 *   - ExitMonitor logic → TP/SL monitoring
 *   - RiskController → position limits
 *   - LearningEngine → trade learning
 *
 * Flow:
 *   Brain signal LONG MON 76% →
 *     KuruSwapService.buyMON($0.5) →
 *       Monitor price every 30s →
 *         TP hit → KuruSwapService.sellMON() →
 *           BrainOracle.recordEndorsedTrade() + settleTrade()
 */

const KuruSwapService = require('./KuruSwapService');
const BrainOracleService = require('./BrainOracleService');
const DatabaseService = require('../databaseService');
const BaseAgent = require('./core/BaseAgent');
const AgentBus = require('./core/AgentBus');

class MonadAutoTradeService extends BaseAgent {
  constructor(brainOracle, learningEngine, votingSystem) {
    super('Monad Trader', 'monad-trader');
    AgentBus.register(this);

    this.brainOracle = brainOracle;
    this.learningEngine = learningEngine;
    this.votingSystem = votingSystem;
    this.kuruSwap = KuruSwapService;

    // Active positions
    this.positions = new Map(); // positionId → { ... }
    this.positionCounter = 0;

    // Config
    this.config = {
      tradeAmountUsdc: 0.5,        // $0.5 initial entry
      dcaAmountUsdc: 0.15,         // $0.15 per DCA step
      dcaMaxSteps: 2,              // Max 2 DCA additions
      dcaConfirmPercent: 0.3,      // DCA when price up +0.3% from entry
      dcaConfirmPercent2: 0.8,     // DCA2 when price up +0.8% from entry
      maxPositions: 3,              // Max concurrent positions
      tp1Percent: 3,                // TP1 at +3% → sell 30%
      tp2Percent: 5,                // TP2 at +5% → sell 30%
      tp3Percent: 8,                // TP3 at +8% → sell remaining
      tp1SellPercent: 0.3,          // 30%
      tp2SellPercent: 0.3,          // 30% (of remaining = ~42%)
      slPercent: -5,                // SL at -5%
      monitorIntervalMs: 30000,     // Check price every 30s
      minScoreToTrade: 6,           // Minimum voting score
      minConfidence: 60,            // Minimum confidence
    };

    // Registered user wallets for auto-trade
    this.users = new Set(); // wallet addresses

    // GaleonRouter V2 contract for executeSwapFor
    this.routerContract = null;

    this.monitorInterval = null;
    this.initialized = false;
  }

  async initialize() {
    try {
      await this.kuruSwap.initialize();

      // Init GaleonRouter V2 contract
      const { ethers } = require('ethers');
      const chainConfig = require('../../config/chains');
      const contractsConfig = require('../../config/contracts');
      if (contractsConfig.Monad?.GaleonRouter && this.brainOracle?.wallet) {
        this.routerContract = new ethers.Contract(
          contractsConfig.Monad.GaleonRouter,
          [
            'function pullFundsForTrade(address,address,uint256,uint256) returns (uint256)',
            'function isUserAuthorized(address,uint256) view returns (bool)',
            'function getUserAuth(address) view returns (bool,uint256,uint256,uint256,uint256)',
          ],
          this.brainOracle.wallet
        );
        this.log(`   Router V2: ${contractsConfig.Monad.GaleonRouter}`);
      }

      // Load registered users from database
      await this._loadUsers();

      // Restore positions from database
      await this._restorePositions();

      this.initialized = true;
      this.log('✅ MonadAutoTradeService initialized');
      this.log(`   Config: $${this.config.tradeAmountUsdc}/trade, DCA $${this.config.dcaAmountUsdc}x${this.config.dcaMaxSteps}, max ${this.config.maxPositions} positions`);
      this.log(`   TP1: +${this.config.tp1Percent}%, TP2: +${this.config.tp2Percent}%, SL: ${this.config.slPercent}%`);
      this.log(`   Users: ${this.users.size} | Positions: ${this.positions.size}`);
    } catch (e) {
      this.log(`❌ Init failed: ${e.message}`);
    }
  }

  async _loadUsers() {
    try {
      const rows = await DatabaseService.query('SELECT wallet_address FROM monad_auto_trade_users WHERE enabled = 1');
      for (const row of rows) {
        this.users.add(row.wallet_address.toLowerCase());
      }
    } catch (e) { /* table may not exist yet */ }
  }

  addUser(walletAddress) {
    this.users.add(walletAddress.toLowerCase());
    this.log(`📝 User registered: ${walletAddress.slice(0, 10)}...`);
  }

  /**
   * Save position to database (called after open, DCA, partial exit, close)
   */
  async _savePosition(pos) {
    try {
      await DatabaseService.query(
        `INSERT INTO monad_positions (position_id, asset, direction, status, entry_price, mon_amount, usdc_invested,
         tp1_price, tp2_price, sl_price, tp1_hit, dca_step, dca_max_steps,
         decision_id, trade_id, entry_tx_hash, voting_json, opened_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, FROM_UNIXTIME(?/1000), NOW())
        ON DUPLICATE KEY UPDATE
         status=VALUES(status), mon_amount=VALUES(mon_amount), usdc_invested=VALUES(usdc_invested),
         entry_price=VALUES(entry_price), tp1_price=VALUES(tp1_price), tp2_price=VALUES(tp2_price),
         sl_price=VALUES(sl_price), tp1_hit=VALUES(tp1_hit), dca_step=VALUES(dca_step), updated_at=NOW()`,
        [pos.id, pos.asset, pos.direction, pos.status, pos.entryPrice, pos.monAmount, pos.usdcInvested,
         pos.tp1Price, pos.tp2Price, pos.slPrice, pos.tp1Hit ? 1 : 0, pos.dcaStep || 0, pos.dcaMaxSteps || 2,
         pos.decisionId, pos.tradeId, pos.entryTxHash,
         JSON.stringify({ votes: pos.votingResult?.votes?.slice(0, 20) }),
         pos.openedAt]
      );
    } catch (e) {
      this.log(`⚠️ Save position failed: ${e.message}`);
    }
  }

  /**
   * Restore active positions from database after restart
   */
  async _restorePositions() {
    try {
      const rows = await DatabaseService.query(
        `SELECT * FROM monad_positions WHERE status = 'HOLDING' ORDER BY position_id`
      );
      for (const row of rows) {
        const posId = row.position_id;
        let votes = [];
        try { votes = JSON.parse(row.voting_json || '{}').votes || []; } catch(e) {}

        this.positions.set(posId, {
          id: posId,
          asset: row.asset,
          direction: row.direction,
          status: row.status,
          entryPrice: parseFloat(row.entry_price),
          monAmount: parseFloat(row.mon_amount),
          usdcInvested: parseFloat(row.usdc_invested),
          tp1Price: parseFloat(row.tp1_price),
          tp2Price: parseFloat(row.tp2_price),
          tp3Price: parseFloat(row.tp3_price || row.tp2_price * 1.03),
          slPrice: parseFloat(row.sl_price),
          tp1Hit: row.tp1_hit === 1,
          tp2Hit: row.tp2_hit === 1,
          dcaStep: row.dca_step || 0,
          dcaMaxSteps: row.dca_max_steps || 2,
          dcaPriceThresholds: [
            parseFloat(row.entry_price) * (1 + this.config.dcaConfirmPercent / 100),
            parseFloat(row.entry_price) * (1 + this.config.dcaConfirmPercent2 / 100),
          ],
          decisionId: row.decision_id,
          tradeId: row.trade_id,
          entryTxHash: row.entry_tx_hash,
          votingResult: { votes },
          openedAt: new Date(row.opened_at).getTime(),
        });

        if (posId >= this.positionCounter) this.positionCounter = posId + 1;
        this.log(`  Restored position #${posId}: ${row.asset} ${row.direction} ${parseFloat(row.mon_amount).toFixed(2)} MON @ $${parseFloat(row.entry_price).toFixed(6)}`);
      }
    } catch (e) {
      // Table may not exist yet — create it
      if (e.message.includes("doesn't exist")) {
        await this._createPositionTable();
      } else {
        this.log(`⚠️ Restore positions failed: ${e.message}`);
      }
    }
  }

  async _createPositionTable() {
    try {
      await DatabaseService.query(`
        CREATE TABLE IF NOT EXISTS monad_positions (
          position_id INT PRIMARY KEY,
          asset VARCHAR(20) NOT NULL,
          direction VARCHAR(10) NOT NULL,
          status VARCHAR(20) NOT NULL DEFAULT 'HOLDING',
          entry_price DECIMAL(20,8) NOT NULL,
          mon_amount DECIMAL(20,8) NOT NULL,
          usdc_invested DECIMAL(20,8) NOT NULL,
          tp1_price DECIMAL(20,8),
          tp2_price DECIMAL(20,8),
          sl_price DECIMAL(20,8),
          tp1_hit TINYINT(1) DEFAULT 0,
          dca_step INT DEFAULT 0,
          dca_max_steps INT DEFAULT 2,
          decision_id INT,
          trade_id INT,
          entry_tx_hash VARCHAR(100),
          voting_json TEXT,
          total_pnl_bps INT DEFAULT 0,
          closed_reason VARCHAR(20),
          opened_at DATETIME,
          closed_at DATETIME,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          INDEX idx_status (status),
          INDEX idx_asset (asset)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
      `);
      this.log('  Created monad_positions table');
    } catch (e) {
      this.log(`⚠️ Create table failed: ${e.message}`);
    }
  }

  /**
   * Start monitoring: listen for Brain signals + check existing positions
   */
  start() {
    if (!this.initialized) { this.log('⚠️ Not initialized'); return; }

    // Monitor positions periodically
    this.monitorInterval = setInterval(() => this._monitorPositions(), this.config.monitorIntervalMs);
    this.log('🔄 Position monitor started (every ' + this.config.monitorIntervalMs / 1000 + 's)');

    // Listen for Brain signals via AgentBus
    AgentBus.on('brain:decision', (data) => this._onBrainDecision(data));
    this.log('📡 Listening for Brain signals');
  }

  stop() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    this.log('⏹️ Stopped');
  }

  /**
   * Handle a Brain decision — open position if criteria met
   * Called by GainerScanner integration or manually
   */
  async handleSignal(asset, votingResult, evidence = {}) {
    if (!this.initialized) return;

    // Only trade MON on Kuru DEX (ETH/BTC too expensive for $0.5 trades)
    if (asset !== 'MON') return;

    const { direction, score, absScore, confidence, passed } = votingResult;

    // Check if signal qualifies
    if (!passed) { this.log(`[${asset}] Signal not passed (score ${score})`); return; }
    if (direction !== 'LONG') { this.log(`[${asset}] Only LONG supported on Kuru spot`); return; }
    if (absScore < this.config.minScoreToTrade) { this.log(`[${asset}] Score ${absScore} < min ${this.config.minScoreToTrade}`); return; }
    if (confidence < this.config.minConfidence) { this.log(`[${asset}] Confidence ${confidence} < min ${this.config.minConfidence}`); return; }

    // Check position limits
    if (this.positions.size >= this.config.maxPositions) {
      this.log(`[${asset}] Max positions (${this.config.maxPositions}) reached`);
      return;
    }

    // Trade for all registered + authorized users
    if (this.users.size > 0 && this.routerContract) {
      for (const userAddr of this.users) {
        // Check if user already holding this asset
        let alreadyHolding = false;
        for (const [, pos] of this.positions) {
          if (pos.asset === asset && pos.status === 'HOLDING' && pos.trader === userAddr) {
            alreadyHolding = true;
            break;
          }
        }
        if (alreadyHolding) {
          this.log(`[${asset}] User ${userAddr.slice(0, 8)}... already holding`);
          continue;
        }

        // Check on-chain authorization
        try {
          const { ethers } = require('ethers');
          const amountWei = ethers.parseUnits(this.config.tradeAmountUsdc.toString(), 6);
          const authorized = await this.routerContract.isUserAuthorized(userAddr, amountWei);
          if (!authorized) {
            this.log(`[${asset}] User ${userAddr.slice(0, 8)}... not authorized or limit reached`);
            continue;
          }
        } catch (e) {
          this.log(`[${asset}] Auth check failed for ${userAddr.slice(0, 8)}...: ${e.message}`);
          continue;
        }

        await this._openPositionForUser(userAddr, asset, votingResult, evidence);
      }
    }

    // Oracle wallet direct trade — only if no registered users (demo fallback)
    if (this.users.size === 0) {
      let oracleHolding = false;
      for (const [, pos] of this.positions) {
        if (pos.asset === asset && pos.status === 'HOLDING' && pos.trader === 'oracle') {
          oracleHolding = true;
          break;
        }
      }
      if (!oracleHolding) {
        try {
          const balances = await this.kuruSwap.getBalances();
          if (balances.usdc >= this.config.tradeAmountUsdc) {
            await this._openPosition(asset, votingResult, evidence);
          } else {
            this.log(`[${asset}] Oracle wallet insufficient USDC — skipping (no registered users)`);
          }
        } catch (e) {
          this.log(`[${asset}] Oracle balance check failed: ${e.message}`);
        }
      }
    }
  }

  /**
   * Open position FOR a user via GaleonRouter V2 contract
   * User's funds are used (they approved the contract)
   */
  async _openPositionForUser(userAddr, asset, votingResult, evidence) {
    try {
      this.log(`\n🟢 [${asset}] Opening position for user ${userAddr.slice(0, 10)}... — ${votingResult.direction} ${votingResult.confidence}%`);

      const { ethers } = require('ethers');
      const contractsConfig = require('../../config/contracts');
      const USDC = contractsConfig.Monad.USDC;
      const amountWei = ethers.parseUnits(this.config.tradeAmountUsdc.toString(), 6);

      // 1. Publish decision on-chain (skip to save gas unless enabled)
      let decisionId = null;
      if (this.brainOracle && process.env.BRAIN_PUSH_ONCHAIN === 'true') {
        decisionId = await this.brainOracle.publishDecision(asset, votingResult, evidence);
        this.log(`  Decision #${decisionId} on-chain`);
      }

      // 2. Pull USDC from user via GaleonRouter (handles auth check + 0.5% fee)
      this.log(`  Pulling $${this.config.tradeAmountUsdc} from user via Router...`);
      const pullTx = await this.routerContract.pullFundsForTrade(
        userAddr, USDC, amountWei, decisionId || 0,
        { gasLimit: 300000 }
      );
      const pullReceipt = await pullTx.wait();
      this.log(`  Funds pulled (gas: ${pullReceipt.gasUsed})`);

      // 3. Oracle swaps directly on Kuru with received USDC
      const netUsdc = this.config.tradeAmountUsdc * 0.995; // after 0.5% fee
      const buyResult = await this.kuruSwap.buyToken(asset, netUsdc);
      this.log(`  ✅ Bought ${buyResult.monReceived.toFixed(4)} ${asset} @ $${buyResult.entryPrice.toFixed(6)}`);

      const entryPrice = buyResult.entryPrice;
      const monExpected = buyResult.monReceived;
      const receipt = { hash: buyResult.txHash || pullReceipt.hash };
      // 4. Track position
      const posId = this.positionCounter++;
      const tp1Price = entryPrice * (1 + this.config.tp1Percent / 100);
      const tp2Price = entryPrice * (1 + this.config.tp2Percent / 100);
      const tp3Price = entryPrice * (1 + this.config.tp3Percent / 100);
      const slPrice = entryPrice * (1 + this.config.slPercent / 100);

      this.positions.set(posId, {
        id: posId, asset, direction: 'LONG', status: 'HOLDING',
        trader: userAddr,
        entryPrice, monAmount: monExpected,
        usdcInvested: this.config.tradeAmountUsdc,
        tp1Price, tp2Price, tp3Price, slPrice,
        tp1Hit: false, tp2Hit: false,
        dcaStep: 0, dcaMaxSteps: this.config.dcaMaxSteps,
        dcaPriceThresholds: [
          entryPrice * (1 + this.config.dcaConfirmPercent / 100),
          entryPrice * (1 + this.config.dcaConfirmPercent2 / 100),
        ],
        decisionId, tradeId: null,
        entryTxHash: receipt.hash,
        votingResult, openedAt: Date.now(),
        viaContract: true,
      });

      await this._savePosition(this.positions.get(posId));

      this.log(`  Position #${posId} for ${userAddr.slice(0, 10)}...: entry $${entryPrice.toFixed(6)}, TP1 $${tp1Price.toFixed(6)}`);

      try {
        await DatabaseService.query(
          `INSERT INTO brain_activity_log (event_type, asset, message, data_json) VALUES (?, ?, ?, ?)`,
          ['trade_open', asset, `User ${userAddr.slice(0, 10)}... BUY ${monExpected.toFixed(2)} MON @ $${entryPrice.toFixed(6)} via contract`, JSON.stringify({ posId, userAddr, decisionId, txHash: receipt.hash })]
        );
      } catch (e) { /* non-blocking */ }

    } catch (e) {
      this.log(`  ❌ Open for user failed: ${e.message}`);
    }
  }

  /**
   * Open a new position on Kuru (Oracle wallet, direct swap)
   */
  async _openPosition(asset, votingResult, evidence) {
    try {
      this.log(`\n🟢 [${asset}] Opening position — ${votingResult.direction} ${votingResult.confidence}%`);

      // 1. Publish decision on-chain
      let decisionId = null;
      if (this.brainOracle) {
        decisionId = await this.brainOracle.publishDecision(asset, votingResult, evidence);
        this.log(`  Decision #${decisionId} on-chain`);
      }

      // 2. Buy on Kuru
      const buyResult = await this.kuruSwap.buyToken(asset, this.config.tradeAmountUsdc);
      this.log(`  ✅ Bought ${buyResult.monReceived.toFixed(4)} MON @ $${buyResult.entryPrice.toFixed(6)}`);

      // 3. Record AI-Endorsed Trade on-chain (skip to save gas unless explicitly enabled)
      let tradeId = null;
      if (this.brainOracle && decisionId !== null && process.env.BRAIN_PUSH_ONCHAIN === 'true') {
        const { ethers } = require('ethers');
        const brain = new ethers.Contract(
          require('../../config/contracts').Monad.GaleonBrain,
          ['function recordEndorsedTrade(address,address,uint256,uint256) returns (uint256)', 'function endorsedTradeCount() view returns (uint256)'],
          this.brainOracle.wallet
        );
        const tx = await brain.recordEndorsedTrade(
          this.brainOracle.wallet.address,
          '0x0000000000000000000000000000000000000000',
          ethers.parseUnits(this.config.tradeAmountUsdc.toString(), 6),
          decisionId
        );
        await tx.wait();
        tradeId = Number(await brain.endorsedTradeCount()) - 1;
        this.log(`  AI-Endorsed Trade #${tradeId} on-chain`);
      }

      // 4. Track position
      const posId = this.positionCounter++;
      const tp1Price = buyResult.entryPrice * (1 + this.config.tp1Percent / 100);
      const tp2Price = buyResult.entryPrice * (1 + this.config.tp2Percent / 100);
      const tp3Price = buyResult.entryPrice * (1 + this.config.tp3Percent / 100);
      const slPrice = buyResult.entryPrice * (1 + this.config.slPercent / 100);

      this.positions.set(posId, {
        id: posId,
        asset,
        direction: 'LONG',
        status: 'HOLDING',
        trader: 'oracle', // Oracle wallet direct trade
        entryPrice: buyResult.entryPrice,
        monAmount: buyResult.monReceived,
        usdcInvested: this.config.tradeAmountUsdc,
        tp1Price, tp2Price, tp3Price, slPrice,
        tp1Hit: false,
        tp2Hit: false,
        // DCA tracking
        dcaStep: 0,                    // 0 = initial buy done, 1 = first DCA done, 2 = all done
        dcaMaxSteps: this.config.dcaMaxSteps,
        dcaPriceThresholds: [
          buyResult.entryPrice * (1 + this.config.dcaConfirmPercent / 100),   // DCA1 trigger
          buyResult.entryPrice * (1 + this.config.dcaConfirmPercent2 / 100),  // DCA2 trigger
        ],
        //
        decisionId,
        tradeId,
        entryTxHash: buyResult.txHash,
        votingResult,
        openedAt: Date.now(),
      });

      this.log(`  Position #${posId}: entry $${buyResult.entryPrice.toFixed(6)}, TP1 $${tp1Price.toFixed(6)}, SL $${slPrice.toFixed(6)}`);

      // 5. Persist position + activity log
      await this._savePosition(this.positions.get(posId));
      try {
        await DatabaseService.query(
          `INSERT INTO brain_activity_log (event_type, asset, message, data_json) VALUES (?, ?, ?, ?)`,
          ['trade_open', asset, `BUY ${buyResult.monReceived.toFixed(2)} MON @ $${buyResult.entryPrice.toFixed(6)} | DCA 0/${this.config.dcaMaxSteps}`, JSON.stringify({ posId, decisionId, tradeId, ...buyResult })]
        );
      } catch (e) { /* non-blocking */ }

      return posId;
    } catch (e) {
      this.log(`  ❌ Open position failed: ${e.message}`);
      return null;
    }
  }

  /**
   * Monitor all active positions — check DCA / TP / SL
   */
  async _monitorPositions() {
    if (this.positions.size === 0) return;

    try {
      // Get prices for all held assets
      const priceCache = {};
      for (const [, pos] of this.positions) {
        if (pos.status === 'HOLDING' && !priceCache[pos.asset]) {
          priceCache[pos.asset] = await this.kuruSwap.getTokenPrice(pos.asset);
          // Rate limit between price fetches
          if (Object.keys(priceCache).length > 1) await new Promise(r => setTimeout(r, 1500));
        }
      }

      for (const [posId, pos] of this.positions) {
        if (pos.status !== 'HOLDING') continue;

        const currentPrice = priceCache[pos.asset];
        if (!currentPrice) continue;

        const pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

        // ═══ DCA: Add to position if price confirms direction ═══
        if (pos.dcaStep < pos.dcaMaxSteps && !pos.tp1Hit) {
          const threshold = pos.dcaPriceThresholds[pos.dcaStep];
          if (currentPrice >= threshold) {
            this.log(`\n📈 [${pos.asset}] DCA Step ${pos.dcaStep + 1}: price confirmed at $${currentPrice.toFixed(6)} (+${pnlPercent.toFixed(2)}%)`);
            await this._executeDCA(posId, currentPrice);
            continue;
          }
        }

        // ═══ TP1: Sell 30% ═══
        if (!pos.tp1Hit && pnlPercent >= this.config.tp1Percent) {
          this.log(`\n💰 [${pos.asset}] TP1 hit! +${pnlPercent.toFixed(2)}% (price $${currentPrice.toFixed(6)})`);
          const success = await this._partialExit(posId, this.config.tp1SellPercent, 'TP1', pnlPercent);
          if (success) {
            pos.tp1Hit = true;
            pos.slPrice = pos.entryPrice; // SL → breakeven
            await this._savePosition(pos);
            this.log(`  SL moved to breakeven: $${pos.slPrice.toFixed(6)}`);
          } else {
            this.log(`  ⚠️ TP1 sell failed, will retry next cycle`);
          }
          continue;
        }

        // ═══ TP2: Sell 30% of remaining ═══
        if (pos.tp1Hit && !pos.tp2Hit && pnlPercent >= this.config.tp2Percent) {
          this.log(`\n💰💰 [${pos.asset}] TP2 hit! +${pnlPercent.toFixed(2)}% (price $${currentPrice.toFixed(6)})`);
          const sellRatio = this.config.tp2SellPercent / (1 - this.config.tp1SellPercent);
          const success = await this._partialExit(posId, sellRatio, 'TP2', pnlPercent);
          if (success) {
            pos.tp2Hit = true;
            pos.slPrice = pos.entryPrice * (1 + this.config.tp1Percent / 100);
            await this._savePosition(pos);
            this.log(`  SL moved to TP1 level: $${pos.slPrice.toFixed(6)}`);
          } else {
            this.log(`  ⚠️ TP2 sell failed, will retry next cycle`);
          }
          continue;
        }

        // ═══ TP3: Sell all remaining ═══
        if (pos.tp2Hit && pnlPercent >= this.config.tp3Percent) {
          this.log(`\n💰💰💰 [${pos.asset}] TP3 hit! +${pnlPercent.toFixed(2)}%`);
          await this._closePosition(posId, 'TP3', pnlPercent);
          continue;
        }

        // ═══ SL: Stop loss ═══
        if (pnlPercent <= this.config.slPercent || ((pos.tp1Hit || pos.tp2Hit) && currentPrice <= pos.slPrice)) {
          this.log(`\n🛑 [${pos.asset}] SL hit! ${pnlPercent.toFixed(2)}% (price $${currentPrice.toFixed(6)})`);
          await this._closePosition(posId, 'SL', pnlPercent);
          continue;
        }

        // Log status
        const tpStatus = pos.tp2Hit ? 'TP2 hit, trailing' : pos.tp1Hit ? 'TP1 hit' : '';
        const dcaInfo = pos.dcaStep < (pos.dcaMaxSteps || 0) ? ` DCA ${pos.dcaStep}/${pos.dcaMaxSteps}` : '';
        this.log(`  [${pos.asset}] #${posId}: $${currentPrice.toFixed(6)} PnL ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}%${tpStatus ? ' (' + tpStatus + ')' : ''}${dcaInfo} | ${pos.monAmount.toFixed(2)} MON`);

        // Write activity every 5 minutes or on significant price change
        const now = Date.now();
        const lastActivity = pos._lastActivityLog || 0;
        const lastPnl = pos._lastPnlLog || 0;
        const pnlChanged = Math.abs(pnlPercent - lastPnl) >= 0.5; // +/- 0.5% change
        const timeElapsed = now - lastActivity >= 300000; // 5 min

        if (pnlChanged || timeElapsed) {
          pos._lastActivityLog = now;
          pos._lastPnlLog = pnlPercent;
          const { addActivity } = require('../../controllers/brainLinkController');
          if (addActivity) {
            const nextTp = !pos.tp1Hit ? `TP1 $${pos.tp1Price.toFixed(6)} (+3%)`
              : !pos.tp2Hit ? `TP2 $${pos.tp2Price.toFixed(6)} (+5%)`
              : `TP3 $${(pos.tp3Price || pos.tp2Price * 1.03).toFixed(6)} (+8%)`;
            addActivity('monitor', pos.asset,
              `Price $${currentPrice.toFixed(6)} | PnL ${pnlPercent >= 0 ? '+' : ''}${pnlPercent.toFixed(2)}% | ${pos.monAmount.toFixed(1)} MON | Next: ${nextTp}${tpStatus ? ' | ' + tpStatus : ''}`
            );
          }
        }
      }
    } catch (e) {
      this.log(`⚠️ Monitor error: ${e.message}`);
    }
  }

  /**
   * Execute DCA — buy more at confirmed price
   */
  async _executeDCA(posId, currentPrice) {
    const pos = this.positions.get(posId);
    if (!pos) return;

    try {
      const dcaAmount = this.config.dcaAmountUsdc;

      // Check USDC balance
      const balances = await this.kuruSwap.getBalances();
      if (balances.usdc < dcaAmount) {
        this.log(`  ⚠️ DCA skipped: insufficient USDC ($${balances.usdc.toFixed(2)} < $${dcaAmount})`);
        pos.dcaStep = pos.dcaMaxSteps; // Stop trying
        return;
      }

      // Wait for rate limit
      await new Promise(r => setTimeout(r, 1500));

      // Buy more MON
      const buyResult = await this.kuruSwap.buyToken(pos.asset, dcaAmount);
      this.log(`  ✅ DCA: +${buyResult.monReceived.toFixed(4)} MON @ $${buyResult.entryPrice.toFixed(6)} ($${dcaAmount})`);

      // Update position
      const oldTotal = pos.usdcInvested;
      pos.usdcInvested += dcaAmount;
      pos.monAmount += buyResult.monReceived;
      // Recalculate avg entry price
      pos.entryPrice = pos.usdcInvested / pos.monAmount;
      pos.dcaStep++;

      // Recalculate TP/SL based on new avg entry
      pos.tp1Price = pos.entryPrice * (1 + this.config.tp1Percent / 100);
      pos.tp2Price = pos.entryPrice * (1 + this.config.tp2Percent / 100);
      pos.slPrice = pos.entryPrice * (1 + this.config.slPercent / 100);

      this.log(`  Avg entry: $${pos.entryPrice.toFixed(6)} | Total: $${pos.usdcInvested.toFixed(2)} | ${pos.monAmount.toFixed(2)} MON`);
      this.log(`  New TP1: $${pos.tp1Price.toFixed(6)}, SL: $${pos.slPrice.toFixed(6)}`);

      // Record micro-step on-chain
      if (this.brainOracle && pos.tradeId !== null) {
        try {
          const { ethers } = require('ethers');
          const brain = new ethers.Contract(
            require('../../config/contracts').Monad.GaleonBrain,
            ['function incrementMicroStep(uint256)'],
            this.brainOracle.wallet
          );
          await (await brain.incrementMicroStep(pos.tradeId)).wait();
          this.log(`  Micro-step DCA${pos.dcaStep} recorded on-chain`);
        } catch (e) { /* non-blocking */ }
      }

      // Persist + log
      await this._savePosition(pos);
      try {
        await DatabaseService.query(
          `INSERT INTO brain_activity_log (event_type, asset, message, data_json) VALUES (?, ?, ?, ?)`,
          ['dca_buy', pos.asset, `DCA Step ${pos.dcaStep}: +${buyResult.monReceived.toFixed(2)} MON @ $${buyResult.entryPrice.toFixed(6)} ($${dcaAmount}). Total: $${pos.usdcInvested.toFixed(2)}`, JSON.stringify({ posId, dcaStep: pos.dcaStep, ...buyResult })]
        );
      } catch (e) { /* non-blocking */ }

    } catch (e) {
      this.log(`  ❌ DCA failed: ${e.message}`);
    }
  }

  /**
   * Partial exit — sell a percentage of position
   * Returns true on success, false on failure (for retry)
   */
  async _partialExit(posId, sellPercent, reason, pnlPercent) {
    const pos = this.positions.get(posId);
    if (!pos) return false;

    try {
      const sellAmount = pos.monAmount * sellPercent;
      this.log(`  Selling ${(sellPercent * 100).toFixed(0)}%: ${sellAmount.toFixed(4)} MON`);

      // Wait for rate limit + add buffer
      await new Promise(r => setTimeout(r, 3000));

      const sellResult = await this.kuruSwap.sellToken(pos.asset, sellAmount);
      this.log(`  ✅ Sold for $${sellResult.usdcReceived.toFixed(4)}`);

      // Transfer USDC back to user if this is a user position
      if (pos.trader && pos.trader !== 'oracle' && sellResult.usdcReceived > 0) {
        await this._sendUsdcToUser(pos.trader, sellResult.usdcReceived);
        this.log(`  💸 Sent $${sellResult.usdcReceived.toFixed(4)} USDC back to ${pos.trader.slice(0, 10)}...`);
      }

      // Update position
      pos.monAmount -= sellAmount;
      pos.realizedUsdc = (pos.realizedUsdc || 0) + sellResult.usdcReceived;

      // Record micro-step on-chain
      if (this.brainOracle && pos.tradeId !== null) {
        const { ethers } = require('ethers');
        const brain = new ethers.Contract(
          require('../../config/contracts').Monad.GaleonBrain,
          ['function incrementMicroStep(uint256)'],
          this.brainOracle.wallet
        );
        await (await brain.incrementMicroStep(pos.tradeId)).wait();
        this.log(`  Micro-step recorded on-chain`);
      }

      // Persist + log
      await this._savePosition(pos);
      try {
        await DatabaseService.query(
          `INSERT INTO brain_activity_log (event_type, asset, message, data_json) VALUES (?, ?, ?, ?)`,
          ['partial_exit', pos.asset, `${reason}: sold ${sellAmount.toFixed(2)} MON for $${sellResult.usdcReceived.toFixed(4)} (+${pnlPercent.toFixed(1)}%) | Fee: $${(sellResult.fee || 0).toFixed(4)}`, JSON.stringify({ posId, reason, sellAmount, ...sellResult })]
        );
      } catch (e) { /* non-blocking */ }
      return true;
    } catch (e) {
      this.log(`  ❌ Partial exit failed: ${e.message}`);
      return false;
    }
  }

  /**
   * Close position completely
   */
  async _closePosition(posId, reason, pnlPercent) {
    const pos = this.positions.get(posId);
    if (!pos) return;

    try {
      let usdcReceived = 0;

      if (pos.monAmount > 0.01) {
        // Wait rate limit
        await new Promise(r => setTimeout(r, 1500));

        const sellResult = await this.kuruSwap.sellToken(pos.asset, pos.monAmount);
        usdcReceived = sellResult.usdcReceived;
        this.log(`  ✅ Closed: ${pos.monAmount.toFixed(4)} MON → $${usdcReceived.toFixed(4)}`);

        // Transfer USDC back to user
        if (pos.trader && pos.trader !== 'oracle' && usdcReceived > 0) {
          await this._sendUsdcToUser(pos.trader, usdcReceived);
          this.log(`  💸 Sent $${usdcReceived.toFixed(4)} USDC back to ${pos.trader.slice(0, 10)}...`);
        }
      }

      const totalReceived = (pos.realizedUsdc || 0) + usdcReceived;
      const totalPnl = totalReceived - pos.usdcInvested;
      const totalPnlBps = Math.round((totalPnl / pos.usdcInvested) * 10000);

      pos.status = 'CLOSED';
      pos.closedAt = Date.now();
      pos.totalPnl = totalPnl;
      pos.totalPnlBps = totalPnlBps;

      this.log(`  PnL: $${totalPnl.toFixed(4)} (${totalPnlBps} bps)`);

      // Settle on-chain
      if (this.brainOracle && pos.tradeId !== null) {
        const { ethers } = require('ethers');
        const brain = new ethers.Contract(
          require('../../config/contracts').Monad.GaleonBrain,
          ['function incrementMicroStep(uint256)', 'function settleTrade(uint256,int256)'],
          this.brainOracle.wallet
        );
        await (await brain.incrementMicroStep(pos.tradeId)).wait();
        await (await brain.settleTrade(pos.tradeId, totalPnlBps)).wait();
        this.log(`  ✅ Settled on-chain: Trade #${pos.tradeId}, PnL ${totalPnlBps} bps`);
      }

      // Persist closed state + log
      pos.closedReason = reason;
      await this._savePosition(pos);
      try {
        await DatabaseService.query(
          `UPDATE monad_positions SET status='CLOSED', total_pnl_bps=?, closed_reason=?, closed_at=NOW() WHERE position_id=?`,
          [totalPnlBps, reason, posId]
        );
      } catch (e) { /* non-blocking */ }
      try {
        await DatabaseService.query(
          `INSERT INTO brain_activity_log (event_type, asset, message, data_json) VALUES (?, ?, ?, ?)`,
          ['trade_close', pos.asset, `${reason}: PnL $${totalPnl.toFixed(4)} (${totalPnlBps} bps)`, JSON.stringify({ posId, reason, totalReceived, totalPnl, totalPnlBps })]
        );
      } catch (e) { /* non-blocking */ }

      this.log(`  Position #${posId} closed.`);
    } catch (e) {
      this.log(`  ❌ Close failed: ${e.message}`);
    }
  }

  /**
   * Called by GainerScanner when a new signal is generated
   */
  async _onBrainDecision(data) {
    if (!data || !data.asset || !data.votingResult) return;
    await this.handleSignal(data.asset, data.votingResult, data.evidence || {});
  }

  /**
   * Get all positions (for API)
   */
  getPositions() {
    const result = [];
    for (const [, pos] of this.positions) {
      result.push({ ...pos });
    }
    return result;
  }

  /**
   * Get active positions only
   */
  getActivePositions() {
    return this.getPositions().filter(p => p.status === 'HOLDING');
  }

  /**
   * Send USDC from Oracle wallet to user after selling tokens
   */
  async _sendUsdcToUser(userAddr, usdcAmount) {
    try {
      const { ethers } = require('ethers');
      const contractsConfig = require('../../config/contracts');
      const USDC = contractsConfig.Monad.USDC;
      const usdc = new ethers.Contract(USDC, [
        'function transfer(address,uint256) returns (bool)',
      ], this.brainOracle.wallet);
      const amountWei = ethers.parseUnits(usdcAmount.toFixed(6), 6);
      const tx = await usdc.transfer(userAddr, amountWei, { gasLimit: 100000 });
      await tx.wait();
    } catch (e) {
      this.log(`  ⚠️ USDC transfer to user failed: ${e.message}`);
    }
  }
}

module.exports = MonadAutoTradeService;
