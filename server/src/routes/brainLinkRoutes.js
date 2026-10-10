/**
 * Brain Link API Routes
 *
 * Provides Galeon Brain trading intelligence to any Monad application.
 * Endpoints for decisions, risk assessment, micro-execution, and trader history.
 */

const express = require('express');
const router = express.Router();
const brainLinkController = require('../controllers/brainLinkController');

// ========== Decision Queries ==========
// Get all active decisions
router.get('/decisions', brainLinkController.getAllDecisions);

// Get decision for a specific asset
router.get('/decision/:asset', brainLinkController.getDecision);

// Get detailed decision with full voting breakdown
router.get('/decision-detail/:asset', brainLinkController.getDecisionDetail);

// Get decision change timeline for an asset
router.get('/decision-timeline/:asset', brainLinkController.getDecisionTimeline);

// ========== Risk Assessment ==========
// Assess risk for a proposed trade
router.post('/assess-risk', brainLinkController.assessRisk);

// ========== Micro-Execution ==========
// Get micro-execution plan preview
router.get('/micro-plan/:asset', brainLinkController.getMicroPlan);

// Get active micro-position status
router.get('/micro/:positionId', brainLinkController.getMicroPosition);

// Get all active micro-positions for a trader
router.get('/micro/trader/:address', brainLinkController.getTraderMicroPositions);

// ========== Chart Data ==========
// Get K-line data with Brain annotations
router.get('/chart/:asset', brainLinkController.getChartData);

// ========== Trader History ==========
// Get on-chain verified trader stats
router.get('/trader/:address/stats', brainLinkController.getTraderStats);

// Get trader's AI-endorsed trade history
router.get('/trader/:address/trades', brainLinkController.getTraderTrades);

// ========== Brain Learning ==========
// Get Brain learning evolution data
router.get('/learning/evolution', brainLinkController.getLearningEvolution);

// ========== Activity Feed ==========
// Get recent Brain activity events (global)
router.get('/activity', brainLinkController.getActivity);

// Get activity for a specific asset (for Auto Trade page)
router.get('/activity/:asset', brainLinkController.getAssetActivity);

// ========== Monad Auto-Trade ==========
// Get live positions + balances
router.get('/monad/positions', brainLinkController.getMonadPositions);

// Register user wallet for auto-trade
router.post('/register-wallet', brainLinkController.registerWallet);

// Get registered users
router.get('/monad/users', brainLinkController.getRegisteredUsers);

// ========== Agent Wallet ==========
// Create Smart Account for user
router.post('/agent-wallet/create', brainLinkController.createAgentWallet);

// Get Agent Wallet status + balances
router.get('/agent-wallet/:address', brainLinkController.getAgentWallet);

// Enable auto-trade for Agent Wallet
router.post('/agent-wallet/enable', brainLinkController.enableAgentAutoTrade);

// Withdraw from Agent Wallet (user-initiated)
router.post('/agent-wallet/withdraw', brainLinkController.withdrawAgentWallet);

module.exports = router;
