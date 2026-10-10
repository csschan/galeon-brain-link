/**
 * AgentWalletCard — Multi-chain wallet integration
 * Monad: MetaMask (EVM)
 * Solana: Phantom
 */
import React, { useState, useEffect } from 'react';
import { PublicKey } from '@solana/web3.js';
import { getAgentWallet, enableAgentAutoTrade } from '../../services/brainLinkService';
import {
  connectPhantomWallet, getSolBalance, disconnectWallet,
  connectMetaMaskWallet, getMonBalance, getEvmTokenBalance, disconnectEvmWallet,
  getConnectedAddress, getEvmConnectedAddress,
  approveUsdcToRouter, enableAutoTradeOnChain, revokeAutoTradeOnChain, checkAutoTradeAuthorized,
} from '../../services/monadSmartAccount';
import { getSolanaConnection, SOLANA_TOKENS, getExplorerUrl } from '../../config/monad';
import { useBrainChain } from '../../contexts/BrainChainContext';

interface Props {
  currentPrice: number | null;
}

const AgentWalletCard: React.FC<Props> = ({ currentPrice }) => {
  const { chain, chainName, dex, wallet, nativeToken, explorer } = useBrainChain();
  const isMonad = chain === 'monad';

  const [walletAddress, setWalletAddress] = useState('');
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [maxPerTrade, setMaxPerTrade] = useState('50');
  const [totalLimit, setTotalLimit] = useState('500');
  const [selectedTokens, setSelectedTokens] = useState<string[]>([nativeToken]);

  const SOLANA_TOKENS_LIST = [
    { symbol: 'SOL', name: 'Solana', pair: 'SOL/USDC', volume: '$2.1B' },
    { symbol: 'JUP', name: 'Jupiter', pair: 'JUP/USDC', volume: '$89M' },
    { symbol: 'RAY', name: 'Raydium', pair: 'RAY/USDC', volume: '$45M' },
  ];

  const MONAD_TOKENS_LIST = [
    { symbol: 'MON', name: 'Monad', pair: 'MON/USDC', volume: '$500M' },
    { symbol: 'WETH', name: 'Wrapped ETH', pair: 'WETH/USDC', volume: '$120M' },
    { symbol: 'WBTC', name: 'Wrapped BTC', pair: 'WBTC/USDC', volume: '$80M' },
  ];

  const AVAILABLE_TOKENS = isMonad ? MONAD_TOKENS_LIST : SOLANA_TOKENS_LIST;

  const toggleToken = (symbol: string) => {
    setSelectedTokens(prev =>
      prev.includes(symbol) ? prev.filter(t => t !== symbol) : [...prev, symbol]
    );
  };

  const [nativeBalance, setNativeBalance] = useState(0);
  const [usdcBalance, setUsdcBalance] = useState(0);
  const [autoTradeEnabled, setAutoTradeEnabled] = useState(false);
  const [autoTradeAuth, setAutoTradeAuth] = useState<any>(null);

  const refreshWalletData = async (addr: string) => {
    if (!addr) return;
    try {
      if (isMonad) {
        // Monad EVM balances
        const bal = await getMonBalance(addr);
        setNativeBalance(bal);
        const usdcAddr = process.env.REACT_APP_MONAD_USDC_ADDRESS;
        if (usdcAddr) {
          const usdc = await getEvmTokenBalance(addr, usdcAddr);
          setUsdcBalance(usdc);
        }
      } else {
        // Solana balances
        const bal = await getSolBalance(addr);
        setNativeBalance(bal);
        try {
          const connection = getSolanaConnection();
          const { value } = await connection.getParsedTokenAccountsByOwner(new PublicKey(addr), { mint: SOLANA_TOKENS.USDC });
          const usdcAcc = value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0;
          setUsdcBalance(usdcAcc);
        } catch { setUsdcBalance(0); }
      }

      // Check auto-trade status (on-chain + backend)
      try {
        let enabled = false;
        if (isMonad) {
          enabled = await checkAutoTradeAuthorized(addr);
        }
        const agentData = await getAgentWallet(addr).catch(() => null);

        if (enabled || (agentData?.found && agentData?.enabled)) {
          setAutoTradeEnabled(true);
          setAutoTradeAuth({
            maxPerTrade: agentData?.maxPerTrade || parseFloat(maxPerTrade),
            totalLimit: agentData?.totalLimit || parseFloat(totalLimit),
            totalUsed: agentData?.totalUsed || 0,
            daysRemaining: 30,
          });
        } else {
          setAutoTradeEnabled(false);
          setAutoTradeAuth(null);
        }
      } catch {}
    } catch (e) { console.error('Refresh failed:', e); }
  };

  // Auto-reconnect wallet on page load
  useEffect(() => {
    (async () => {
      let addr: string | null = null;
      if (isMonad) {
        addr = await getEvmConnectedAddress();
      } else {
        addr = await getConnectedAddress();
      }
      if (addr) {
        setWalletAddress(addr);
        refreshWalletData(addr);
      }
    })();
  }, [isMonad]);

  useEffect(() => {
    if (!walletAddress) return;
    refreshWalletData(walletAddress);
    const timer = setInterval(() => refreshWalletData(walletAddress), 15000);
    return () => clearInterval(timer);
  }, [walletAddress]);

  const connectWallet = async () => {
    setLoading(true); setStatus('Connecting...');
    try {
      let addr: string | null;
      if (isMonad) {
        addr = await connectMetaMaskWallet();
        if (!addr) { setStatus('Install MetaMask wallet'); setLoading(false); return; }
      } else {
        addr = await connectPhantomWallet();
        if (!addr) { setStatus('Install Phantom wallet'); setLoading(false); return; }
      }
      setWalletAddress(addr);
      await refreshWalletData(addr);
      setStatus('');
    } catch (e: any) { setStatus(e.message); }
    finally { setLoading(false); }
  };

  const handleDisconnect = async () => {
    if (isMonad) {
      await disconnectEvmWallet();
    } else {
      await disconnectWallet();
    }
    setWalletAddress('');
    setAutoTradeEnabled(false);
    setAutoTradeAuth(null);
  };

  const enableAutoTrade = async () => {
    setLoading(true);
    try {
      const maxVal = parseFloat(maxPerTrade);
      const totalVal = parseFloat(totalLimit);

      if (isMonad) {
        // Step 1: Approve USDC to GaleonRouter
        setStatus('Step 1/3: Approving USDC...');
        await approveUsdcToRouter(walletAddress, totalVal);

        // Step 2: Call GaleonRouter.enableAutoTrade() on-chain
        setStatus('Step 2/3: Enabling on-chain...');
        await enableAutoTradeOnChain(walletAddress, maxVal, totalVal, 30);

        // Step 3: Register with backend
        setStatus('Step 3/3: Registering...');
      }

      await enableAgentAutoTrade(walletAddress, maxVal, totalVal);
      setAutoTradeEnabled(true);
      setAutoTradeAuth({
        maxPerTrade: maxVal,
        totalLimit: totalVal,
        totalUsed: 0,
        daysRemaining: 30,
      });
      setStatus('');
    } catch (e: any) {
      setStatus('Failed: ' + (e.message || 'User rejected'));
    }
    finally { setLoading(false); }
  };

  const revokeAutoTrade = async () => {
    setLoading(true); setStatus('Revoking...');
    try {
      if (isMonad) {
        await revokeAutoTradeOnChain(walletAddress);
      }
      setAutoTradeEnabled(false);
      setAutoTradeAuth(null);
      setStatus('Revoked');
      setTimeout(() => setStatus(''), 3000);
    } catch (e: any) { setStatus('Failed: ' + (e.message || 'User rejected')); }
    finally { setLoading(false); }
  };

  const explorerUrl = isMonad
    ? `${explorer}/address/${walletAddress}`
    : getExplorerUrl(walletAddress);

  return (
    <div className="bl-card">
      <div className="bl-card-label" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        Agent Wallet — {chainName}
      </div>

      {!walletAddress && (
        <div style={{ textAlign: 'center', padding: 20 }}>
          <p style={{ color: '#64748b', fontSize: 13, marginBottom: 14, lineHeight: 1.6 }}>
            Connect {wallet} to enable AI auto-trade via {dex}.<br />
            Your funds stay in your wallet. Brain trades on your behalf.
          </p>
          <button className="bl-btn bl-btn-primary" disabled={loading} onClick={connectWallet}>
            {loading ? 'Connecting...' : `Connect ${wallet}`}
          </button>
          {status && <p style={{ fontSize: 11, color: '#ef4444', marginTop: 8 }}>{status}</p>}
        </div>
      )}

      {walletAddress && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
            <div>
              <span style={{ color: '#22c55e', fontWeight: 700 }}>● Connected</span>
              <a href={explorerUrl} target="_blank" rel="noreferrer"
                style={{ fontSize: 11, color: '#94a3b8', marginLeft: 8, fontFamily: "'JetBrains Mono'", textDecoration: 'none' }}>
                {walletAddress.slice(0, 6)}...{walletAddress.slice(-4)}
              </a>
            </div>
            <button className="bl-btn bl-btn-secondary" style={{ padding: '4px 12px', fontSize: 10 }} onClick={handleDisconnect}>
              Disconnect
            </button>
          </div>

          <div style={{ display: 'flex', gap: 12, marginBottom: 12 }}>
            <div style={{ background: '#f8fafc', borderRadius: 10, padding: '10px 14px', flex: 1 }}>
              <div style={{ fontSize: 10, color: '#94a3b8' }}>{nativeToken}</div>
              <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 18, fontWeight: 800, color: '#1e293b' }}>{nativeBalance.toFixed(4)}</div>
            </div>
            <div style={{ background: '#f8fafc', borderRadius: 10, padding: '10px 14px', flex: 1 }}>
              <div style={{ fontSize: 10, color: '#94a3b8' }}>USDC</div>
              <div style={{ fontFamily: "'JetBrains Mono'", fontSize: 18, fontWeight: 800, color: '#1e293b' }}>${usdcBalance.toFixed(2)}</div>
            </div>
          </div>

          {!autoTradeEnabled && (
            <div style={{ background: '#f0f4ff', borderRadius: 10, padding: 14, marginBottom: 12, border: '1px solid #c7d2fe' }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: '#1e293b', marginBottom: 6 }}>Enable Auto-Trade</div>
              <p style={{ fontSize: 11, color: '#64748b', marginBottom: 10, lineHeight: 1.5 }}>
                Select tokens and set limits. Brain will analyze and trade via {dex}.
              </p>
              <div style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: '#94a3b8', marginBottom: 6 }}>Select tokens to trade</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  {AVAILABLE_TOKENS.map(t => {
                    const selected = selectedTokens.includes(t.symbol);
                    return (
                      <div key={t.symbol} onClick={() => toggleToken(t.symbol)} style={{
                        flex: 1, padding: '8px 10px', borderRadius: 8, cursor: 'pointer', textAlign: 'center',
                        background: selected ? '#4f7df9' : '#fff', color: selected ? '#fff' : '#1e293b',
                        border: selected ? '1px solid #4f7df9' : '1px solid #e2e8f0', transition: 'all 0.2s',
                      }}>
                        <div style={{ fontSize: 14, fontWeight: 700 }}>{t.symbol}</div>
                        <div style={{ fontSize: 9, opacity: 0.7 }}>{t.pair}</div>
                        <div style={{ fontSize: 9, opacity: 0.5 }}>Vol: {t.volume}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 10 }}>
                <div>
                  <div style={{ fontSize: 10, color: '#94a3b8' }}>Max per trade (USDT)</div>
                  <div style={{ position: 'relative' }}>
                    <span style={{ position: 'absolute', left: 8, top: 7, fontSize: 13, color: '#94a3b8' }}>$</span>
                    <input type="number" value={maxPerTrade} onChange={e => setMaxPerTrade(e.target.value)}
                      style={{ width: '100%', padding: '6px 8px 6px 20px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13, fontFamily: "'JetBrains Mono'" }} />
                  </div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: '#94a3b8' }}>Total limit (USDT)</div>
                  <div style={{ position: 'relative' }}>
                    <span style={{ position: 'absolute', left: 8, top: 7, fontSize: 13, color: '#94a3b8' }}>$</span>
                    <input type="number" value={totalLimit} onChange={e => setTotalLimit(e.target.value)}
                      style={{ width: '100%', padding: '6px 8px 6px 20px', border: '1px solid #e2e8f0', borderRadius: 6, fontSize: 13, fontFamily: "'JetBrains Mono'" }} />
                  </div>
                </div>
              </div>
              <button className="bl-btn bl-btn-primary" style={{ width: '100%', fontSize: 13 }} disabled={loading || selectedTokens.length === 0} onClick={enableAutoTrade}>
                {loading ? 'Enabling...' : `Enable Auto-Trade — ${selectedTokens.join(', ')}`}
              </button>
            </div>
          )}

          {autoTradeEnabled && autoTradeAuth && (
            <div style={{ background: '#dcfce7', borderRadius: 10, padding: 14, marginBottom: 12, border: '1px solid #86efac' }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#15803d', marginBottom: 8 }}>Auto-Trade Active</div>
              <div className="bl-row"><span className="bl-row-label">Trading</span><span className="bl-row-val">{selectedTokens.join(', ')} via {dex}</span></div>
              <div className="bl-row"><span className="bl-row-label">Max per trade</span><span className="bl-row-val">${autoTradeAuth.maxPerTrade} USDT</span></div>
              <div className="bl-row"><span className="bl-row-label">Total limit</span><span className="bl-row-val">${autoTradeAuth.totalLimit} USDT</span></div>
              <div className="bl-row"><span className="bl-row-label">Used</span><span className="bl-row-val">${autoTradeAuth.totalUsed} USDT</span></div>
              <div className="bl-row"><span className="bl-row-label">Fee</span><span className="bl-row-val">0.5% per trade</span></div>
              <p style={{ fontSize: 10, color: '#64748b', margin: '8px 0 0', lineHeight: 1.5 }}>
                Brain monitors markets 24/7. Trades execute via {dex} on {chainName}.
              </p>
              <button className="bl-btn bl-btn-secondary" style={{ width: '100%', marginTop: 10, fontSize: 11 }} disabled={loading} onClick={revokeAutoTrade}>
                {loading ? '...' : 'Revoke Auto-Trade'}
              </button>
            </div>
          )}

          <button className="bl-btn bl-btn-secondary" style={{ width: '100%', fontSize: 11 }}
            onClick={() => refreshWalletData(walletAddress)}>
            Refresh
          </button>
          {status && <p style={{ fontSize: 11, color: status.includes('!') || status === 'Revoked' ? '#22c55e' : '#ef4444', marginTop: 6 }}>{status}</p>}
        </div>
      )}

      {currentPrice && (
        <div style={{ fontSize: 12, color: '#64748b', marginTop: 12 }}>
          {nativeToken}: <span style={{ fontFamily: "'JetBrains Mono'", fontWeight: 700, color: '#1e293b' }}>${currentPrice.toFixed(2)}</span>
          <span style={{ color: '#94a3b8', marginLeft: 8 }}>via {dex}</span>
        </div>
      )}
    </div>
  );
};

export default AgentWalletCard;
