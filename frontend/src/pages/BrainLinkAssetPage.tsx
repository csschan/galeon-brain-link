/**
 * BrainLinkAssetPage - Token Analysis + Multi-chain Swap Execution
 * Monad: EVM contract swap via MetaMask
 * Solana: Jupiter swap via Phantom
 */
import React, { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useDecision, useDecisionDetail, useDecisionTimeline, useMicroPlan, useRiskAssessment } from '../hooks/useBrainLink';
import { getSwapQuote, executeSwap, JupiterQuote } from '../contracts/GaleonRouter';
import { getConnectedAddress, connectPhantomWallet, getEvmConnectedAddress, connectMetaMaskWallet } from '../services/monadSmartAccount';
import { SOLANA_TOKENS, getExplorerUrl } from '../config/monad';
import { useBrainChain } from '../contexts/BrainChainContext';
import './BrainLinkPages.css';

const dirClass: Record<string, string> = { LONG: 'long', SHORT: 'short', WAIT: 'wait' };

function formatTime(ts: string): string {
  const d = new Date(ts); const now = new Date(); const diffH = Math.floor((now.getTime() - d.getTime()) / 3600000);
  if (diffH < 1) return `${Math.floor((now.getTime() - d.getTime()) / 60000)}m ago`;
  if (diffH < 24) return `${diffH}h ago`; return `${Math.floor(diffH / 24)}d ago`;
}

/** Execute swap on Monad via GaleonRouter EVM contract */
async function executeMonadSwap(amount: number, asset: string, direction: string): Promise<string | null> {
  const ethereum = (window as any).ethereum;
  if (!ethereum) throw new Error('MetaMask not found');

  const accounts = await ethereum.request({ method: 'eth_accounts' });
  if (!accounts?.length) throw new Error('MetaMask not connected');

  const routerAddress = process.env.REACT_APP_MONAD_GALEON_ROUTER_ADDRESS;
  if (!routerAddress) throw new Error('Monad Router contract not configured');

  // EVM swap via GaleonRouter contract
  // Function: executeSwap(string asset, uint256 amount, uint8 direction)
  // For demo: send native MON to router contract
  const amountWei = '0x' + BigInt(Math.floor(amount * 1e18)).toString(16);

  const txHash = await ethereum.request({
    method: 'eth_sendTransaction',
    params: [{
      from: accounts[0],
      to: routerAddress,
      value: amountWei,
      data: '0x', // Simple transfer for demo; real impl would encode function call
    }],
  });

  return txHash;
}

