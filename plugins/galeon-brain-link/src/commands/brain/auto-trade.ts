/**
 * brain:auto-trade — Agentic AI Trading via MetaMask Agent Wallet
 *
 * The Agent Wallet autonomously executes trades on Kuru DEX based on Brain signals.
 * No Oracle wallet, no intermediary — the agent wallet holds funds and trades directly.
 *
 * Flow:
 *   1. Agent Wallet holds USDC (user deposits)
 *   2. Brain analyzes markets every cycle
 *   3. Signal PASSED → Agent builds Kuru swap calldata → wallet.submitTransaction()
 *   4. Agent monitors position → TP/SL → sells via wallet.submitTransaction()
 *   5. All funds stay in the Agent Wallet at all times
 *
 * Usage:
 *   mm brain auto-trade
 *   mm brain auto-trade --max-per-trade 1 --total-limit 20
 *   mm brain auto-trade --disable
 */

const BRAIN_API = process.env.GALEON_BRAIN_API || 'https://brainlink.galeon.world/api/brain-link';

const MONAD_USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
const KURU_FLOW = '0xb3e6778480b2E488385E8205eA05E20060B813cb';
const KURU_API = 'https://ws.kuru.io/api';
const MONAD_CHAIN_ID = '0x8f'; // 143

const APPROVE_SELECTOR = '0x095ea7b3'; // approve(address,uint256)

function encodeUint256(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}
function encodeAddress(addr: string): string {
  return addr.slice(2).toLowerCase().padStart(64, '0');
}

// Position tracking (in-memory for this agent session)
interface Position {
  asset: string;
  entryPrice: number;
  amount: number; // token amount
  usdcInvested: number;
  tp1Price: number;
  tp2Price: number;
  tp3Price: number;
  slPrice: number;
  tp1Hit: boolean;
  openedAt: number;
}

export default class BrainAutoTradeCommand {
  static description = 'Enable agentic AI auto-trade — Agent Wallet trades directly on Kuru DEX';
  static requiresAuth = true;
  pluginCommandId = 'brain:auto-trade';

  static flags = {
    disable: { description: 'Stop auto-trading', type: 'boolean' as const, default: false },
    'max-per-trade': { description: 'Max USDC per trade', default: '0.5' },
    'total-limit': { description: 'Total USDC limit', default: '10' },
    'interval': { description: 'Scan interval in minutes', default: '15' },
  };

  ctx: any;
  private positions: Position[] = [];
  private totalUsed = 0;
  private running = false;

  async execute(io: any) {
    try {
      const walletAddress = await this._getWalletAddress(io);
      if (!walletAddress) {
        io.log('❌ No wallet found. Set up your Agent Wallet first with: mm setup');
        return { error: 'No wallet' };
      }

      if (io.flags?.disable) {
        this.running = false;
        io.log('⏹️ Auto-trade stopped.');
        return { disabled: true };
      }

      const maxPerTrade = parseFloat(io.flags?.['max-per-trade'] || '0.5');
      const totalLimit = parseFloat(io.flags?.['total-limit'] || '10');
      const intervalMin = parseInt(io.flags?.['interval'] || '15');

      io.log('🧠 Galeon Brain — Agentic Auto-Trade\n');
      io.log(`   Agent Wallet:   ${walletAddress}`);
      io.log(`   Max per trade:  $${maxPerTrade} USDC`);
      io.log(`   Total limit:    $${totalLimit} USDC`);
      io.log(`   Scan interval:  ${intervalMin} min`);
      io.log(`   DEX:            Kuru (Monad)`);
      io.log(`   Mode:           Agent Wallet trades directly (no intermediary)\n`);

      // Step 1: Approve USDC to Kuru Flow (so agent wallet can swap)
      io.log('Step 1: Approving USDC to Kuru DEX...');
      const approveData = APPROVE_SELECTOR
        + encodeAddress(KURU_FLOW)
        + encodeUint256(BigInt(Math.floor(totalLimit * 1e6)));

      const approveTx = await io.wallet.submitTransaction({
        to: MONAD_USDC,
        data: approveData,
        chainId: MONAD_CHAIN_ID,
        value: '0x0',
      });
      io.log(`   ✅ Approved. TX: ${approveTx.hash}\n`);

      // Step 2: Start trading loop
      io.log('Step 2: Starting Brain signal monitor...\n');
      io.log('═══════════════════════════════════════════');
      io.log('✅ Agentic Auto-Trade ACTIVE\n');
      io.log('How it works:');
      io.log('  • Agent Wallet holds your USDC — no third party');
      io.log('  • Brain scans MON, ETH, BTC, SOL every ' + intervalMin + ' min');
      io.log('  • Signal PASSED → Agent Wallet swaps directly on Kuru');
      io.log('  • TP1 +3%, TP2 +5%, TP3 +8%, SL -5%');
      io.log('  • All trades signed by your Agent Wallet\n');

      this.running = true;
      this.totalUsed = 0;

      // Run first scan immediately, then loop
      await this._scanAndTrade(io, walletAddress, maxPerTrade, totalLimit);

      // Continue scanning on interval
      const interval = setInterval(async () => {
        if (!this.running) { clearInterval(interval); return; }
        await this._scanAndTrade(io, walletAddress, maxPerTrade, totalLimit);
        await this._monitorPositions(io, walletAddress);
      }, intervalMin * 60 * 1000);

      // Monitor positions more frequently (every 30s)
      const monitorInterval = setInterval(async () => {
        if (!this.running) { clearInterval(monitorInterval); return; }
        await this._monitorPositions(io, walletAddress);
      }, 30000);

      return { enabled: true, walletAddress, maxPerTrade, totalLimit };
    } catch (e: any) {
      io.log(`❌ Error: ${e.message}`);
      return { error: e.message };
    }
  }

