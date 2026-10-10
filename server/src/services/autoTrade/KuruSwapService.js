/**
 * KuruSwapService
 *
 * Encapsulates Kuru DEX swap operations on Monad mainnet.
 * - JWT authentication
 * - Quote (buy/sell)
 * - Execute swap
 * - Wrap/unwrap MON ↔ WMON
 */

const { ethers } = require('ethers');
const https = require('https');
const chainConfig = require('../../config/chains');
const contractsConfig = require('../../config/contracts');

const KURU_API = 'https://ws.kuru.io/api';

class KuruSwapService {
  constructor() {
    this.provider = null;
    this.wallet = null;
    this.jwt = null;
    this.jwtExpiry = 0;

    this.USDC = contractsConfig.Monad?.USDC || '';
    this.WMON = contractsConfig.Monad?.WMON || '';
    this.KURU_FLOW = contractsConfig.Monad?.KuruFlowEntrypoint || '0xb3e6778480b2E488385E8205eA05E20060B813cb';

    // Token addresses on Monad (Kuru trading pairs — verified via Kuru quote API)
    this.TOKEN_MAP = {
      MON:  { address: '0x0000000000000000000000000000000000000000', wrapped: this.WMON, decimals: 18, isNative: true },
      ETH:  { address: '0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242', wrapped: '0xEE8c0E9f1BFFb4Eb878d8f15f368A02a35481242', decimals: 18, isNative: false }, // WETH on Monad
      BTC:  { address: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c', wrapped: '0x0555E30da8f98308EdB960aa94C0Db47230d2B9c', decimals: 8, isNative: false },  // WBTC on Monad
    };

    this.ERC20_ABI = [
      'function approve(address,uint256) returns (bool)',
      'function allowance(address,address) view returns (uint256)',
      'function balanceOf(address) view returns (uint256)',
      'function decimals() view returns (uint8)',
    ];
    this.WMON_ABI = [
      ...this.ERC20_ABI,
      'function deposit() payable',
      'function withdraw(uint256)',
    ];
  }

  async initialize() {
    const monadConfig = chainConfig.Monad;
    if (!monadConfig) throw new Error('Monad chain config not found');

    const key = process.env.MONAD_ORACLE_PRIVATE_KEY;
    if (!key) throw new Error('MONAD_ORACLE_PRIVATE_KEY not set');

    this.provider = new ethers.JsonRpcProvider(monadConfig.rpcUrl);
    this.wallet = new ethers.Wallet(key, this.provider);

    // Pre-approve USDC and WMON for Kuru Flow
    await this._ensureApproval(this.USDC, this.KURU_FLOW);
    await this._ensureApproval(this.WMON, this.KURU_FLOW);

    console.log(`[KuruSwap] initialized. Wallet: ${this.wallet.address}`);
  }

  async _ensureApproval(tokenAddr, spender) {
    if (!tokenAddr) return;
    try {
      const token = new ethers.Contract(tokenAddr, this.ERC20_ABI, this.wallet);
      const allowance = await token.allowance(this.wallet.address, spender);
      if (allowance < ethers.parseUnits('1000', 18)) {
        const tx = await token.approve(spender, ethers.MaxUint256);
        await tx.wait();
        console.log(`[KuruSwap] Approved ${tokenAddr} for ${spender}`);
      }
    } catch (e) {
      console.warn(`[KuruSwap] Approval failed for ${tokenAddr}: ${e.message}`);
    }
  }

  // ── HTTP helper ──
  _httpPost(url, data, headers = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const body = JSON.stringify(data);
      const req = https.request({
        hostname: u.hostname, path: u.pathname, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...headers },
      }, (res) => {
        let d = ''; res.on('data', c => d += c);
        res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(new Error(d)); } });
      });
      req.on('error', reject);
      req.setTimeout(45000, () => { req.destroy(); reject(new Error('Kuru API timeout')); });
      req.write(body);
      req.end();
    });
  }

  // ── JWT ──
  async _getJwt() {
    if (this.jwt && Date.now() / 1000 < this.jwtExpiry - 60) return this.jwt;
    const res = await this._httpPost(KURU_API + '/generate-token', { user_address: this.wallet.address });
    this.jwt = res.token;
    this.jwtExpiry = res.expires_at || (Date.now() / 1000 + 86400);
    return this.jwt;
  }

  // ── Quote ──
  async getQuote(tokenIn, tokenOut, amount, slippageBps = 500) {
    const jwt = await this._getJwt();
    const res = await this._httpPost(KURU_API + '/quote', {
      userAddress: this.wallet.address,
      tokenIn, tokenOut, amount: String(amount),
      slippageTolerance: slippageBps,
    }, { 'Authorization': 'Bearer ' + jwt });

    if (res.status !== 'success') throw new Error('Quote failed: ' + (res.error || res.message || JSON.stringify(res)));
    return res;
  }

  // ── Execute swap from quote ──
  async _executeSwap(quote) {
    const cd = quote.transaction.calldata;
    const calldata = cd.startsWith('0x') ? cd : '0x' + cd;
    const tx = await this.wallet.sendTransaction({
      to: quote.transaction.to,
      data: calldata,
      value: quote.transaction.value || '0',
    });
    const receipt = await tx.wait();
    if (receipt.status !== 1) throw new Error('Swap tx reverted: ' + tx.hash);
    return { txHash: receipt.hash, gasUsed: receipt.gasUsed.toString() };
  }

  /**
   * Buy MON with USDC (0.5% fee deducted first)
   * @param {number} usdcAmount - Amount in USDC (e.g. 0.5)
   * @returns {{ monReceived: number, txHash: string, entryPrice: number, fee: number }}
   */
  async buyMON(usdcAmount) {
    // Deduct 0.5% fee
    const fee = usdcAmount * 0.005;
    const swapAmount = usdcAmount - fee;
    const amountWei = Math.round(swapAmount * 1e6); // USDC 6 decimals

    // Check balance (need full amount including fee)
    const usdc = new ethers.Contract(this.USDC, this.ERC20_ABI, this.wallet);
    const balance = await usdc.balanceOf(this.wallet.address);
    const totalNeeded = Math.round(usdcAmount * 1e6);
    if (balance < BigInt(totalNeeded)) throw new Error(`Insufficient USDC: have ${ethers.formatUnits(balance, 6)}, need ${usdcAmount}`);

    // Transfer fee to feeReceiver
    const feeReceiver = contractsConfig.Monad?.GaleonRouter ?
      process.env.MONAD_FEE_RECEIVER || this.wallet.address : this.wallet.address;
    if (fee > 0.0001 && feeReceiver !== this.wallet.address) {
      const feeWei = Math.round(fee * 1e6);
      const usdcWrite = new ethers.Contract(this.USDC, ['function transfer(address,uint256) returns (bool)'], this.wallet);
      const feeTx = await usdcWrite.transfer(feeReceiver, BigInt(feeWei));
      await feeTx.wait();
      console.log(`[KuruSwap] Fee: $${fee.toFixed(4)} USDC → ${feeReceiver.slice(0,8)}...`);
    }

    // Quote with post-fee amount
    const quote = await this.getQuote(this.USDC, '0x0000000000000000000000000000000000000000', amountWei);
    const monReceived = parseFloat(ethers.formatEther(quote.output));
    const entryPrice = usdcAmount / monReceived; // Use full amount for avg price (fee is cost)

    // Execute
    const result = await this._executeSwap(quote);

    console.log(`[KuruSwap] BUY: $${usdcAmount} USDC (fee $${fee.toFixed(4)}) → ${monReceived.toFixed(4)} MON @ $${entryPrice.toFixed(6)}`);
    return { monReceived, entryPrice, usdcSpent: usdcAmount, fee, ...result };
  }

  /**
   * Sell MON for USDC (0.5% fee deducted from proceeds)
   * @param {number} monAmount - Amount of MON to sell
   * @returns {{ usdcReceived: number, txHash: string, exitPrice: number, fee: number }}
   */
  async sellMON(monAmount) {
    const sellWei = ethers.parseEther(monAmount.toFixed(8));

    // Wrap MON → WMON
    const wmon = new ethers.Contract(this.WMON, this.WMON_ABI, this.wallet);
    const wrapTx = await wmon.deposit({ value: sellWei });
    await wrapTx.wait();

    // Quote: WMON → USDC
    const quote = await this.getQuote(this.WMON, this.USDC, sellWei.toString());
    const grossUsdcReceived = parseFloat(ethers.formatUnits(quote.output, 6));

    // Execute swap
    const result = await this._executeSwap(quote);

    // Deduct 0.5% fee from proceeds
    const fee = grossUsdcReceived * 0.005;
    const netUsdcReceived = grossUsdcReceived - fee;

    // Transfer fee to feeReceiver
    const feeReceiver = process.env.MONAD_FEE_RECEIVER || this.wallet.address;
    if (fee > 0.0001 && feeReceiver !== this.wallet.address) {
      try {
        const feeWei = Math.round(fee * 1e6);
        const usdcWrite = new ethers.Contract(this.USDC, ['function transfer(address,uint256) returns (bool)'], this.wallet);
        const feeTx = await usdcWrite.transfer(feeReceiver, BigInt(feeWei));
        await feeTx.wait();
        console.log(`[KuruSwap] Fee: $${fee.toFixed(4)} USDC → ${feeReceiver.slice(0,8)}...`);
      } catch (e) {
        console.warn(`[KuruSwap] Fee transfer failed: ${e.message}`);
      }
    }

    const exitPrice = grossUsdcReceived / monAmount;

    console.log(`[KuruSwap] SELL: ${monAmount.toFixed(4)} MON → $${grossUsdcReceived.toFixed(4)} USDC (fee $${fee.toFixed(4)}) @ $${exitPrice.toFixed(6)}`);
    return { usdcReceived: netUsdcReceived, grossUsdcReceived, exitPrice, monSold: monAmount, fee, ...result };
  }

  /**
   * Get current MON price in USDC (via quote)
   */
  async getMONPrice() {
    try {
      const quote = await this.getQuote(this.USDC, '0x0000000000000000000000000000000000000000', '1000000'); // $1 quote
      const monForOneDollar = parseFloat(ethers.formatEther(quote.output));
      return 1.0 / monForOneDollar; // USDC per MON
    } catch (e) {
      console.warn('[KuruSwap] Price fetch failed:', e.message);
      return null;
    }
  }

  /**
   * Get balances
   */
  async getBalances() {
    const usdc = new ethers.Contract(this.USDC, this.ERC20_ABI, this.provider);
    const usdcBal = parseFloat(ethers.formatUnits(await usdc.balanceOf(this.wallet.address), 6));
    const monBal = parseFloat(ethers.formatEther(await this.provider.getBalance(this.wallet.address)));
    return { usdc: usdcBal, mon: monBal };
  }

  /**
   * Buy any Kuru token with USDC (generic version of buyMON)
   * @param {string} asset - 'MON', 'ETH', or 'BTC'
   * @param {number} usdcAmount
   */
  async buyToken(asset, usdcAmount) {
    const tokenInfo = this.TOKEN_MAP[asset];
    if (!tokenInfo) throw new Error(`Unknown token: ${asset}. Supported: ${Object.keys(this.TOKEN_MAP).join(', ')}`);

    // For MON, use existing buyMON (native token handling)
    if (asset === 'MON') return this.buyMON(usdcAmount);

    const fee = usdcAmount * 0.005;
    const swapAmount = usdcAmount - fee;
    const amountWei = Math.round(swapAmount * 1e6);

    // Check balance
    const usdc = new ethers.Contract(this.USDC, this.ERC20_ABI, this.provider);
    const balance = await usdc.balanceOf(this.wallet.address);
    if (balance < BigInt(Math.round(usdcAmount * 1e6))) throw new Error(`Insufficient USDC: have ${ethers.formatUnits(balance, 6)}, need ${usdcAmount}`);

    // Fee
    const feeReceiver = process.env.MONAD_FEE_RECEIVER || this.wallet.address;
    if (fee > 0.0001 && feeReceiver !== this.wallet.address) {
      const usdcWrite = new ethers.Contract(this.USDC, ['function transfer(address,uint256) returns (bool)'], this.wallet);
      await (await usdcWrite.transfer(feeReceiver, BigInt(Math.round(fee * 1e6)))).wait();
      console.log(`[KuruSwap] Fee: $${fee.toFixed(4)} USDC → ${feeReceiver.slice(0,8)}...`);
    }

    // Quote: USDC → token
    const quote = await this.getQuote(this.USDC, tokenInfo.address, amountWei);
    const tokenReceived = parseFloat(ethers.formatUnits(quote.output, tokenInfo.decimals));
    const entryPrice = usdcAmount / tokenReceived;

    // Execute
    const result = await this._executeSwap(quote);
    console.log(`[KuruSwap] BUY ${asset}: $${usdcAmount} USDC (fee $${fee.toFixed(4)}) → ${tokenReceived.toFixed(6)} ${asset} @ $${entryPrice.toFixed(2)}`);
    return { monReceived: tokenReceived, tokenReceived, entryPrice, usdcSpent: usdcAmount, fee, asset, ...result };
  }

  /**
   * Sell any Kuru token for USDC (generic version of sellMON)
   * @param {string} asset - 'MON', 'ETH', or 'BTC'
   * @param {number} tokenAmount
   */
  async sellToken(asset, tokenAmount) {
    const tokenInfo = this.TOKEN_MAP[asset];
    if (!tokenInfo) throw new Error(`Unknown token: ${asset}`);

    // For MON, use existing sellMON (native token → WMON handling)
    if (asset === 'MON') return this.sellMON(tokenAmount);

    // For ERC20 tokens (WETH, CBBTC), no wrapping needed
    const sellWei = ethers.parseUnits(tokenAmount.toFixed(tokenInfo.decimals), tokenInfo.decimals);

    // Approve token for Kuru Flow
    const token = new ethers.Contract(tokenInfo.address, this.ERC20_ABI, this.wallet);
    const allowance = await token.allowance(this.wallet.address, this.KURU_FLOW);
    if (allowance < sellWei) {
      await (await new ethers.Contract(tokenInfo.address, ['function approve(address,uint256) returns (bool)'], this.wallet).approve(this.KURU_FLOW, ethers.MaxUint256)).wait();
    }

    // Quote: token → USDC
    const quote = await this.getQuote(tokenInfo.address, this.USDC, sellWei.toString());
    const grossUsdcReceived = parseFloat(ethers.formatUnits(quote.output, 6));

    // Execute
    const result = await this._executeSwap(quote);

    // Fee
    const fee = grossUsdcReceived * 0.005;
    const netUsdcReceived = grossUsdcReceived - fee;
    const feeReceiver = process.env.MONAD_FEE_RECEIVER || this.wallet.address;
    if (fee > 0.0001 && feeReceiver !== this.wallet.address) {
      try {
        const usdcWrite = new ethers.Contract(this.USDC, ['function transfer(address,uint256) returns (bool)'], this.wallet);
        await (await usdcWrite.transfer(feeReceiver, BigInt(Math.round(fee * 1e6)))).wait();
      } catch (e) { console.warn(`[KuruSwap] Fee transfer failed: ${e.message}`); }
    }

    const exitPrice = grossUsdcReceived / tokenAmount;
    console.log(`[KuruSwap] SELL ${asset}: ${tokenAmount.toFixed(6)} → $${grossUsdcReceived.toFixed(4)} USDC (fee $${fee.toFixed(4)}) @ $${exitPrice.toFixed(2)}`);
    return { usdcReceived: netUsdcReceived, grossUsdcReceived, exitPrice, monSold: tokenAmount, tokenSold: tokenAmount, fee, asset, ...result };
  }

  /**
   * Get price for any supported token
   * @param {string} asset - 'MON', 'ETH', or 'BTC'
   */
  async getTokenPrice(asset) {
    const tokenInfo = this.TOKEN_MAP[asset];
    if (!tokenInfo) return null;

    if (asset === 'MON') return this.getMONPrice();

    try {
      // Quote $1 USDC → token
      const quote = await this.getQuote(this.USDC, tokenInfo.address, '1000000');
      const tokenForOneDollar = parseFloat(ethers.formatUnits(quote.output, tokenInfo.decimals));
      return 1.0 / tokenForOneDollar;
    } catch (e) {
      return null;
    }
  }
}

module.exports = new KuruSwapService();