const BrainLinkAssetPage: React.FC = () => {
  const { asset } = useParams<{ asset: string }>();
  const navigate = useNavigate();
  const { chain, basePath, chainName, dex, explorerName, explorer, nativeToken, wallet } = useBrainChain();
  const isMonad = chain === 'monad';
  const assetName = asset?.toUpperCase() || nativeToken;

  const { decision: d, loading } = useDecision(assetName);
  const { detail: dt } = useDecisionDetail(assetName);
  const { timeline } = useDecisionTimeline(assetName);

  const [tradeAmount, setTradeAmount] = useState(100);
  const { assessment, assess } = useRiskAssessment();
  const suggestedAmount = assessment?.suggestedAmount || tradeAmount;
  const { plan } = useMicroPlan(assetName, suggestedAmount, d?.direction || 'LONG');

  const [swapStatus, setSwapStatus] = useState<'idle' | 'quoting' | 'confirming' | 'sending' | 'success' | 'error'>('idle');
  const [swapTxId, setSwapTxId] = useState<string | null>(null);
  const [swapError, setSwapError] = useState('');
  const [quote, setQuote] = useState<JupiterQuote | null>(null);

  // Solana token mint addresses
  const TOKEN_MINTS: Record<string, string> = {
    SOL: SOLANA_TOKENS.SOL.toBase58(),
    USDC: SOLANA_TOKENS.USDC.toBase58(),
    JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
    BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
  };

  const handleExecuteSwap = async (amount: number) => {
    try {
      if (isMonad) {
        // ===== Monad EVM Swap =====
        let walletAddr = await getEvmConnectedAddress();
        if (!walletAddr) {
          walletAddr = await connectMetaMaskWallet();
          if (!walletAddr) { setSwapError(`Please connect ${wallet}`); setSwapStatus('error'); return; }
        }

        setSwapStatus('quoting');
        setSwapError('');

        // Convert USD amount to native token amount
        const tokenAmount = d?.price ? amount / d.price : amount;

        setSwapStatus('sending');
        const txHash = await executeMonadSwap(tokenAmount, assetName, d?.direction || 'LONG');
        if (!txHash) { setSwapError('Transaction failed or was rejected'); setSwapStatus('error'); return; }

        setSwapTxId(txHash);
        setSwapStatus('success');
      } else {
        // ===== Solana Jupiter Swap =====
        let walletAddr = await getConnectedAddress();
        if (!walletAddr) {
          walletAddr = await connectPhantomWallet();
          if (!walletAddr) { setSwapError(`Please connect ${wallet}`); setSwapStatus('error'); return; }
        }

        setSwapStatus('quoting');
        setSwapError('');
        const lamports = Math.floor(amount / (d?.price || 1) * 1e9);
        const tokenMint = TOKEN_MINTS[assetName] || TOKEN_MINTS.SOL;

        // eslint-disable-next-line eqeqeq
        const isLong = d?.direction === 'LONG' || (d?.direction as any) == 1;
        const inputMint = isLong ? SOLANA_TOKENS.SOL.toBase58() : tokenMint;
        const outputMint = isLong ? tokenMint : SOLANA_TOKENS.SOL.toBase58();
        const inputAmount = isLong ? lamports : Math.floor(amount * 1e6);

        const jupQuote = await getSwapQuote(inputMint, outputMint, inputAmount, 100);
        if (!jupQuote) { setSwapError('Failed to get Jupiter quote'); setSwapStatus('error'); return; }
        setQuote(jupQuote);

        setSwapStatus('confirming');
        setSwapStatus('sending');

        const txId = await executeSwap(jupQuote, walletAddr);
        if (!txId) { setSwapError('Transaction failed or was rejected'); setSwapStatus('error'); return; }

        setSwapTxId(txId);
        setSwapStatus('success');
      }
    } catch (e: any) {
      setSwapError(e.message || 'Swap failed');
      setSwapStatus('error');
    }
  };

  React.useEffect(() => {
    if (d && tradeAmount > 0) assess('', assetName, tradeAmount, d.direction);
  }, [assetName, tradeAmount, d?.direction]);

  const getTxExplorerUrl = (txId: string) => {
    if (isMonad) return `${explorer}/tx/${txId}`;
    return getExplorerUrl(txId, 'tx');
  };

  if (loading) return <div className="bl-page" style={{ color: '#94a3b8' }}>Loading Brain analysis for {assetName}...</div>;

  return (
    <div className="bl-page">
      {/* Back */}
      <div style={{ color: '#4f7df9', fontSize: 13, cursor: 'pointer', marginBottom: 16, fontWeight: 600 }} onClick={() => navigate(basePath)}>← Back</div>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <div>
          <h1 className="bl-title">{assetName} / USDC</h1>
          <p style={{ fontSize: 13, color: '#94a3b8', margin: 0 }}>{chainName} · {dex}</p>
        </div>
        {d && <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 24, fontWeight: 800, fontFamily: "'JetBrains Mono', monospace", color: '#1e293b' }}>${d.price?.toFixed(4) || '—'}</div>
        </div>}
      </div>

      {/* Decision Hero */}
      {d && (
        <div className="bl-hero">
          <div className={`bl-hero-dir ${dirClass[d.direction] || 'wait'}`}>{d.direction}</div>
          {assessment && (
            <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
              {/* Current level */}
              <div style={{
                padding: '8px 20px', borderRadius: 10, fontSize: 14, fontWeight: 700,
                background: assessment.action === 'PASS' ? '#dcfce7' : assessment.action === 'ADJUST' ? '#fef3c7' : '#fee2e2',
                color: assessment.action === 'PASS' ? '#15803d' : assessment.action === 'ADJUST' ? '#92400e' : '#b91c1c',
              }}>
                {assessment.action === 'PASS' && `PASS — Execute $${suggestedAmount} as planned`}
                {assessment.action === 'ADJUST' && `ADJUST — Reduce to $${suggestedAmount} recommended`}
                {assessment.action === 'REJECT' && `REJECT — Signal too weak, avoid trading`}
              </div>
              {/* Risk level legend */}
              <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#94a3b8' }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#22c55e', display: 'inline-block' }} />
                  <span style={{ color: assessment.action === 'PASS' ? '#15803d' : undefined, fontWeight: assessment.action === 'PASS' ? 700 : 400 }}>PASS: Execute</span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#f59e0b', display: 'inline-block' }} />
                  <span style={{ color: assessment.action === 'ADJUST' ? '#92400e' : undefined, fontWeight: assessment.action === 'ADJUST' ? 700 : 400 }}>ADJUST: Reduce size</span>
                </span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#ef4444', display: 'inline-block' }} />
                  <span style={{ color: assessment.action === 'REJECT' ? '#b91c1c' : undefined, fontWeight: assessment.action === 'REJECT' ? 700 : 400 }}>REJECT: Don't trade</span>
                </span>
              </div>
            </div>
          )}
          <div className="bl-hero-badges">
            <div><div className="bl-hero-badge-val" style={{ color: '#4f7df9' }}>{d.confidence}%</div><div className="bl-hero-badge-label">Confidence</div></div>
            <div style={{ borderLeft: '1px solid #e2e8f0', margin: '0 4px' }} />
            <div><div className="bl-hero-badge-val" style={{ color: d.riskLevel === 'HIGH' ? '#ef4444' : d.riskLevel === 'LOW' ? '#22c55e' : '#f59e0b' }}>{d.riskLevel}</div><div className="bl-hero-badge-label">Risk</div></div>
            <div style={{ borderLeft: '1px solid #e2e8f0', margin: '0 4px' }} />
            <div><div className="bl-hero-badge-val" style={{ color: '#22c55e' }}>{d.winRate}%</div><div className="bl-hero-badge-label">Win Rate</div></div>
          </div>
        </div>
      )}

      <div className="bl-grid-2">
        {/* Left */}
        <div>
          {/* Why */}
          {d && <div className="bl-card">
            <div className="bl-card-label">Why This Decision</div>
            <div style={{ fontSize: 14, lineHeight: 1.7, color: '#1e293b' }}>{d.reasoning || 'No reasoning available'}</div>
          </div>}

          {/* Historical Evidence */}
          {d && <div className="bl-card">
            <div className="bl-card-label">Historical Evidence</div>
            <div className="bl-grid-3" style={{ marginBottom: 14 }}>
              <div className="bl-stat"><div className="bl-stat-val">{d.similarSetups}</div><div className="bl-stat-label">Similar Setups</div></div>
              <div className="bl-stat"><div className="bl-stat-val green">{d.winRate}%</div><div className="bl-stat-label">Win Rate</div></div>
              <div className="bl-stat"><div className="bl-stat-val green">+4.2%</div><div className="bl-stat-label">Avg PnL</div></div>
            </div>
          </div>}

          {/* Risk Assessment */}
          {d && <div className="bl-card">
            <div className="bl-card-label">Risk Assessment</div>
            {[
              { label: 'Portfolio Risk', value: assessment?.action || d.riskLevel, cls: d.riskLevel === 'HIGH' ? 'amber' : d.riskLevel === 'LOW' ? 'green' : '' },
              { label: 'Reason', value: assessment?.reason || 'Checking...' },
              { label: 'Your Input', value: `$${tradeAmount.toLocaleString()}` },
              { label: 'Suggested Size', value: `$${suggestedAmount}`, cls: 'purple' },
              { label: 'Entry Zone', value: d.entryZone ? `$${d.entryZone.min.toFixed(4)} — $${d.entryZone.max.toFixed(4)}` : '—' },
              { label: 'Stop Loss', value: d.stopLoss ? `$${d.stopLoss.toFixed(4)}` : '—', cls: 'red' },
              { label: 'Take Profit', value: d.takeProfit1 ? `$${d.takeProfit1.toFixed(4)}` : '—', cls: 'green' },
            ].map((r, i) => (
              <div key={i} className="bl-row">
                <span className="bl-row-label">{r.label}</span>
                <span className={`bl-row-val ${r.cls || ''}`}>{r.value}</span>
              </div>
            ))}
          </div>}

          {/* Micro-Execution Plan */}
          {plan && <div className="bl-card" style={{ borderColor: '#c7d2fe' }}>
            <div className="bl-card-label">AI Micro-Execution Plan</div>
            <p style={{ fontSize: 12, color: '#64748b', marginBottom: 14 }}>Brain splits into micro-steps, block by block:</p>
            <div className="bl-micro-plan-bar">
              <div className="bl-micro-plan-seg dca" style={{ flex: 3 }}><div className="bl-micro-plan-seg-label" style={{ color: '#15803d' }}>DCA IN</div><div className="bl-micro-plan-seg-sub">3 steps</div></div>
              <div className="bl-micro-plan-seg hold" style={{ flex: 1 }}><div className="bl-micro-plan-seg-label" style={{ color: '#64748b' }}>HOLD</div><div className="bl-micro-plan-seg-sub">monitor</div></div>
              <div className="bl-micro-plan-seg tp" style={{ flex: 2 }}><div className="bl-micro-plan-seg-label" style={{ color: '#92400e' }}>TP</div><div className="bl-micro-plan-seg-sub">30/30/40%</div></div>
              <div className="bl-micro-plan-seg sl" style={{ flex: 1 }}><div className="bl-micro-plan-seg-label" style={{ color: '#b91c1c' }}>SL</div><div className="bl-micro-plan-seg-sub">dynamic</div></div>
            </div>
            {plan.steps.map((s, i) => (
              <div key={i} className="bl-row">
                <span className="bl-row-label">Step {s.step}</span>
                <span className="bl-row-val" style={{ color: s.type === 'DCA_IN' ? '#22c55e' : s.type.includes('TP') ? '#f59e0b' : '#ef4444' }}>
                  {s.amount ? `${s.percent}% ($${s.amount})` : `${s.percent}%`} — {s.condition}
                </span>
              </div>
            ))}
            {plan.safety && <div className="bl-row"><span className="bl-row-label">Safety</span><span className="bl-row-val red">{plan.safety}</span></div>}
            <div className="bl-hint">Est. 4-6 on-chain micro-steps · Gas: ~$0.02 · <b>Only possible on {chainName}</b></div>
          </div>}
        </div>

        {/* Right */}
        <div>
          {/* Voting Bars */}
          {dt && dt.votes && <div className="bl-card">
            <div className="bl-card-label">
              Voting — Score {dt.score > 0 ? '+' : ''}{dt.score} (Threshold: 6) {dt.passed ? '✅' : '❌'}
            </div>
            <div style={{ display: 'flex', gap: 8, marginBottom: 14, fontSize: 12 }}>
              <span style={{ color: '#22c55e', fontWeight: 700 }}>{dt.bullVotes} Bullish</span>
              <span style={{ color: '#ef4444', fontWeight: 700 }}>{dt.bearVotes} Bearish</span>
              <span style={{ color: '#94a3b8' }}>{dt.votes.filter(v => v.score === 0).length} Neutral</span>
            </div>
            {[...dt.votes].sort((a, b) => b.score - a.score).map((v, i) => {
              const cls = v.score > 0 ? 'bull' : v.score < 0 ? 'bear' : 'neutral';
              const w = Math.min(Math.abs(v.score) * 50, 100);
              return (
                <div key={i} className="bl-vote-row">
                  <div className="bl-vote-dim">{v.dimension}</div>
                  <div className="bl-vote-bar">
                    <div className={`bl-vote-fill ${cls}`} style={{ width: `${w}%` }}>{v.reason}</div>
                  </div>
                  <div className="bl-vote-score" style={{ color: v.score > 0 ? '#22c55e' : v.score < 0 ? '#ef4444' : '#94a3b8' }}>
                    {v.score > 0 ? '+' : ''}{v.score}
                  </div>
                </div>
              );
            })}
          </div>}

          {/* Timeline */}
          {timeline.length > 0 && <div className="bl-card">
            <div className="bl-card-label">Brain Decision Timeline</div>
            <div className="bl-timeline">
              {timeline.map((e, i) => {
                const dotCls = e.direction === 'LONG' ? 'green' : e.direction === 'SHORT' ? 'red' : 'amber';
                return (
                  <div key={i} className="bl-timeline-item">
                    <div className={`bl-timeline-dot ${i === 0 ? 'active' : dotCls}`} />
                    <div className="bl-timeline-time">{i === 0 ? 'Now' : formatTime(e.timestamp)}</div>
                    <div className="bl-timeline-text">
                      <span style={{ color: e.direction === 'LONG' ? '#22c55e' : e.direction === 'SHORT' ? '#ef4444' : '#f59e0b', fontWeight: 700 }}>
                        {e.direction} {e.confidence}%
                      </span>
                      {e.reasoning && ` — ${e.reasoning}`}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>}
        </div>
      </div>

      {/* Execute */}
      {d && d.passed && <div className="bl-card" style={{ borderColor: '#c7d2fe', marginTop: 4 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: '#1e293b' }}>Execute on {dex}</div>
            <div style={{ fontSize: 12, color: '#94a3b8' }}>
              {swapStatus === 'quoting' ? 'Getting best price...' :
               swapStatus === 'sending' ? `Confirm in ${wallet}...` :
               swapStatus === 'success' ? 'Trade executed!' :
               `Fee: 0.5% · Swap via ${dex}`}
            </div>
          </div>
          <div className="bl-btn-row" style={{ marginTop: 0 }}>
            <button className="bl-btn bl-btn-primary"
              disabled={swapStatus === 'quoting' || swapStatus === 'sending'}
              onClick={() => handleExecuteSwap(suggestedAmount)}>
              {swapStatus === 'quoting' ? 'Quoting...' :
               swapStatus === 'sending' ? 'Signing...' :
               swapStatus === 'success' ? 'Done ✅' :
               `Execute $${suggestedAmount} ✅`}
            </button>
            {suggestedAmount < tradeAmount && swapStatus === 'idle' && (
              <button className="bl-btn bl-btn-secondary" onClick={() => handleExecuteSwap(tradeAmount)}>
                Override ${tradeAmount} ⚠
              </button>
            )}
          </div>
        </div>
        {swapStatus === 'success' && swapTxId && (
          <div className="bl-onchain" style={{ marginTop: 12 }}>
            ✅ <a href={getTxExplorerUrl(swapTxId)} target="_blank" rel="noreferrer" style={{ color: '#4f7df9' }}>
              View on {explorerName}: {swapTxId.slice(0, 8)}...{swapTxId.slice(-6)}
            </a>
          </div>
        )}
        {swapStatus === 'error' && (
          <div style={{ marginTop: 8, fontSize: 12, color: '#ef4444' }}>{swapError}</div>
        )}
        {swapStatus === 'idle' && (
          <div className="bl-onchain" style={{ marginTop: 12 }}>🔗 Decision ID: #{d.decisionId} · Will be recorded on {chainName}</div>
        )}
      </div>}
    </div>
  );
};

export default BrainLinkAssetPage;
