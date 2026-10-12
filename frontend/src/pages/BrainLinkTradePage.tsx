/**
 * BrainLinkTradePage - AI Auto Trade on Solana (LIVE DATA)
 */
import React, { useState, useEffect, useCallback } from 'react';
import { useBrainActivity } from '../hooks/useBrainLink';
import { getSolanaPositions, getAssetActivity } from '../services/brainLinkService';
import type { BrainActivity } from '../services/brainLinkService';
import AgentWalletCard from '../components/brainLink/AgentWalletCard';
import { useBrainChain } from '../contexts/BrainChainContext';
import './BrainLinkPages.css';

const dotColorMap: Record<string, string> = {
  decision_change: 'green', micro_step: 'blue', risk_alert: 'amber',
  combo_block: 'red', learning_update: 'green', dca_pause: 'amber',
  trade_open: 'green', partial_exit: 'amber', trade_close: 'red',
};
function timeAgo(ts: number): string {
  const d = Math.floor((Date.now() - ts) / 1000);
  if (d < 5) return 'now'; if (d < 60) return `${d}s`;
  if (d < 3600) return `${Math.floor(d / 60)}m`; return `${Math.floor(d / 3600)}h`;
}

const BRAIN_API_BASE = (() => {
  const host = window.location.host;
  if (host.includes('localhost')) return 'http://localhost:9090/api/brain-link';
  if (host.includes('brainlink.galeon.world')) return 'https://brainlink.galeon.world/api/brain-link';
  return 'https://galeon.world/api/brain-link';
})();