  /**
   * Scan Brain for signals, execute trade if PASSED
   */
  async _scanAndTrade(io: any, walletAddress: string, maxPerTrade: number, totalLimit: number) {
    try {
      io.log(`\n🔍 [${new Date().toLocaleTimeString()}] Scanning Brain signals...`);

      // Get decisions for all tokens
      const res = await fetch(`${BRAIN_API}/decisions`);
      const data = await res.json();
      const decisions = data.decisions || [];

      for (const d of decisions) {
        if (!d.passed) {
          io.log(`   ${d.asset}: ${d.direction} ${d.confidence}% — not passed`);
          continue;
        }

        if (d.direction !== 'LONG') {
          io.log(`   ${d.asset}: ${d.direction} ${d.confidence}% PASSED — only LONG supported on spot`);
          continue;
        }

        // Check limits
        if (this.totalUsed + maxPerTrade > totalLimit) {
          io.log(`   ${d.asset}: PASSED but total limit reached ($${this.totalUsed}/$${totalLimit})`);
          continue;
        }

        // Check if already holding this asset
        if (this.positions.find(p => p.asset === d.asset)) {
          io.log(`   ${d.asset}: PASSED but already holding`);
          continue;
        }

        io.log(`\n   🟢 ${d.asset}: LONG ${d.confidence}% PASSED — executing trade...`);

        // Execute buy via Agent Wallet
        const success = await this._executeBuy(io, walletAddress, d.asset, maxPerTrade);
        if (success) {
          this.totalUsed += maxPerTrade;
        }
      }
    } catch (e: any) {
      io.log(`   ⚠️ Scan error: ${e.message}`);
    }
  }

  /**
   * Execute a buy trade — Agent Wallet signs and sends directly to Kuru DEX
   */
  async _executeBuy(io: any, walletAddress: string, asset: string, usdcAmount: number): Promise<boolean> {
    try {
      // 1. Get JWT from Kuru
      const jwtRes = await fetch(KURU_API + '/generate-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_address: walletAddress }),
      });
      const jwt = await jwtRes.json();
      if (!jwt.token) throw new Error('Failed to get Kuru JWT');

      // 2. Get swap quote from Kuru
      const amountWei = Math.floor(usdcAmount * 1e6).toString();
      const quoteRes = await fetch(KURU_API + '/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt.token },
        body: JSON.stringify({
          userAddress: walletAddress,
          tokenIn: MONAD_USDC,
          tokenOut: '0x0000000000000000000000000000000000000000', // native MON
          amount: amountWei,
          slippageTolerance: 500,
        }),
      });
      const quote = await quoteRes.json();
      if (quote.status !== 'success') throw new Error('Quote failed: ' + (quote.error || quote.message));

      const tokenReceived = parseFloat(quote.output) / 1e18;
      const entryPrice = usdcAmount / tokenReceived;

      io.log(`   Quote: $${usdcAmount} → ${tokenReceived.toFixed(4)} MON @ $${entryPrice.toFixed(6)}`);

      // 3. Agent Wallet submits the swap transaction directly to Kuru
      const calldata = quote.transaction.calldata.startsWith('0x')
        ? quote.transaction.calldata
        : '0x' + quote.transaction.calldata;

      const swapTx = await io.wallet.submitTransaction({
        to: quote.transaction.to,
        data: calldata,
        value: quote.transaction.value || '0x0',
        chainId: MONAD_CHAIN_ID,
      });

      io.log(`   ✅ BUY executed. TX: ${swapTx.hash}`);
      io.log(`   ${tokenReceived.toFixed(4)} MON @ $${entryPrice.toFixed(6)}`);

      // 4. Track position
      this.positions.push({
        asset,
        entryPrice,
        amount: tokenReceived,
        usdcInvested: usdcAmount,
        tp1Price: entryPrice * 1.03,
        tp2Price: entryPrice * 1.05,
        tp3Price: entryPrice * 1.08,
        slPrice: entryPrice * 0.95,
        tp1Hit: false,
        openedAt: Date.now(),
      });

      io.log(`   TP1: $${(entryPrice * 1.03).toFixed(6)} (+3%) | SL: $${(entryPrice * 0.95).toFixed(6)} (-5%)`);

