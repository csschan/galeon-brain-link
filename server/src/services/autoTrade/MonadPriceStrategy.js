/**
 * MonadPriceStrategy
 *
 * Simple MON price-based trading strategy for test server.
 * Monitors MON/USDC price on Kuru, detects dips and reversals.
 *
 * Buy signal: Price drops >2% from recent high, then bounces +0.5%
 * Sell: Handled by MonadAutoTradeService TP/SL
 *
 * This replaces GainerScanner for the standalone test server.
 */

const KuruSwapService = require('./KuruSwapService');
const DatabaseService = require('../databaseService');

class MonadPriceStrategy {
  constructor(monadTrader) {
    this.trader = monadTrader;
    this.priceHistory = []; // { price, timestamp }
    this.maxHistory = 30;   // Keep 30 data points (2.5 hours at 5min intervals)
    this.interval = null;
    this.scanIntervalMs = 5 * 60 * 1000; // 5 minutes
    this.lastSignalTime = 0;
    this.minSignalGap = 30 * 60 * 1000; // Min 30 min between signals
  }

  start() {
    console.log('[PriceStrategy] Started — scanning MON every 5 min');
    // First scan after 30 seconds
    setTimeout(() => this._scan(), 30000);
    this.interval = setInterval(() => this._scan(), this.scanIntervalMs);
  }

  stop() {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
  }

  async _scan() {
    try {
      const price = await KuruSwapService.getMONPrice();
      if (!price) return;

      // Record price
      this.priceHistory.push({ price, timestamp: Date.now() });
      if (this.priceHistory.length > this.maxHistory) this.priceHistory.shift();

      // Need at least 6 data points (30 min of data)
      if (this.priceHistory.length < 6) {
        console.log(`[PriceStrategy] MON $${price.toFixed(6)} — collecting data (${this.priceHistory.length}/${6} points)`);
        return;
      }

      // Analyze
      const signal = this._analyze(price);

      if (signal) {
        console.log(`[PriceStrategy] 🟢 BUY SIGNAL: ${signal.reason}`);

        // Log activity
        try {
          const { addActivity } = require('../../controllers/brainLinkController');
          if (addActivity) addActivity('decision_change', 'MON', `BUY signal: ${signal.reason} @ $${price.toFixed(6)}`);
        } catch (e) {}

        // Send to MonadAutoTradeService
        if (this.trader) {
          await this.trader.handleSignal('MON', {
            direction: 'LONG',
            score: signal.score,
            absScore: signal.score,
            confidence: signal.confidence,
            passed: true,
            votes: signal.votes,
            price: price,
            sl: price * 0.95,
            tp1: price * 1.03,
          }, { similarSetups: 0, winRate: 0 });
        }

        this.lastSignalTime = Date.now();
      } else {
        console.log(`[PriceStrategy] MON $${price.toFixed(6)} — no signal`);
      }
    } catch (e) {
      console.log(`[PriceStrategy] Scan error: ${e.message}`);
    }
  }

  _analyze(currentPrice) {
    const prices = this.priceHistory.map(p => p.price);
    const len = prices.length;

    // Don't signal too frequently
    if (Date.now() - this.lastSignalTime < this.minSignalGap) return null;

    // Check if trader already has active MON position
    if (this.trader) {
      const active = this.trader.getActivePositions();
      if (active.some(p => p.asset === 'MON')) return null;
    }

    // Calculate metrics
    const recentHigh = Math.max(...prices.slice(-12));       // High in last hour
    const recentLow = Math.min(...prices.slice(-6));          // Low in last 30 min
    const prevPrice = prices[len - 2];                        // Previous price
    const prev2Price = prices[len - 3];                       // 2 prices ago
    const dropFromHigh = ((currentPrice - recentHigh) / recentHigh) * 100;
    const bounceFromLow = ((currentPrice - recentLow) / recentLow) * 100;
    const shortChange = ((currentPrice - prevPrice) / prevPrice) * 100;
    const medChange = ((currentPrice - prices[len - 4]) / prices[len - 4]) * 100;

    const votes = [];
    let score = 0;

    // 1. Dip & Bounce: Price dropped >1.5% from high, then bouncing up >0.3%
    if (dropFromHigh < -1.5 && bounceFromLow > 0.3) {
      score += 2;
      votes.push({ dim: 'Dip&Bounce', score: 2, reason: `Dropped ${dropFromHigh.toFixed(1)}% from high, bouncing +${bounceFromLow.toFixed(1)}%` });
    }

    // 2. Reversal: Was going down, now going up
    if (prev2Price > prevPrice && prevPrice < currentPrice) {
      score += 2;
      votes.push({ dim: 'Reversal', score: 2, reason: `V-shape: ${prev2Price.toFixed(6)} → ${prevPrice.toFixed(6)} → ${currentPrice.toFixed(6)}` });
    }

    // 3. Momentum turning positive
    if (shortChange > 0.2 && medChange < -0.5) {
      score += 1;
      votes.push({ dim: 'Momentum', score: 1, reason: `Short +${shortChange.toFixed(2)}%, medium ${medChange.toFixed(2)}% (turning)` });
    }

    // 4. Price near recent low (value zone)
    const distFromLow = ((currentPrice - recentLow) / recentLow) * 100;
    if (distFromLow < 0.5 && distFromLow > 0) {
      score += 1;
      votes.push({ dim: 'Value', score: 1, reason: `Near recent low (+${distFromLow.toFixed(2)}% from bottom)` });
    }

    // 5. Negative: Still falling
    if (shortChange < -0.3) {
      score -= 2;
      votes.push({ dim: 'Falling', score: -2, reason: `Still dropping ${shortChange.toFixed(2)}%` });
    }

    // Require score >= 3 to trigger
    if (score >= 3) {
      return {
        score,
        confidence: 55 + Math.min(score * 5, 20),
        reason: votes.filter(v => v.score > 0).map(v => v.reason).join(' + '),
        votes,
      };
    }

    return null;
  }
}

module.exports = MonadPriceStrategy;
