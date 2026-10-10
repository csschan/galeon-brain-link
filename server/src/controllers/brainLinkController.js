/**
 * Brain Link Controller
 *
 * Handles all Brain Link API requests.
 * Data comes from: BrainOracleService (cache), VotingSystem, LearningEngine, MarketDataCache, DB.
 */

const DatabaseService = require('../services/databaseService');

// These will be injected during server startup
let brainOracle = null;
let votingSystem = null;
let learningEngine = null;
let marketDataCache = null;

// Activity log (in-memory ring buffer)
const activityLog = [];
const MAX_ACTIVITY = 100;

function addActivity(type, asset, message, data = {}) {
  activityLog.unshift({
    type, asset, message, data,
    timestamp: Date.now(),
  });
  if (activityLog.length > MAX_ACTIVITY) activityLog.pop();
}

/**
 * Initialize controller with service references
 * Called from server.js after services are initialized
 */
function initBrainLinkController(services) {
  brainOracle = services.brainOracle;
  votingSystem = services.votingSystem;
  learningEngine = services.learningEngine;
  marketDataCache = services.marketDataCache;
}

// ========== Decision Queries ==========

async function getAllDecisions(req, res) {
  try {
    if (!brainOracle) return res.json({ decisions: [] });

    const decisions = brainOracle.getAllDecisions().map(d => ({
      asset: d.asset,
      direction: d.votingResult?.direction || 'WAIT',
      confidence: d.votingResult?.confidence || 0,
      score: d.votingResult?.score || 0,
      passed: d.votingResult?.passed || false,
      decisionId: d.decisionId,
      timestamp: d.timestamp,
      similarSetups: d.evidence?.similarSetups || 0,
      winRate: d.evidence?.winRate || 0,
      price: d.votingResult?.price || 0,
    }));

    // Fetch sparkline data for each token (24h price history)
    const axios = require('axios');
    for (const d of decisions) {
      try {
        const symbol = (d.asset === 'MON' ? 'MON' : d.asset) + 'USDT';
        const resp = await axios.get('https://fapi.binance.com/fapi/v1/klines', {
          params: { symbol, interval: '1h', limit: 24 },
          timeout: 3000,
        });
        d.sparkline = resp.data.map(k => parseFloat(k[4])); // close prices
      } catch (e) {
        d.sparkline = null;
      }
    }

    res.json({ decisions });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function getDecision(req, res) {
  try {
    const { asset } = req.params;

    // Try cache first
    let decision = brainOracle?.getDecision(asset);

    // If not in cache, run live scoring
    if (!decision && votingSystem) {
      const symbol = asset.endsWith('USDT') ? asset : asset + 'USDT';
      const btcContext = marketDataCache ? marketDataCache.getBtcContext() : {};
      const votingResult = await votingSystem.scoreSymbol(symbol, null, btcContext);

      // Get historical evidence
      let evidence = {};
      if (learningEngine) {
        const historyVotes = await learningEngine.getTokenHistoryVotes(symbol, votingResult.direction, {});
        evidence = {
          similarSetups: historyVotes?.length || 0,
          winRate: historyVotes?.filter(v => v.score > 0).length / (historyVotes?.length || 1) * 100,
        };
      }

      decision = { votingResult, evidence, decisionId: null, timestamp: Date.now() };
    }

    if (!decision) {
      return res.json({ error: 'No decision available', asset });
    }

    const vr = decision.votingResult;
    res.json({
      asset,
      direction: vr.direction || 'WAIT',
      confidence: vr.confidence || 0,
      score: vr.score || 0,
      absScore: vr.absScore || 0,
      passed: vr.passed || false,
      leverage: vr.leverage || 0,
      riskLevel: vr.confidence >= 70 ? 'LOW' : vr.confidence >= 55 ? 'MEDIUM' : 'HIGH',
      reasoning: translateToEN(_buildReasoning(vr)),
      price: vr.price || 0,
      entryZone: { min: vr.price * 0.995, max: vr.price * 1.005 },
      stopLoss: vr.sl || 0,
      takeProfit1: vr.tp1 || 0,
      takeProfit2: vr.tp2 || 0,
      takeProfit3: vr.tp3 || 0,
      similarSetups: decision.evidence?.similarSetups || 0,
      winRate: Math.round(decision.evidence?.winRate || 0),
      decisionId: decision.decisionId,
      timestamp: decision.timestamp,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function getDecisionDetail(req, res) {
  try {
    const { asset } = req.params;
    const decision = brainOracle?.getDecision(asset);

    if (!decision) {
      return res.json({ error: 'No decision available', asset });
    }

    const vr = decision.votingResult;

    res.json({
      asset,
      direction: vr.direction,
      score: vr.score,
      absScore: vr.absScore,
      confidence: vr.confidence,
      passed: vr.passed,
      bullVotes: vr.bullVotes || (vr.votes || []).filter(v => v.score > 0).length,
      bearVotes: vr.bearVotes || (vr.votes || []).filter(v => v.score < 0).length,
      consistency: vr.consistency || 0,
      // Full voting breakdown (translated to English)
      votes: (vr.votes || []).map(v => ({
        dimension: CN_TO_EN[v.dim] || v.dim,
        score: v.score,
        reason: translateToEN(v.reason),
        type: v.score > 0 ? 'bullish' : v.score < 0 ? 'bearish' : 'neutral',
      })),
      // Market data snapshot
      marketData: vr.marketData || {},
      // Risk info
      sl: vr.sl,
      tp1: vr.tp1,
      tp2: vr.tp2,
      tp3: vr.tp3,
      leverage: vr.leverage,
      // Evidence
      evidence: decision.evidence,
      decisionId: decision.decisionId,
      timestamp: decision.timestamp,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function getDecisionTimeline(req, res) {
  try {
    const { asset } = req.params;
    const limit = parseInt(req.query.limit) || 20;

    // Query from brain_decision_history table
    const rows = await DatabaseService.query(
      `SELECT * FROM brain_decision_history
       WHERE asset = ? ORDER BY created_at DESC LIMIT ?`,
      [asset, limit]
    );

    res.json({
      asset,
      timeline: rows.map(r => ({
        direction: r.direction,
        score: r.score,
        confidence: r.confidence,
        riskLevel: r.risk_level,
        reasoning: r.reasoning,
        decisionId: r.decision_id,
        timestamp: r.created_at,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ========== Risk Assessment ==========

async function assessRisk(req, res) {
  try {
    const { walletAddress, asset, amount, direction } = req.body;

    if (!asset || !amount) {
      return res.status(400).json({ error: 'asset and amount are required' });
    }

    if (brainOracle) {
      const result = await brainOracle.assessRisk(walletAddress || '', { asset, direction, amount });
      return res.json(result);
    }

    // Fallback: simple risk check without Brain Oracle
    res.json({
      riskScore: 50,
      action: 'PASS',
      suggestedAmount: amount,
      reason: 'Brain Oracle not active, no risk assessment available',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ========== Micro-Execution ==========

async function getMicroPlan(req, res) {
  try {
    const { asset } = req.params;
    const amount = parseFloat(req.query.amount) || 420;
    const direction = req.query.direction || 'LONG';

    if (brainOracle) {
      const plan = brainOracle.getMicroPlan(asset, amount, direction);
      return res.json(plan);
    }

    // Fallback default plan
    res.json({
      asset,
      totalAmount: amount,
      direction,
      steps: [
        { step: 1, type: 'DCA_IN', percent: 30, amount: Math.round(amount * 0.3), condition: 'Immediate' },
        { step: 2, type: 'DCA_IN', percent: 30, amount: Math.round(amount * 0.3), condition: 'Price confirms +0.3-0.5%' },
        { step: 3, type: 'DCA_IN', percent: 40, amount: Math.round(amount * 0.4), condition: 'Momentum holds' },
        { step: 4, type: 'PARTIAL_TP', percent: 30, condition: '+5%, SL to breakeven' },
        { step: 5, type: 'PARTIAL_TP', percent: 30, condition: '+10%, SL to TP1' },
        { step: 6, type: 'FULL_EXIT', percent: 40, condition: '+15% or reversal' },
      ],
      safety: `Price reverses before Step 2: only $${Math.round(amount * 0.3)} at risk`,
      estimatedGas: '$0.02',
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function getMicroPosition(req, res) {
  try {
    const positionId = parseInt(req.params.positionId);

    // Query from micro_execution_steps table
    const steps = await DatabaseService.query(
      `SELECT * FROM micro_execution_steps WHERE position_id = ? ORDER BY step_number`,
      [positionId]
    );

    res.json({ positionId, steps });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function getTraderMicroPositions(req, res) {
  try {
    const { address } = req.params;

    if (brainOracle) {
      const positions = brainOracle.getActiveMicroPositions()
        .filter(p => p.trader === address || !address);
      return res.json({ positions });
    }

    res.json({ positions: [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ========== Chart Data ==========

async function getChartData(req, res) {
  try {
    const { asset } = req.params;
    const symbol = asset.endsWith('USDT') ? asset : asset + 'USDT';
    const interval = req.query.interval || '1h';
    const limit = parseInt(req.query.limit) || 100;

    // Fetch K-line from Binance (reuse existing MarketDataCache pattern)
    const axios = require('axios');
    const response = await axios.get(`https://fapi.binance.com/fapi/v1/klines`, {
      params: { symbol, interval, limit },
      timeout: 5000,
    });

    const candles = response.data.map(k => ({
      time: k[0],
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5]),
    }));

    // Get Brain annotations (decision points from history)
    let annotations = [];
    try {
      const decisions = await DatabaseService.query(
        `SELECT direction, score, confidence, reasoning, created_at
         FROM brain_decision_history
         WHERE asset = ? AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)
         ORDER BY created_at`,
        [asset]
      );
      annotations = decisions.map(d => ({
        time: new Date(d.created_at).getTime(),
        type: d.direction === 'LONG' ? 'BUY' : d.direction === 'SHORT' ? 'SELL' : 'WAIT',
        confidence: d.confidence,
        reasoning: d.reasoning,
      }));
    } catch (e) { /* table may not exist yet */ }

    res.json({ asset, interval, candles, annotations });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ========== Trader History ==========

async function getTraderStats(req, res) {
  try {
    const { address } = req.params;

    // Query from auto_trade_executions for Monad trades
    const rows = await DatabaseService.query(
      `SELECT
        COUNT(*) as totalTrades,
        SUM(CASE WHEN profit_loss_percent > 0 THEN 1 ELSE 0 END) as winCount,
        SUM(profit_loss_usdt) as totalPnl,
        AVG(profit_loss_percent) as avgPnlPercent
       FROM auto_trade_executions
       WHERE (user_id = ? OR user_id IN (
         SELECT user_id FROM auto_trade_config WHERE wallet_address = ?
       ))
       AND chain = 'Monad'
       AND status = 'EXITED'`,
      [address, address]
    );

    const stats = rows[0] || {};
    const totalTrades = stats.totalTrades || 0;
    const winCount = stats.winCount || 0;

    res.json({
      address,
      totalTrades,
      winCount,
      winRate: totalTrades > 0 ? Math.round((winCount / totalTrades) * 100) : 0,
      totalPnl: parseFloat(stats.totalPnl || 0).toFixed(2),
      avgPnlPercent: parseFloat(stats.avgPnlPercent || 0).toFixed(2),
      aiTrustScore: _calculateTrustScore(totalTrades, winCount),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function getTraderTrades(req, res) {
  try {
    const { address } = req.params;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;

    const trades = await DatabaseService.query(
      `SELECT e.*, s.confidence_score, s.signal_source
       FROM auto_trade_executions e
       LEFT JOIN alpha_signals s ON e.signal_id = s.signal_id
       WHERE (e.user_id = ? OR e.user_id IN (
         SELECT user_id FROM auto_trade_config WHERE wallet_address = ?
       ))
       AND e.chain = 'Monad'
       ORDER BY e.created_at DESC
       LIMIT ? OFFSET ?`,
      [address, address, limit, offset]
    );

    // Get micro-steps for each trade
    for (const trade of trades) {
      try {
        const steps = await DatabaseService.query(
          `SELECT * FROM micro_execution_steps WHERE position_id = ? ORDER BY step_number`,
          [trade.execution_id]
        );
        trade.microSteps = steps;
      } catch (e) {
        trade.microSteps = [];
      }
    }

    res.json({ address, page, limit, trades });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ========== Brain Learning ==========

async function getLearningEvolution(req, res) {
  try {
    if (!learningEngine) {
      return res.json({ weights: {}, evolution: [] });
    }

    // Current weights
    const weights = learningEngine.weights || {};

    // Get dimension accuracy from DB
    let dimensionAccuracy = [];
    try {
      dimensionAccuracy = await DatabaseService.query(
        `SELECT dimension_name,
          COUNT(*) as total,
          SUM(CASE WHEN actual_outcome = 'WIN' THEN 1 ELSE 0 END) as wins,
          ROUND(SUM(CASE WHEN actual_outcome = 'WIN' THEN 1 ELSE 0 END) / COUNT(*) * 100, 1) as accuracy
         FROM alpha_learning_logs
         WHERE created_at >= DATE_SUB(NOW(), INTERVAL 30 DAY)
         GROUP BY dimension_name
         ORDER BY accuracy DESC`
      );
    } catch (e) { /* table may not exist */ }

    res.json({
      weights,
      dimensions: dimensionAccuracy,
      totalLearningCycles: learningEngine.lessonBuffer?.length || 0,
      lastUpdate: learningEngine._lastWeightUpdate || null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ========== Activity Feed ==========

async function getActivity(req, res) {
  try {
    const limit = parseInt(req.query.limit) || 30;

    // Combine in-memory + database activity
    let dbActivities = [];
    try {
      const rows = await DatabaseService.query(
        'SELECT event_type, asset, message, data_json, created_at FROM brain_activity_log ORDER BY created_at DESC LIMIT ?',
        [limit]
      );
      dbActivities = rows.map(r => ({
        type: r.event_type,
        asset: r.asset || '',
        message: r.message || '',
        data: {},
        timestamp: new Date(r.created_at).getTime(),
      }));
    } catch (e) { /* table may not exist */ }

    // Merge: in-memory (recent) + db (persistent), deduplicate by timestamp
    const merged = [...activityLog, ...dbActivities]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);

    res.json({
      activities: merged,
      total: merged.length,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ========== Asset-specific Activity ==========

async function getAssetActivity(req, res) {
  try {
    const { asset } = req.params;
    const limit = parseInt(req.query.limit) || 20;

    let activities = [];
    try {
      const rows = await DatabaseService.query(
        'SELECT event_type, asset, message, data_json, created_at FROM brain_activity_log WHERE asset = ? ORDER BY created_at DESC LIMIT ?',
        [asset, limit]
      );
      activities = rows.map(r => ({
        type: r.event_type,
        asset: r.asset || '',
        message: r.message || '',
        data: {},
        timestamp: new Date(r.created_at).getTime(),
      }));
    } catch (e) { /* table may not exist */ }

    // Also include in-memory activities for this asset
    const memActivities = activityLog.filter(a => a.asset === asset);
    const merged = [...memActivities, ...activities]
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);

    res.json({ activities: merged, total: merged.length });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ========== Monad Auto-Trade Positions ==========

async function getMonadPositions(req, res) {
  try {
    if (global.__monadTrader) {
      const positions = global.__monadTrader.getPositions();
      const active = positions.filter(p => p.status === 'HOLDING');

      // Read closed positions from database (not in memory after restart)
      let closed = positions.filter(p => p.status === 'CLOSED');
      try {
        const dbClosed = await DatabaseService.query(
          'SELECT * FROM monad_positions WHERE status = ? ORDER BY closed_at DESC LIMIT 50', ['CLOSED']
        );
        closed = dbClosed.map(r => ({
          id: r.position_id, asset: r.asset, direction: r.direction, status: r.status,
          entryPrice: parseFloat(r.entry_price), monAmount: parseFloat(r.mon_amount),
          usdcInvested: parseFloat(r.usdc_invested), totalPnlBps: r.total_pnl_bps || 0,
          closedReason: r.closed_reason, closedAt: r.closed_at,
        }));
      } catch (e) { /* table may not exist */ }

      // Get current price
      let currentPrice = null;
      try {
        const KuruSwapService = require('../services/autoTrade/KuruSwapService');
        currentPrice = await KuruSwapService.getMONPrice();
      } catch (e) { /* non-blocking */ }

      // Calculate live PnL for active positions
      const activeWithPnl = active.map(p => {
        const pnlPercent = currentPrice ? ((currentPrice - p.entryPrice) / p.entryPrice) * 100 : 0;
        return { ...p, currentPrice, pnlPercent: parseFloat(pnlPercent.toFixed(2)) };
      });

      // Get balances
      let balances = { usdc: 0, mon: 0 };
      try {
        const KuruSwapService = require('../services/autoTrade/KuruSwapService');
        balances = await KuruSwapService.getBalances();
      } catch (e) { /* non-blocking */ }

      return res.json({ active: activeWithPnl, closed, balances, currentPrice });
    }
    res.json({ active: [], closed: [], balances: { usdc: 0, mon: 0 }, currentPrice: null });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ========== User Wallet Registration ==========

async function registerWallet(req, res) {
  try {
    const { walletAddress } = req.body;
    if (!walletAddress || !walletAddress.startsWith('0x')) {
      return res.status(400).json({ error: 'Valid wallet address required' });
    }

    // Store in database
    try {
      await DatabaseService.query(
        `INSERT INTO monad_auto_trade_users (wallet_address, enabled, created_at)
         VALUES (?, 1, NOW())
         ON DUPLICATE KEY UPDATE enabled=1, updated_at=NOW()`,
        [walletAddress.toLowerCase()]
      );
    } catch (e) {
      // Create table if not exists
      if (e.message.includes("doesn't exist")) {
        await DatabaseService.query(`
          CREATE TABLE IF NOT EXISTS monad_auto_trade_users (
            id INT AUTO_INCREMENT PRIMARY KEY,
            wallet_address VARCHAR(42) UNIQUE NOT NULL,
            enabled TINYINT(1) DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_wallet (wallet_address)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await DatabaseService.query(
          `INSERT INTO monad_auto_trade_users (wallet_address, enabled, created_at) VALUES (?, 1, NOW())`,
          [walletAddress.toLowerCase()]
        );
      } else {
        throw e;
      }
    }

    // Notify MonadAutoTradeService
    if (global.__monadTrader) {
      global.__monadTrader.addUser(walletAddress.toLowerCase());
    }

    addActivity('system', 'Brain Link', `User wallet registered: ${walletAddress.slice(0, 8)}...`);
    res.json({ success: true, walletAddress });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function getRegisteredUsers(req, res) {
  try {
    let users = [];
    try {
      users = await DatabaseService.query('SELECT * FROM monad_auto_trade_users WHERE enabled = 1');
    } catch (e) { /* table may not exist */ }
    res.json({ users });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ========== Agent Wallet ==========

async function createAgentWallet(req, res) {
  try {
    const { userAddress } = req.body;
    if (!userAddress) return res.status(400).json({ error: 'userAddress required' });

    // Compute Smart Account address deterministically from user EOA
    const { createPublicClient, http } = require('viem');
    const { toSimpleSmartAccount } = require('permissionless/accounts');
    const { privateKeyToAccount } = require('viem/accounts');
    const { entryPoint07Address } = require('viem/account-abstraction');

    const monad = {
      id: 143, name: 'Monad',
      nativeCurrency: { name: 'MON', symbol: 'MON', decimals: 18 },
      rpcUrls: { default: { http: ['https://rpc.monad.xyz'] } },
    };

    const publicClient = createPublicClient({ chain: monad, transport: http('https://rpc.monad.xyz') });

    // Use a deterministic agent key derived from user address
    // For demo: use Oracle key. Production: derive per-user key
    const agentKey = process.env.MONAD_ORACLE_PRIVATE_KEY;
    const owner = privateKeyToAccount(agentKey);

    const smartAccount = await toSimpleSmartAccount({
      client: publicClient,
      owner: owner,
      entryPoint: { address: entryPoint07Address, version: '0.7' },
      salt: BigInt('0x' + userAddress.slice(2, 10)), // Unique per user
    });

    const smartAccountAddress = smartAccount.address;

    // Check if deployed
    const code = await publicClient.getCode({ address: smartAccountAddress });
    const deployed = code && code !== '0x';

    // Check balances
    let usdcBalance = 0, monBalance = 0;
    try {
      const contractsConfig = require('../config/contracts');
      const USDC = contractsConfig.Monad?.USDC;
      if (USDC) {
        const bal = await publicClient.readContract({
          address: USDC,
          abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] }],
          functionName: 'balanceOf', args: [smartAccountAddress],
        });
        usdcBalance = parseFloat(require('viem').formatUnits(bal, 6));
      }
      monBalance = parseFloat(require('viem').formatEther(await publicClient.getBalance({ address: smartAccountAddress })));
    } catch (e) { /* non-blocking */ }

    // Save to database
    try {
      await DatabaseService.query(
        `INSERT INTO monad_agent_wallets (user_address, smart_account_address, deployed, enabled, created_at)
         VALUES (?, ?, ?, 0, NOW())
         ON DUPLICATE KEY UPDATE smart_account_address=VALUES(smart_account_address), deployed=VALUES(deployed)`,
        [userAddress.toLowerCase(), smartAccountAddress, deployed ? 1 : 0]
      );
    } catch (e) {
      if (e.message.includes("doesn't exist")) {
        await DatabaseService.query(`
          CREATE TABLE IF NOT EXISTS monad_agent_wallets (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_address VARCHAR(42) UNIQUE NOT NULL,
            smart_account_address VARCHAR(42) NOT NULL,
            deployed TINYINT(1) DEFAULT 0,
            enabled TINYINT(1) DEFAULT 0,
            max_per_trade DECIMAL(20,6) DEFAULT 1.0,
            total_limit DECIMAL(20,6) DEFAULT 10.0,
            total_used DECIMAL(20,6) DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_user (user_address),
            INDEX idx_smart (smart_account_address)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await DatabaseService.query(
          `INSERT INTO monad_agent_wallets (user_address, smart_account_address, deployed, enabled, created_at) VALUES (?, ?, ?, 0, NOW())`,
          [userAddress.toLowerCase(), smartAccountAddress, deployed ? 1 : 0]
        );
      }
    }

    addActivity('system', 'Agent Wallet', `Created for ${userAddress.slice(0, 10)}... → ${smartAccountAddress.slice(0, 10)}...`);

    res.json({
      userAddress,
      smartAccountAddress,
      deployed,
      usdcBalance,
      monBalance,
      depositInfo: {
        message: 'Send USDC and MON to your Agent Wallet address to start auto-trading',
        usdc: require('../config/contracts').Monad?.USDC || '',
        minMon: '0.1',
        minUsdc: '0.5',
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function getAgentWallet(req, res) {
  try {
    const { address } = req.params;

    // Look up in database
    let wallet = null;
    try {
      const [rows] = await DatabaseService.query(
        'SELECT * FROM monad_agent_wallets WHERE user_address = ? OR smart_account_address = ? LIMIT 1',
        [address.toLowerCase(), address.toLowerCase()]
      );
      wallet = rows || null;
    } catch (e) { /* table may not exist */ }

    if (!wallet) return res.json({ found: false });

    res.json({
      found: true,
      userAddress: wallet.user_address,
      enabled: wallet.enabled === 1,
      maxPerTrade: parseFloat(wallet.max_per_trade || 50),
      totalLimit: parseFloat(wallet.total_limit || 500),
      totalUsed: parseFloat(wallet.total_used || 0),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function enableAgentAutoTrade(req, res) {
  try {
    const { userAddress, maxPerTrade, totalLimit } = req.body;
    if (!userAddress) return res.status(400).json({ error: 'userAddress required' });

    // Insert or update — no need for separate createAgentWallet step
    try {
      await DatabaseService.query(
        `INSERT INTO monad_agent_wallets (user_address, smart_account_address, deployed, enabled, max_per_trade, total_limit, created_at)
         VALUES (?, ?, 0, 1, ?, ?, NOW())
         ON DUPLICATE KEY UPDATE enabled=1, max_per_trade=VALUES(max_per_trade), total_limit=VALUES(total_limit)`,
        [userAddress.toLowerCase(), userAddress.toLowerCase(), maxPerTrade || 50, totalLimit || 500]
      );
    } catch (e) {
      if (e.message.includes("doesn't exist")) {
        await DatabaseService.query(`
          CREATE TABLE IF NOT EXISTS monad_agent_wallets (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_address VARCHAR(42) UNIQUE NOT NULL,
            smart_account_address VARCHAR(42) NOT NULL,
            deployed TINYINT(1) DEFAULT 0,
            enabled TINYINT(1) DEFAULT 0,
            max_per_trade DECIMAL(20,6) DEFAULT 50.0,
            total_limit DECIMAL(20,6) DEFAULT 500.0,
            total_used DECIMAL(20,6) DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_user (user_address)
          ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
        `);
        await DatabaseService.query(
          `INSERT INTO monad_agent_wallets (user_address, smart_account_address, deployed, enabled, max_per_trade, total_limit, created_at)
           VALUES (?, ?, 0, 1, ?, ?, NOW())`,
          [userAddress.toLowerCase(), userAddress.toLowerCase(), maxPerTrade || 50, totalLimit || 500]
        );
      } else throw e;
    }

    // Register with MonadAutoTradeService
    if (global.__monadTrader) {
      global.__monadTrader.addUser(userAddress);
    }

    addActivity('system', 'Agent Wallet', `Auto-trade enabled for ${userAddress.slice(0, 10)}...`);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

async function withdrawAgentWallet(req, res) {
  try {
    // TODO: Implement withdrawal — send UserOperation to transfer USDC from Smart Account to user EOA
    res.json({ error: 'Withdrawal not yet implemented — coming soon' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
}

// ========== Translation (CN → EN) ==========

const CN_TO_EN = {
  // Dimensions
  'K线': 'Kline', 'K位置': 'K Position', '实时动量': 'Momentum', '动能': 'Momentum',
  '散户': 'Retail LS', '大户': 'Top Trader LS', '多天趋势': 'Multi-day', '多天': 'Multi-day',
  'OI变化': 'OI Change', 'OI阶段': 'OI Stage', 'FR趋势': 'FR Trend', '大户趋势': 'TT Trend',
  'Taker趋势': 'Taker Trend', '技术面': 'Technical', '反转': 'Reversal', '资金费率': 'FR',
  // Common phrases in reasons
  '连续': 'consecutive', '阳': 'bull candles', '阴': 'bear candles', '下跌量增': 'vol expanding on drop',
  '高位观望': 'watching at highs', '整体偏多': 'overall bullish', '整体偏空': 'overall bearish',
  '近6根': 'last 6 candles:', '多头通道': 'bullish channel', '空头通道': 'bearish channel',
  '站上': 'above', '跌破': 'below', '放量': 'volume spike',
  '偏买': 'buy bias', '偏卖': 'sell bias', '偏多': 'long bias', '偏空': 'short bias',
  '散户偏多': 'retail long bias', '散户偏空': 'retail short bias',
  '大户偏多': 'whales long bias', '大户偏空': 'whales short bias',
  '大户在减': 'whales reducing', '大户在增': 'whales increasing',
  '趋势变化': 'trend change', '不变': 'unchanged', '翻转': 'flipped',
  '建仓期': 'accumulation', '资金流入': 'capital inflow', '资金流出': 'capital outflow',
  '量价配合': 'vol-price aligned', '突破前高': 'breakout above prev high',
  '破位': 'breakdown', '高位出货': 'distribution at top', '出货形态': 'distribution pattern',
  '底部反弹': 'bottom bounce', '缩量': 'low volume', '横盘': 'sideways',
  '连涨': 'consecutive up', '连跌': 'consecutive down', '结构健康': 'healthy structure',
  '过热': 'overheated', '未过热': 'not overbought', '有空间': 'room to run',
  '追涨': 'chasing rally', '追空': 'chasing short', '反向指标': 'reverse indicator',
  '增持': 'accumulating', '减持': 'reducing',
  'EMA多头': 'EMA bullish', 'EMA空头': 'EMA bearish',
  '通道': ' channel', '多头排列': 'bullish alignment', '空头排列': 'bearish alignment',
  '偏': ' bias ', '涨': ' rising', '跌': ' falling',
  '空': 'short', '多': 'long',
  '强': 'strong', '弱': 'weak', '中性': 'neutral',
  '拉升': 'pump', '砸盘': 'dump', '回调': 'pullback', '反弹': 'bounce',
  '阻力': 'resistance', '支撑': 'support', '震荡': 'choppy',
  '趋势': 'trend', '方向': 'direction', '信号': 'signal',
  '做多': 'long', '做空': 'short',
  '观望': 'watching', '确认': 'confirmed', '等待': 'waiting',
  '近': 'last ', '根': ' candles',
  '15m': '15m', '1H': '1H', '4H': '4H',
};

function translateToEN(text) {
  if (!text || typeof text !== 'string') return text;
  let result = text;
  // Sort by length (longest first) to avoid partial replacements
  const sorted = Object.entries(CN_TO_EN).sort((a, b) => b[0].length - a[0].length);
  for (const [cn, en] of sorted) {
    result = result.split(cn).join(en);
  }
  return result;
}

function translateVotes(votes) {
  if (!votes || !Array.isArray(votes)) return votes;
  return votes.map(v => ({
    ...v,
    dimension: CN_TO_EN[v.dimension] || CN_TO_EN[v.dim] || v.dimension || v.dim,
    dim: CN_TO_EN[v.dim] || v.dim,
    reason: translateToEN(v.reason),
  }));
}

// ========== Helper Functions ==========

function _buildReasoning(votingResult) {
  if (!votingResult.votes) return '';

  const bullish = votingResult.votes
    .filter(v => v.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(v => v.reason)
    .join(' + ');

  const bearish = votingResult.votes
    .filter(v => v.score < 0)
    .sort((a, b) => a.score - b.score)
    .slice(0, 2)
    .map(v => v.reason)
    .join(', ');

  let reasoning = bullish;
  if (bearish) reasoning += `. Risk: ${bearish}`;
  return reasoning;
}

function _calculateTrustScore(totalTrades, winCount) {
  if (totalTrades === 0) return 0;
  const winRate = winCount / totalTrades;
  // Trust score: weighted by volume and consistency
  const volumeScore = Math.min(totalTrades / 20, 1) * 30; // Max 30 points for 20+ trades
  const winRateScore = winRate * 70; // Max 70 points for 100% win rate
  return Math.round(volumeScore + winRateScore);
}

module.exports = {
  initBrainLinkController,
  addActivity,
  getAllDecisions,
  getDecision,
  getDecisionDetail,
  getDecisionTimeline,
  assessRisk,
  getMicroPlan,
  getMicroPosition,
  getTraderMicroPositions,
  getChartData,
  getTraderStats,
  getTraderTrades,
  getLearningEvolution,
  getActivity,
  getAssetActivity,
  getMonadPositions,
  registerWallet,
  getRegisteredUsers,
  createAgentWallet,
  getAgentWallet,
  enableAgentAutoTrade,
  withdrawAgentWallet,
};
