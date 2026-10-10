/**
 * BrainLinkLanding - Chain selector page
 * brainlink.galeon.world/ → choose Monad or Solana
 */
import React from 'react';
import { useNavigate } from 'react-router-dom';
import './BrainLinkPages.css';

const chains = [
  {
    key: 'monad',
    name: 'Monad',
    desc: 'AI-powered trading on Monad with ultra-fast execution',
    path: '/monad',
    color: '#7c3aed',
    bg: 'linear-gradient(135deg, #7c3aed 0%, #a78bfa 100%)',
    features: ['10,000 TPS', 'EVM Compatible', 'Monad DEX'],
  },
  {
    key: 'solana',
    name: 'Solana',
    desc: 'AI-powered trading on Solana via Jupiter aggregator',
    path: '/solana',
    color: '#14f195',
    bg: 'linear-gradient(135deg, #9945ff 0%, #14f195 100%)',
    features: ['400ms Blocks', 'Jupiter DEX', 'Phantom Wallet'],
  },
];

const BrainLinkLanding: React.FC = () => {
  const navigate = useNavigate();

  return (
    <div style={{ minHeight: '100vh', background: '#f5f7fb', fontFamily: "'Inter', sans-serif" }}>
      {/* Header */}
      <nav style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#fff', borderBottom: '1px solid #e2e8f0',
        boxShadow: '0 1px 4px rgba(0,0,0,0.04)', padding: '16px 24px',
      }}>
        <div style={{ fontWeight: 800, fontSize: 18, color: '#1e293b', display: 'flex', alignItems: 'center', gap: 8 }}>
          🧠 <span style={{ color: '#4f7df9' }}>Galeon</span> Brain Link
        </div>
      </nav>

      <div className="bl-page" style={{ maxWidth: 800, margin: '0 auto' }}>
        <h1 className="bl-title" style={{ textAlign: 'center', marginTop: 60 }}>
          Galeon <span>Brain Link</span>
        </h1>
        <p className="bl-subtitle" style={{ textAlign: 'center', marginBottom: 48 }}>
          AI-powered trading intelligence. Choose your chain.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
          {chains.map(c => (
            <div
              key={c.key}
              onClick={() => navigate(c.path)}
              style={{
                background: '#fff', borderRadius: 16, overflow: 'hidden',
                border: '1px solid #e2e8f0', cursor: 'pointer',
                transition: 'all 0.25s', boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
              }}
              onMouseEnter={e => {
                (e.currentTarget as HTMLDivElement).style.transform = 'translateY(-4px)';
                (e.currentTarget as HTMLDivElement).style.boxShadow = '0 8px 30px rgba(0,0,0,0.1)';
              }}
              onMouseLeave={e => {
                (e.currentTarget as HTMLDivElement).style.transform = 'none';
                (e.currentTarget as HTMLDivElement).style.boxShadow = '0 2px 12px rgba(0,0,0,0.04)';
              }}
            >
              {/* Gradient banner */}
              <div style={{ background: c.bg, padding: '32px 24px', textAlign: 'center' }}>
                <div style={{ fontSize: 36, fontWeight: 900, color: '#fff', textShadow: '0 2px 8px rgba(0,0,0,0.2)' }}>
                  {c.name}
                </div>
              </div>

              <div style={{ padding: '20px 24px' }}>
                <p style={{ fontSize: 14, color: '#64748b', marginBottom: 16, lineHeight: 1.6 }}>{c.desc}</p>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                  {c.features.map(f => (
                    <span key={f} style={{
                      fontSize: 11, fontWeight: 600, color: '#4f7df9', background: '#f0f4ff',
                      padding: '4px 10px', borderRadius: 6,
                    }}>{f}</span>
                  ))}
                </div>
                <button className="bl-btn bl-btn-primary" style={{ width: '100%', padding: '12px 0', fontSize: 14 }}>
                  Enter {c.name} Brain Link →
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default BrainLinkLanding;
