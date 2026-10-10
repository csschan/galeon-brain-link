/**
 * brain:auto-trade — Enable/disable AI auto-trading via MetaMask Agent Wallet
 *
 * Uses wallet-submit to send on-chain transactions:
 *   1. Approve USDC to GaleonRouter
 *   2. Call GaleonRouter.enableAutoTrade()
 *   3. Register with Brain backend
 *
 * Usage: mm brain auto-trade
 *        mm brain auto-trade --max-per-trade 1 --total-limit 20
 *        mm brain auto-trade --disable
 */

const BRAIN_API = process.env.GALEON_BRAIN_API || 'https://brainlink.galeon.world/api/brain-link';

const GALEON_ROUTER = '0xB7D5aD3ff190B556de41832204530FdA006a85A2';
const MONAD_USDC = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
const MONAD_CHAIN_ID = '0x8f'; // 143

// Function selectors (keccak256 first 4 bytes)
const APPROVE_SELECTOR = '0x095ea7b3';           // approve(address,uint256)
const ENABLE_SELECTOR = '0xa7672bf7';             // enableAutoTrade(uint256,uint256,uint256)
const REVOKE_SELECTOR = '0xc5529ede';             // revokeAutoTrade()

function encodeUint256(value: bigint): string {
  return value.toString(16).padStart(64, '0');
}

function encodeAddress(addr: string): string {
  return addr.slice(2).toLowerCase().padStart(64, '0');
}

export default class BrainAutoTradeCommand {
  static description = 'Enable AI auto-trade via Galeon Brain on Kuru DEX';
  static requiresAuth = true;
  pluginCommandId = 'brain:auto-trade';

  static flags = {
    disable: { description: 'Disable auto-trade', type: 'boolean' as const, default: false },
    'max-per-trade': { description: 'Max USDC per trade', default: '0.5' },
    'total-limit': { description: 'Total USDC limit', default: '10' },
  };

  ctx: any;

  async execute(io: any) {
    try {
      // Get wallet address from Agent Wallet
      const walletAddress = await this._getWalletAddress(io);
      if (!walletAddress) {
        io.log('❌ No wallet found. Set up your Agent Wallet first with: mm setup');
        return { error: 'No wallet' };
      }

      // === DISABLE ===
      if (io.flags?.disable) {
        io.log('⏹️ Revoking auto-trade on-chain...\n');

        // Send revokeAutoTrade() transaction via Agent Wallet
        const revokeTx = await io.wallet.submitTransaction({
          to: GALEON_ROUTER,
          data: REVOKE_SELECTOR,
          chainId: MONAD_CHAIN_ID,
          value: '0x0',
        });

        io.log(`✅ Auto-trade revoked. TX: ${revokeTx.hash}`);
        return { disabled: true, tx: revokeTx.hash };
      }

      // === ENABLE ===
      const maxPerTrade = parseFloat(io.flags?.['max-per-trade'] || '0.5');
      const totalLimit = parseFloat(io.flags?.['total-limit'] || '10');

      io.log('🧠 Galeon Brain — Enabling Auto-Trade\n');
      io.log(`   Wallet:        ${walletAddress}`);
      io.log(`   Max per trade:  $${maxPerTrade} USDC`);
      io.log(`   Total limit:    $${totalLimit} USDC`);
      io.log(`   Duration:       30 days`);
      io.log(`   DEX:            Kuru (Monad)`);
      io.log(`   Fee:            0.5% per trade (on-chain)\n`);

      // Step 1: Approve USDC to GaleonRouter
      io.log('Step 1/3: Approving USDC to GaleonRouter...');
      const approveAmount = BigInt(Math.floor(totalLimit * 1e6)); // USDC 6 decimals
      const approveData = APPROVE_SELECTOR
        + encodeAddress(GALEON_ROUTER)
        + encodeUint256(approveAmount);

      const approveTx = await io.wallet.submitTransaction({
        to: MONAD_USDC,
        data: approveData,
        chainId: MONAD_CHAIN_ID,
        value: '0x0',
      });
      io.log(`   ✅ Approved. TX: ${approveTx.hash}\n`);

      // Step 2: Call enableAutoTrade on GaleonRouter
      io.log('Step 2/3: Enabling auto-trade on-chain...');
      const maxWei = BigInt(Math.floor(maxPerTrade * 1e6));
      const totalWei = BigInt(Math.floor(totalLimit * 1e6));
      const durationDays = BigInt(30);

      const enableData = ENABLE_SELECTOR
        + encodeUint256(maxWei)
        + encodeUint256(totalWei)
        + encodeUint256(durationDays);

      const enableTx = await io.wallet.submitTransaction({
        to: GALEON_ROUTER,
        data: enableData,
        chainId: MONAD_CHAIN_ID,
        value: '0x0',
      });
      io.log(`   ✅ Enabled on-chain. TX: ${enableTx.hash}\n`);

      // Step 3: Register with Brain backend
      io.log('Step 3/3: Registering with Brain...');
      await fetch(`${BRAIN_API}/agent-wallet/enable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userAddress: walletAddress, maxPerTrade, totalLimit }),
      });
      io.log('   ✅ Registered with Brain backend\n');

      io.log('═══════════════════════════════════');
      io.log('✅ Auto-trade is ACTIVE\n');
      io.log('What happens next:');
      io.log('  1. Brain scans MON, ETH, BTC, SOL every 15 min');
      io.log('  2. When signal PASSED (score ≥ 6, confidence ≥ 55%)');
      io.log('  3. Brain pulls USDC from your wallet via GaleonRouter');
      io.log('  4. Swaps on Kuru DEX → monitors position 24/7');
      io.log('  5. TP1 +3% → sell 30%, TP2 +5% → sell 30%, TP3 +8% → rest');
      io.log('  6. Stop-loss at -5%. Proceeds sent back to your wallet.\n');
      io.log('Check positions:  mm brain positions');
      io.log('Disable:          mm brain auto-trade --disable');

      return { enabled: true, walletAddress, maxPerTrade, totalLimit, approveTx: approveTx.hash, enableTx: enableTx.hash };
    } catch (e: any) {
      io.log(`❌ Error: ${e.message}`);
      return { error: e.message };
    }
  }

  async _getWalletAddress(io: any): Promise<string | null> {
    // Try Agent Wallet API first
    if (io.wallet?.getAddress) {
      return await io.wallet.getAddress();
    }
    // Fallback to wallet state manager
    const walletState = this.ctx?.walletStateManager?.read();
    return walletState?.byokWallets?.[0]?.address
      || walletState?.remoteWallets?.[0]?.address
      || null;
  }
}