      // 5. Log to Brain backend
      try {
        await fetch(`${BRAIN_API}/activity`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'agent_trade', asset,
            message: `Agent Wallet BUY ${tokenReceived.toFixed(2)} MON @ $${entryPrice.toFixed(6)} via Kuru`,
          }),
        });
      } catch {} // non-blocking

      return true;
    } catch (e: any) {
      io.log(`   ❌ Buy failed: ${e.message}`);
      return false;
    }
  }

  /**
   * Monitor positions — sell via Agent Wallet when TP/SL hit
   */
  async _monitorPositions(io: any, walletAddress: string) {
    if (this.positions.length === 0) return;

    try {
      // Get current price from Brain
      const res = await fetch(`${BRAIN_API}/decision/MON`);
      const data = await res.json();
      const currentPrice = data.price;
      if (!currentPrice) return;

      for (let i = this.positions.length - 1; i >= 0; i--) {
        const pos = this.positions[i];
        const pnlPercent = ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100;

        // TP1: sell 30%
        if (!pos.tp1Hit && currentPrice >= pos.tp1Price) {
          io.log(`\n💰 [${pos.asset}] TP1 hit! +${pnlPercent.toFixed(2)}%`);
          const sellAmount = pos.amount * 0.3;
          await this._executeSell(io, walletAddress, pos.asset, sellAmount);
          pos.amount -= sellAmount;
          pos.tp1Hit = true;
          pos.slPrice = pos.entryPrice; // move SL to breakeven
          io.log(`   SL moved to breakeven: $${pos.slPrice.toFixed(6)}`);
          continue;
        }

        // TP3: sell all remaining (after TP1)
        if (pos.tp1Hit && currentPrice >= pos.tp3Price) {
          io.log(`\n💰💰💰 [${pos.asset}] TP3 hit! +${pnlPercent.toFixed(2)}%`);
          await this._executeSell(io, walletAddress, pos.asset, pos.amount);
          this.positions.splice(i, 1);
          io.log(`   Position closed.`);
          continue;
        }

        // SL: sell all
        if (currentPrice <= pos.slPrice) {
          io.log(`\n🛑 [${pos.asset}] SL hit! ${pnlPercent.toFixed(2)}%`);
          await this._executeSell(io, walletAddress, pos.asset, pos.amount);
          this.positions.splice(i, 1);
          io.log(`   Position closed.`);
          continue;
        }
      }
    } catch (e: any) {
      // Silent monitoring errors
    }
  }

  /**
   * Execute a sell trade — Agent Wallet signs and sends to Kuru
   */
  async _executeSell(io: any, walletAddress: string, asset: string, tokenAmount: number): Promise<boolean> {
    try {
      const WMON = '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A';
      const sellWei = Math.floor(tokenAmount * 1e18).toString();

      // Wrap MON → WMON first (deposit)
      const wrapData = '0xd0e30db0'; // deposit()
      const wrapValue = '0x' + BigInt(sellWei).toString(16);
      await io.wallet.submitTransaction({
        to: WMON, data: wrapData, value: wrapValue, chainId: MONAD_CHAIN_ID,
      });

      // Approve WMON to Kuru Flow
      const approveData = APPROVE_SELECTOR
        + encodeAddress(KURU_FLOW)
        + encodeUint256(BigInt(sellWei));
      await io.wallet.submitTransaction({
        to: WMON, data: approveData, value: '0x0', chainId: MONAD_CHAIN_ID,
      });

      // Get sell quote: WMON → USDC
      const jwtRes = await fetch(KURU_API + '/generate-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_address: walletAddress }),
      });
      const jwt = await jwtRes.json();

      const quoteRes = await fetch(KURU_API + '/quote', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + jwt.token },
        body: JSON.stringify({
          userAddress: walletAddress,
          tokenIn: WMON,
          tokenOut: MONAD_USDC,
          amount: sellWei,
          slippageTolerance: 500,
        }),
      });
      const quote = await quoteRes.json();
      if (quote.status !== 'success') throw new Error('Sell quote failed');

      const usdcReceived = parseFloat(quote.output) / 1e6;

      // Agent Wallet submits sell
      const calldata = quote.transaction.calldata.startsWith('0x')
        ? quote.transaction.calldata
        : '0x' + quote.transaction.calldata;
      const sellTx = await io.wallet.submitTransaction({
        to: quote.transaction.to,
        data: calldata,
        value: quote.transaction.value || '0x0',
        chainId: MONAD_CHAIN_ID,
      });

      io.log(`   ✅ SOLD ${tokenAmount.toFixed(4)} MON → $${usdcReceived.toFixed(4)} USDC. TX: ${sellTx.hash}`);
      return true;
    } catch (e: any) {
      io.log(`   ❌ Sell failed: ${e.message}`);
      return false;
    }
  }

  async _getWalletAddress(io: any): Promise<string | null> {
    if (io.wallet?.getAddress) return await io.wallet.getAddress();
    const walletState = this.ctx?.walletStateManager?.read();
    return walletState?.byokWallets?.[0]?.address
      || walletState?.remoteWallets?.[0]?.address
      || null;
  }
}