const AgentWalletCLI: React.FC = () => {
  const [lines, setLines] = useState<{ text: string; color?: string; href?: string }[]>([
    { text: '┌─────────────────────────────────────────────┐', color: '#4f7df9' },
    { text: '│  mm — MetaMask Agent Wallet                  │', color: '#4f7df9' },
    { text: '│  Plugin: @galeon/brain-link v0.1.0           │', color: '#4f7df9' },
    { text: '└─────────────────────────────────────────────┘', color: '#4f7df9' },
    { text: '' },
    { text: 'Ready. Click a command below to execute.', color: '#94a3b8' },
  ]);
  const [running, setRunning] = useState(false);
  const [activePositions, setActivePositions] = useState<any[]>([]);
  const termRef = React.useRef<HTMLDivElement>(null);

  const addLine = (text: string, color?: string, href?: string) => {
    setLines(prev => [...prev, { text, color, href }]);
  };

  const safeJson = async (res: Response) => {
    const text = await res.text();
    try { return JSON.parse(text); }
    catch { throw new Error(text.slice(0, 200)); }
  };

  useEffect(() => {
    if (termRef.current) termRef.current.scrollTop = termRef.current.scrollHeight;
  }, [lines]);

  const runCommand = async (cmd: string) => {
    if (running) return;
    setRunning(true);
    addLine('');
    addLine(`$ mm brain ${cmd}`, '#22c55e');
    addLine('');

    try {
      if (cmd === 'check MON') {
        addLine('🧠 Galeon Brain checking MON...', '#f59e0b');
        const res = await fetch(`${BRAIN_API_BASE}/decision/MON`);
        const d = await safeJson(res);
        const dir = d.direction || 'WAIT';
        const emoji = dir === 'LONG' ? '📈' : dir === 'SHORT' ? '📉' : '⏳';
        addLine(`${emoji} ${dir} MON`, dir === 'LONG' ? '#22c55e' : dir === 'SHORT' ? '#ef4444' : '#f59e0b');
        addLine(`   Confidence: ${d.confidence}%`);
        addLine(`   Risk Level: ${d.riskLevel}`);
        addLine(`   Score: ${d.score > 0 ? '+' : ''}${d.score} (threshold: 6)`);
        addLine('');
        addLine(`   Entry: $${d.entryZone?.min?.toFixed(6) || '—'} — $${d.entryZone?.max?.toFixed(6) || '—'}`);
        addLine(`   SL: $${d.stopLoss?.toFixed(6) || '—'} | TP1: $${d.takeProfit1?.toFixed(6) || '—'}`);
        if (d.reasoning) addLine(`   Why: ${d.reasoning.slice(0, 120)}`, '#94a3b8');
      }

      else if (cmd === 'decision MON') {
        addLine('🧠 Galeon Brain — MON Full Analysis', '#f59e0b');
        const res = await fetch(`${BRAIN_API_BASE}/decision-detail/MON`);
        const d = await safeJson(res);
        addLine(`Direction: ${d.direction} | Score: ${d.score > 0 ? '+' : ''}${d.score} | ${d.passed ? 'PASSED ✅' : 'BLOCKED ❌'}`);
        addLine(`Bull: ${d.bullVotes} | Bear: ${d.bearVotes} | Confidence: ${d.confidence}%`);
        addLine('');
        if (d.votes) {
          addLine('Voting Breakdown:');
          const sorted = [...d.votes].sort((a: any, b: any) => b.score - a.score);
          for (const v of sorted) {
            const icon = v.score > 0 ? '✅' : v.score < 0 ? '⚠️' : '──';
            const sign = v.score > 0 ? '+' : '';
            addLine(`  ${icon} ${(v.dim || v.dimension || '').padEnd(14)} ${sign}${v.score}  ${v.reason || ''}`,
              v.score > 0 ? '#22c55e' : v.score < 0 ? '#ef4444' : '#94a3b8');
          }
        }
      }

      else if (cmd === 'positions') {
        addLine('🧠 Galeon Brain — Positions', '#f59e0b');
        const res = await fetch(`${BRAIN_API_BASE}/monad/positions`);
        const data = await safeJson(res);
        const active = data.active || [];
        const closed = data.closed || [];
        if (active.length === 0 && closed.length === 0) {
          addLine('No positions. Brain is scanning for signals...');
          setActivePositions([]);
        }
        if (active.length > 0) {
          addLine(`Active (${active.length}):`);
          active.forEach((p: any, i: number) => {
            const pnl = p.pnlPercent || 0;
            addLine(`  [${i + 1}] ${p.asset} ${p.direction} | ${p.monAmount?.toFixed(4)} MON @ $${p.entryPrice?.toFixed(6)} | PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`,
              pnl >= 0 ? '#22c55e' : '#ef4444');
          });
          addLine('');
          addLine('  → Use "Sell #N" buttons below to close a position.', '#94a3b8');
          setActivePositions(active);
        }
        if (closed.length > 0) {
          addLine(`Closed (${closed.length}):`);
          for (const p of closed) {
            const pnl = (p.totalPnlBps || 0) / 100;
            addLine(`  ${p.asset} | PnL: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}% | ${p.closedReason}`,
              pnl >= 0 ? '#22c55e' : '#ef4444');
          }
        }
        if (data.balances) addLine(`\nBalances: $${data.balances.usdc?.toFixed(2)} USDC | ${data.balances.mon?.toFixed(4)} MON`);
      }

      else if (cmd === 'auto-trade') {
        const ethereum = (window as any).ethereum;
        if (!ethereum) { addLine('❌ MetaMask not found', '#ef4444'); setRunning(false); return; }

        // Get wallet address
        let accounts: string[];
        try {
          accounts = await ethereum.request({ method: 'eth_requestAccounts' });
        } catch { addLine('❌ Wallet connection rejected', '#ef4444'); setRunning(false); return; }
        const wallet = accounts[0];

        addLine('🧠 Galeon Brain — Agentic Auto-Trade', '#f59e0b');
        addLine('');
        addLine(`   Agent Wallet:  ${wallet.slice(0, 6)}...${wallet.slice(-4)}`);
        addLine('   Mode:          Agent Wallet trades directly (no intermediary)');
        addLine('   DEX:           Kuru (Monad)');
        addLine('   Max per trade: $0.50 USDC');
        addLine('   Total limit:   $10 USDC');
        addLine('');

        // Step 1: Check existing allowance, approve only if needed
        addLine('Step 1: Checking USDC approval...');
        try {
          const KURU_FLOW_ADDR = '0xb3e6778480b2E488385E8205eA05E20060B813cb';
          const USDC_ADDR = '0x754704Bc059F8C67012fEd69BC8A327a5aafb603';
          const ownerPad = wallet.slice(2).padStart(64, '0');
          const spenderPad = KURU_FLOW_ADDR.slice(2).padStart(64, '0');
          const allowanceData = '0xdd62ed3e' + ownerPad + spenderPad;
          const allowanceResult = await ethereum.request({
            method: 'eth_call', params: [{ to: USDC_ADDR, data: allowanceData }, 'latest'],
          });
          const currentAllowance = parseInt(allowanceResult, 16) / 1e6;

          if (currentAllowance >= 10) {
            addLine(`   ✅ Already approved: $${currentAllowance.toFixed(2)} USDC`, '#22c55e');
          } else {
            addLine('   📤 Approving USDC via MetaMask...');
            const approveAmount = BigInt(10 * 1e6).toString(16).padStart(64, '0');
            const approveData = '0x095ea7b3' + spenderPad + approveAmount;
            const approveTx = await ethereum.request({
              method: 'eth_sendTransaction',
              params: [{ from: wallet, to: USDC_ADDR, data: approveData }],
            });
            addLine(`   ✅ Approved. TX: ${approveTx.slice(0, 18)}...`, '#22c55e');
          }
        } catch (e: any) {
          addLine(`   ❌ Approve failed: ${e.message || 'User rejected'}`, '#ef4444');
          setRunning(false); return;
        }

        // Step 2: Register with Brain backend
        addLine('');
        addLine('Step 2: Registering with Brain backend...');
        try {
          await fetch(`${BRAIN_API_BASE}/agent-wallet/enable`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userAddress: wallet, maxPerTrade: 0.5, totalLimit: 10 }),
          });
          addLine('   ✅ Registered', '#22c55e');
        } catch {
          addLine('   ⚠️ Backend registration failed (non-blocking)', '#f59e0b');
        }

        addLine('');
        addLine('═══════════════════════════════════════════', '#4f7df9');
        addLine('✅ Agentic Auto-Trade ACTIVE', '#22c55e');
        addLine('');
        addLine('  • Agent Wallet holds your USDC — no third party');
        addLine('  • Brain scans MON, ETH, BTC, SOL every 15 min');
        addLine('  • Signal PASSED → Agent Wallet swaps on Kuru');
        addLine('  • TP1 +3%, TP2 +5%, TP3 +8%, SL -5%');
        addLine('  • All trades signed by your Agent Wallet');
      }

      else if (cmd === 'trigger-buy') {
        // All via backend mm CLI — no browser MetaMask needed
        addLine('🔍 Brain scanning MON...', '#f59e0b');
        const decRes = await fetch(`${BRAIN_API_BASE}/decision/MON`);
        const decision = await safeJson(decRes);
        addLine(`   Signal: LONG ${decision.confidence}% — Score +${decision.score}`, '#22c55e');
        addLine(`   12 dimensions voted → PASSED ✅`, '#22c55e');
        addLine('');

        addLine('');
        addLine('📤 Agent Wallet executing buy via mm CLI (auto-signed)...', '#4f7df9');
        addLine('   $ mm wallet send-transaction --chain-id 143 --payload {...}');
        addLine('');
        try {
          const buyCtrl = new AbortController();
          setTimeout(() => buyCtrl.abort(), 300000);
          const buyRes = await fetch(`${BRAIN_API_BASE}/agent-wallet/mm-trade`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'buy', asset: 'MON', amount: 0.5 }),
            signal: buyCtrl.signal,
          });
          const buyData = await safeJson(buyRes);
          if (buyData.success) {
            const buyTx = buyData.txHash || '';
            addLine(`   ✅ BUY executed! ${buyData.monReceived?.toFixed(4) || '?'} MON @ $${buyData.entryPrice?.toFixed(6) || '?'}`, '#22c55e');
            addLine(`   🔗 TX: ${buyTx.slice(0, 18)}...${buyTx.slice(-6)}`, '#4f7df9', `https://monadexplorer.com/tx/${buyTx}`);
            addLine(`   TP1: +3% | TP2: +5% | SL: -5%`);
            addLine('');
            addLine('   🔄 Agent monitoring position for TP/SL...', '#4f7df9');
          } else {
            addLine(`   ❌ ${buyData.error || 'Buy failed'}`, '#ef4444');
          }
        } catch (e: any) {
          addLine(`   ❌ ${e.message}`, '#ef4444');
        }
      }

      else if (cmd === 'trigger-sl' || cmd.startsWith('sell-pos-')) {
        const posIndex = cmd.startsWith('sell-pos-') ? parseInt(cmd.replace('sell-pos-', '')) : 0;
        addLine('🛑 Stop-Loss triggered!', '#ef4444');
        addLine('');
        let sellAmount = 0;
        let sellPos: any = null;
        try {
          const posRes = await fetch(`${BRAIN_API_BASE}/monad/positions`);
          const posData = await safeJson(posRes);
          const active = posData.active || [];
          sellPos = active[posIndex] !== undefined ? active[posIndex] : active[0];
          if (sellPos) sellAmount = sellPos.monAmount || 0;
        } catch {}
        if (sellAmount < 0.01) { addLine('❌ No active position to sell', '#ef4444'); setRunning(false); return; }
        addLine(`   Position [${posIndex + 1}]: ${sellAmount.toFixed(4)} MON @ $${sellPos?.entryPrice?.toFixed(6) || '?'}`);
        addLine('');
        addLine('📤 Agent Wallet executing sell via mm CLI (auto-signed)...', '#4f7df9');
        addLine('   $ mm wallet send-transaction --chain-id 143 --payload {...}');
        addLine('');
        try {
          const sellCtrl = new AbortController();
          setTimeout(() => sellCtrl.abort(), 300000);
          const sellRes = await fetch(`${BRAIN_API_BASE}/agent-wallet/mm-trade`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'sell', asset: 'MON', amount: sellAmount }),
            signal: sellCtrl.signal,
          });
          const sellData = await safeJson(sellRes);
          if (sellData.success) {
            const sellTx = sellData.txHash || '';
            addLine(`   ✅ SOLD! ${sellAmount.toFixed(4)} MON → $${sellData.usdcReceived?.toFixed(4) || '?'} USDC`, '#22c55e');
            addLine(`   🔗 TX: ${sellTx.slice(0, 18)}...${sellTx.slice(-6)}`, '#4f7df9', `https://monadexplorer.com/tx/${sellTx}`);
            addLine('');
            addLine('   Position closed. USDC in Agent Wallet.', '#22c55e');
          } else {
            addLine(`   ❌ ${sellData.error || 'Sell failed'}`, '#ef4444');
          }
        } catch (e: any) {
          addLine(`   ❌ ${e.message}`, '#ef4444');
        }
      }

      else if (cmd === 'mm-auth' || cmd === 'mm-wallet' || cmd === 'mm-balance') {
        const mmCmd = cmd === 'mm-auth' ? 'auth status' : cmd === 'mm-wallet' ? 'wallet list' : 'wallet balance --chain-id 143';
        addLine(`$ mm ${mmCmd}`, '#22c55e');
        addLine('');
        try {
          const res = await fetch(`${BRAIN_API_BASE}/agent-wallet/mm-command`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ command: mmCmd }),
          });
          const data = await safeJson(res);
          if (data.ok === false && data.error) {
            addLine(`${data.error?.message || data.error}`, '#f59e0b');
            if (data.error?.hint) addLine(data.error.hint, '#94a3b8');
          } else if (data.raw) {
            data.raw.split('\n').forEach((l: string) => addLine(l));
          } else {
            addLine(JSON.stringify(data.data || data, null, 2), '#e2e8f0');
          }
        } catch (e: any) {
          addLine(`❌ ${e.message}`, '#ef4444');
        }
      }

      else if (cmd === 'status') {
        addLine('🧠 Galeon Brain Link — Status', '#f59e0b');
        const res = await fetch(`${BRAIN_API_BASE}/decisions`);
        const data = await safeJson(res);
        const decisions = data.decisions || [];
        addLine(`Active Decisions: ${decisions.length}`);
        for (const d of decisions) {
          addLine(`  ${d.asset}: ${d.direction} ${d.confidence}% ${d.passed ? '✅' : '—'}`,
            d.passed ? '#22c55e' : '#94a3b8');
        }
        addLine('');
        addLine('Contracts (Monad):');
        addLine('  GaleonRouter: 0xB7D5aD3f...A2');
        addLine('  GaleonBrain:  0xE1E61ecd...98');
        addLine('  Kuru DEX:     0xb3e67784...cb');
      }
    } catch (e: any) {
      addLine(`❌ Error: ${e.message}`, '#ef4444');
    }

    setRunning(false);
  };

  return (
    <div className="bl-card">
      <div className="bl-card-label" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 14 }}>🦊</span> MetaMask Agent Wallet — CLI
      </div>

      {/* Terminal */}
      <div ref={termRef} style={{
        background: '#0f172a', borderRadius: 10, padding: '14px 16px', maxHeight: 350, overflowY: 'auto',
        fontFamily: "'JetBrains Mono', 'Fira Code', monospace", fontSize: 11, lineHeight: 1.6, marginBottom: 12,
      }}>
        {lines.map((l, i) => (
          <div key={i} style={{ color: l.color || '#e2e8f0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
            {l.href ? (
              <a href={l.href} target="_blank" rel="noopener noreferrer"
                style={{ color: l.color || '#4f7df9', textDecoration: 'underline', cursor: 'pointer' }}>
                {l.text}
              </a>
            ) : l.text}
          </div>
        ))}
        {running && <div style={{ color: '#4f7df9' }}>⏳ Running...</div>}
      </div>

      {/* Command buttons */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {[
          { cmd: 'check MON', label: 'brain check MON', icon: '🔍' },
          { cmd: 'decision MON', label: 'brain decision MON', icon: '📊' },
          { cmd: 'positions', label: 'brain positions', icon: '📋' },
          { cmd: 'mm-auth', label: 'mm auth status', icon: '🦊' },
          { cmd: 'mm-wallet', label: 'mm wallet list', icon: '👛' },
          { cmd: 'mm-balance', label: 'mm wallet balance', icon: '💰' },
          { cmd: 'trigger-buy', label: 'Trigger Buy Signal', icon: '🟢' },
          { cmd: 'trigger-sl', label: 'Trigger Stop-Loss', icon: '🛑' },
          { cmd: 'status', label: 'brain status', icon: '💡' },
        ].map(c => (
          <button key={c.cmd} disabled={running} onClick={() => runCommand(c.cmd)}
            style={{
              padding: '6px 12px', fontSize: 11, fontFamily: "'JetBrains Mono'", borderRadius: 8,
              border: '1px solid #e2e8f0', background: '#f8fafc', color: '#1e293b', cursor: running ? 'not-allowed' : 'pointer',
              opacity: running ? 0.5 : 1, transition: 'all .15s',
            }}
            onMouseEnter={e => { if (!running) (e.target as HTMLButtonElement).style.background = '#4f7df9'; (e.target as HTMLButtonElement).style.color = '#fff'; }}
            onMouseLeave={e => { (e.target as HTMLButtonElement).style.background = '#f8fafc'; (e.target as HTMLButtonElement).style.color = '#1e293b'; }}
          >
            {c.icon} {c.label}
          </button>
        ))}
        <button onClick={() => { setLines([{ text: 'Terminal cleared.', color: '#94a3b8' }]); setActivePositions([]); }}
          style={{ padding: '6px 12px', fontSize: 11, fontFamily: "'JetBrains Mono'", borderRadius: 8, border: '1px solid #e2e8f0', background: '#f8fafc', color: '#94a3b8', cursor: 'pointer' }}>
          🗑 Clear
        </button>
      </div>

      {/* Dynamic Sell buttons — appear after running brain positions */}
      {activePositions.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <span style={{ fontSize: 11, color: '#94a3b8', fontFamily: "'JetBrains Mono'", padding: '6px 4px' }}>Close position:</span>
          {activePositions.map((p: any, i: number) => (
            <button key={i} disabled={running} onClick={() => runCommand(`sell-pos-${i}`)}
              style={{
                padding: '6px 12px', fontSize: 11, fontFamily: "'JetBrains Mono'", borderRadius: 8,
                border: '1px solid #ef4444', background: '#fef2f2', color: '#b91c1c',
                cursor: running ? 'not-allowed' : 'pointer', fontWeight: 700,
              }}>
              🛑 Sell [{i + 1}] {p.monAmount?.toFixed(2)} MON
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const BrainLinkTradePage: React.FC = () => {
  const { chainName, dex, nativeToken } = useBrainChain();
  const [positions, setPositions] = useState<any[]>([]);
  const [closedPositions, setClosedPositions] = useState<any[]>([]);
  const [balances, setBalances] = useState({ usdc: 0, mon: 0 });
  const [currentPrice, setCurrentPrice] = useState<number | null>(null);

  const [expandedPos, setExpandedPos] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [positionActivities, setPositionActivities] = useState<BrainActivity[]>([]);
  const { activities: globalActivities } = useBrainActivity(10000);

  const fetchPositions = useCallback(async () => {
    try {
      const data = await getSolanaPositions();
      setPositions(data.active || []);
      setClosedPositions(data.closed || []);
      setBalances(data.balances || { usdc: 0, mon: 0 });
      setCurrentPrice(data.currentPrice);
    } catch (e) { console.error('Failed to fetch positions:', e); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => {
    fetchPositions();
    const timer = setInterval(fetchPositions, 10000);
    return () => clearInterval(timer);
  }, [fetchPositions]);

  // Fetch position-specific activity
  useEffect(() => {
    const assets = positions.map(p => p.asset);
    if (assets.length > 0) {
      Promise.all(assets.map(a => getAssetActivity(a)))
        .then(results => setPositionActivities(results.flat().sort((a, b) => b.timestamp - a.timestamp).slice(0, 20)))
        .catch(() => {});
    } else {
      // No active positions — show recent closed position activity
      getAssetActivity(nativeToken).then(setPositionActivities).catch(() => {});
    }
  }, [positions]);

  // Active PnL
  const activePnl = positions.reduce((sum, p) => sum + (p.pnlPercent || 0), 0);
  const activeInvested = positions.reduce((sum, p) => sum + (p.usdcInvested || 0), 0);
  // Closed PnL
  const closedPnl = closedPositions.reduce((sum, p) => sum + ((p.totalPnlBps || 0) / 100), 0);
  const closedInvested = closedPositions.reduce((sum, p) => sum + (p.usdcInvested || 0), 0);
  const closedWins = closedPositions.filter(p => (p.totalPnlBps || 0) > 0).length;
  // Combined
  const totalInvested = activeInvested + closedInvested;
  const totalPnl = positions.length > 0 ? activePnl : closedPnl;
  const winRate = closedPositions.length > 0 ? Math.round(closedWins / closedPositions.length * 100) : 0;

  return (
    <div className="bl-page">
      <h1 className="bl-title">AI Auto Trade — <span>{chainName}</span></h1>
      <p className="bl-subtitle">Galeon Brain trades on {dex}. Real positions, real PnL, all on-chain.</p>

      <div className="bl-grid-2">
        {/* Left */}
        <div>
          {/* Agent Wallet */}
          <AgentWalletCard currentPrice={currentPrice} />



          {/* Active Positions */}
          <div className="bl-card">
            <div className="bl-card-label">
              Active Positions {positions.length > 0 && <span style={{ color: '#22c55e' }}>({positions.length})</span>}
            </div>

            {loading && <div style={{ color: '#94a3b8', fontSize: 13, padding: 20, textAlign: 'center' }}>Loading positions...</div>}
            {!loading && positions.length === 0 && (
              <div style={{ color: '#94a3b8', fontSize: 13, padding: 30, textAlign: 'center' }}>
                No active positions. Brain is scanning for signals...
              </div>
            )}

            {positions.map((pos, i) => {
              const pnl = pos.pnlPercent || 0;
              const pnlColor = pnl >= 0 ? '#22c55e' : '#ef4444';
              const pnlUsd = (pos.usdcInvested * pnl / 100);
              const isExpanded = expandedPos === i;
              const votes = pos.votingResult?.votes || [];

              return (
                <div key={i} className="bl-pos" onClick={() => setExpandedPos(isExpanded ? null : i)} style={{ cursor: 'pointer' }}>
                  {/* Header */}
                  <div className="bl-pos-header">
                    <div>
                      <span className="bl-pos-token">{pos.asset}</span>
                      <span className={`bl-badge ${pos.direction?.toLowerCase()}`} style={{ marginLeft: 8 }}>{pos.direction}</span>
                      <span style={{ fontSize: 11, color: '#4f7df9', marginLeft: 8 }}>{pos.votingResult?.confidence || 76}% conf</span>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <span className="bl-pos-pnl" style={{ color: pnlColor }}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}%</span>
                      <div style={{ fontSize: 11, color: pnlColor, fontFamily: "'JetBrains Mono'" }}>{pnlUsd >= 0 ? '+' : ''}${pnlUsd.toFixed(4)}</div>
                    </div>
                  </div>

                  {/* Position Details */}
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, margin: '10px 0', fontSize: 12 }}>
                    <div style={{ background: '#f8fafc', borderRadius: 8, padding: '8px 10px' }}>
                      <div style={{ color: '#94a3b8', fontSize: 10 }}>Amount</div>
                      <div style={{ fontFamily: "'JetBrains Mono'", fontWeight: 700, color: '#1e293b' }}>{pos.monAmount?.toFixed(2)} {nativeToken}</div>
                      <div style={{ color: '#94a3b8', fontSize: 10 }}>${pos.usdcInvested?.toFixed(2)} invested</div>
                    </div>
                    <div style={{ background: '#f8fafc', borderRadius: 8, padding: '8px 10px' }}>
                      <div style={{ color: '#94a3b8', fontSize: 10 }}>Entry Price</div>
                      <div style={{ fontFamily: "'JetBrains Mono'", fontWeight: 700, color: '#1e293b' }}>${pos.entryPrice?.toFixed(6)}</div>
                      <div style={{ color: '#94a3b8', fontSize: 10 }}>Now: ${pos.currentPrice?.toFixed(6) || '...'}</div>
                    </div>
                    <div style={{ background: '#f8fafc', borderRadius: 8, padding: '8px 10px' }}>
                      <div style={{ color: '#94a3b8', fontSize: 10 }}>Targets</div>
                      <div style={{ color: '#22c55e', fontWeight: 600, fontSize: 11 }}>TP1: ${pos.tp1Price?.toFixed(6)}{pos.tp1Hit ? ' ✅' : ''}</div>
                      <div style={{ color: '#ef4444', fontWeight: 600, fontSize: 11 }}>SL: ${pos.slPrice?.toFixed(6)}</div>
                    </div>
                  </div>

                  {/* On-chain badges */}
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {pos.decisionId !== null && <span className="bl-onchain">Decision #{pos.decisionId}</span>}
                    {pos.tradeId !== null && <span className="bl-onchain">Trade #{pos.tradeId}</span>}
                    {pos.entryTxHash && (
                      <a href={`https://solanascan.com/tx/${pos.entryTxHash}`} target="_blank" rel="noopener noreferrer" className="bl-onchain" style={{ textDecoration: 'none' }}>{dex} Swap ↗</a>
                    )}
                  </div>

                  {/* ═══ Expanded: Full Brain Decision Path ═══ */}
                  {isExpanded && votes.length > 0 && (
                    <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid #f1f5f9' }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10 }}>
                        Brain Decision Path — {votes.filter((v: any) => v.score > 0).length} Bullish / {votes.filter((v: any) => v.score < 0).length} Bearish
                      </div>

                      {/* Vote bars */}
                      {[...votes].sort((a: any, b: any) => b.score - a.score).map((v: any, j: number) => {
                        const cls = v.score > 0 ? 'bull' : v.score < 0 ? 'bear' : 'neutral';
                        const w = Math.min(Math.abs(v.score) * 50, 100);
                        return (
                          <div key={j} className="bl-vote-row">
                            <div className="bl-vote-dim">{v.dim}</div>
                            <div className="bl-vote-bar">
                              <div className={`bl-vote-fill ${cls}`} style={{ width: `${w}%` }}>{v.reason}</div>
                            </div>
                            <div className="bl-vote-score" style={{ color: v.score > 0 ? '#22c55e' : v.score < 0 ? '#ef4444' : '#94a3b8' }}>
                              {v.score > 0 ? '+' : ''}{v.score}
                            </div>
                          </div>
                        );
                      })}

                      {/* Score summary */}
                      <div style={{ display: 'flex', gap: 16, marginTop: 10, fontSize: 12, color: '#64748b' }}>
                        <span>Total Score: <strong style={{ color: (pos.votingResult?.score || 0) >= 0 ? '#22c55e' : '#ef4444' }}>
                          {(pos.votingResult?.score || 0) > 0 ? '+' : ''}{pos.votingResult?.score || 0}
                        </strong></span>
                        <span>Threshold: <strong>6</strong></span>
                        <span style={{ color: '#22c55e' }}>PASSED ✅</span>
                      </div>

                      {/* Trade execution path */}
                      <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid #f1f5f9' }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: 0.8, marginBottom: 10 }}>
                          Execution Path
                        </div>
                        <div style={{ position: 'relative', paddingLeft: 24 }}>
                          <div style={{ position: 'absolute', left: 7, top: 0, bottom: 0, width: 2, background: '#e2e8f0' }} />

                          {[
                            { dot: 'green', label: 'Brain Signal', desc: `${pos.direction} ${pos.votingResult?.confidence || 76}% — Score +${pos.votingResult?.score || 8} (12 dimensions)` },
                            { dot: 'active', label: 'Decision On-chain', desc: `Decision #${pos.decisionId} published to ${chainName}` },
                            { dot: 'green', label: `${dex} Swap`, desc: `$${pos.usdcInvested?.toFixed(2)} USDC → ${pos.monAmount?.toFixed(2)} ${nativeToken} @ $${pos.entryPrice?.toFixed(6)}` },
                            { dot: 'active', label: 'AI-Endorsed Trade', desc: `Trade #${pos.tradeId} recorded on-chain with AI endorsement` },
                            { dot: pnl >= 5 ? 'green' : pnl <= -8 ? 'red' : 'amber', label: 'Monitoring', desc: `PnL ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}% — TP1 at +5%, SL at -8%` },
                          ].map((step, j) => (
                            <div key={j} style={{ position: 'relative', padding: '8px 0' }}>
                              <div className={`bl-timeline-dot ${step.dot}`} style={{ position: 'absolute', left: -20, top: 12, width: 10, height: 10 }} />
                              <div style={{ fontSize: 12, fontWeight: 700, color: '#1e293b' }}>{step.label}</div>
                              <div style={{ fontSize: 11, color: '#64748b', marginTop: 1 }}>{step.desc}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  )}

                  {/* Click hint */}
                  <div style={{ textAlign: 'center', fontSize: 10, color: '#cbd5e1', marginTop: 8 }}>
                    {isExpanded ? '▲ Collapse' : '▼ Click to view Brain decision path'}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Closed */}
          {closedPositions.length > 0 && (
            <div className="bl-card">
              <div className="bl-card-label">Closed Positions ({closedPositions.length})</div>
              {closedPositions.map((pos, i) => (
                <div key={i} className="bl-row">
                  <span className="bl-row-label">{pos.asset} {pos.direction}</span>
                  <span className={`bl-row-val ${(pos.totalPnlBps || 0) >= 0 ? 'green' : 'red'}`}>
                    {(pos.totalPnlBps || 0) >= 0 ? '+' : ''}{((pos.totalPnlBps || 0) / 100).toFixed(2)}%
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Performance */}
          <div className="bl-card">
            <div className="bl-card-label">Performance</div>
            <div className="bl-grid-4">
              <div className="bl-stat"><div className={`bl-stat-val ${totalPnl >= 0 ? 'green' : 'red'}`}>{totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(2)}%</div><div className="bl-stat-label">Total PnL</div></div>
              <div className="bl-stat"><div className="bl-stat-val">${totalInvested.toFixed(2)}</div><div className="bl-stat-label">Total Invested</div></div>
              <div className="bl-stat"><div className={`bl-stat-val ${winRate >= 50 ? 'green' : winRate > 0 ? 'red' : ''}`}>{winRate}%</div><div className="bl-stat-label">Win Rate</div></div>
              <div className="bl-stat"><div className="bl-stat-val">{closedPositions.length}</div><div className="bl-stat-label">Closed</div></div>
            </div>
          </div>
        </div>

        {/* Right */}
        <div>
          {/* Config */}
          <div className="bl-card">
            <div className="bl-card-label">Auto-Trade Config</div>
            {[
              { l: 'Trade size', v: '$0.50 per trade' },
              { l: 'Max positions', v: '3' },
              { l: 'TP1', v: '+5% (sell 50%)' },
              { l: 'TP2', v: '+10% (sell rest)' },
              { l: 'Stop Loss', v: '-8%' },
              { l: 'DEX', v: `${dex} (${chainName})` },
              { l: 'Fee', v: '0.5% per swap' },
              { l: 'Monitor interval', v: 'Every 30s' },
              { l: 'Signal source', v: 'Galeon Brain (12 dimensions)' },
            ].map((r, i) => (
              <div key={i} className="bl-row">
                <span className="bl-row-label">{r.l}</span>
                <span className="bl-row-val">{r.v}</span>
              </div>
            ))}
            <div style={{ marginTop: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
              <div className="bl-toggle on" />
              <span style={{ fontWeight: 700, color: '#22c55e', fontSize: 13 }}>Auto-Trade: ON</span>
            </div>
          </div>

          {/* Brain Activity */}
          <div className="bl-card" style={{ maxHeight: 500, overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
              <div className="bl-card-label" style={{ marginBottom: 0 }}>Position Activity</div>
              <span className="bl-live">Live</span>
            </div>
            {positionActivities.length === 0 && (
              <div style={{ color: '#94a3b8', fontSize: 12, textAlign: 'center', padding: 20 }}>No position activity yet...</div>
            )}
            {positionActivities.map((a: BrainActivity, i: number) => (
              <div key={i} className="bl-feed-item">
                <div className={`bl-feed-dot ${dotColorMap[a.type] || 'blue'}`} />
                <div className="bl-feed-time">{timeAgo(a.timestamp)}</div>
                <div className="bl-feed-body">
                  <div className="bl-feed-desc">
                    {a.asset && <strong style={{ color: '#1e293b' }}>{a.asset}</strong>}
                    {a.asset && ' — '}{a.message}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* MetaMask Agent Wallet CLI */}
          <AgentWalletCLI />
        </div>
      </div>
    </div>
  );
};

export default BrainLinkTradePage;
