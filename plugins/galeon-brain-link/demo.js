#!/usr/bin/env node
/**
 * Galeon Brain Link — MetaMask Agent Wallet Plugin Demo
 *
 * Simulates the `mm` CLI by running plugin commands with real API calls.
 * Usage: node demo.js [command] [args]
 *
 * Examples:
 *   node demo.js check MON
 *   node demo.js decision MON
 *   node demo.js risk MON 100
 *   node demo.js positions
 *   node demo.js status
 *   node demo.js auto-trade
 */

const BRAIN_API = 'https://brainlink.galeon.world/api/brain-link';
process.env.GALEON_BRAIN_API = BRAIN_API;

// Mock io object that mimics MetaMask Agent Wallet interface
function createIO(args = {}, flags = {}) {
  return {
    args,
    flags,
    log: (msg) => console.log(msg),
    wallet: {
      getAddress: async () => '0xeD4c2576A79D1BB10f9076A69b7Def188A97909A',
      submitTransaction: async (tx) => {
        console.log(`   📤 Agent submitting TX to ${tx.to.slice(0, 10)}...`);
        console.log(`      Chain: Monad (${tx.chainId})`);
        console.log(`      Data:  ${tx.data.slice(0, 20)}...`);
        return { hash: '0x' + 'a'.repeat(64) + ' (demo mode)' };
      },
    },
  };
}

async function main() {
  const [,, command, ...rest] = process.argv;

  console.log('');
  console.log('┌─────────────────────────────────────────────┐');
  console.log('│  mm — MetaMask Agent Wallet                  │');
  console.log('│  Plugin: @galeon/brain-link v0.1.0           │');
  console.log('└─────────────────────────────────────────────┘');
  console.log('');

  switch (command) {
    case 'check': {
      const token = rest[0] || 'MON';
      const amount = rest[1] || '100';
      console.log(`$ mm brain check ${token} --amount ${amount}\n`);
      const BrainCheck = require('./src/commands/brain/check.ts');
      const Cmd = BrainCheck.default || BrainCheck;
      const cmd = new Cmd();
      await cmd.execute(createIO({ token }, { amount }));
      break;
    }
    case 'decision': {
      const token = rest[0] || 'MON';
      console.log(`$ mm brain decision ${token}\n`);
      const BrainDecision = require('./src/commands/brain/decision.ts');
      const Cmd = BrainDecision.default || BrainDecision;
      const cmd = new Cmd();
      await cmd.execute(createIO({ token }));
      break;
    }
    case 'risk': {
      const token = rest[0] || 'MON';
      const amount = rest[1] || '100';
      console.log(`$ mm brain risk ${token} ${amount}\n`);
      const BrainRisk = require('./src/commands/brain/risk.ts');
      const Cmd = BrainRisk.default || BrainRisk;
      const cmd = new Cmd();
      cmd.ctx = { walletStateManager: { read: () => ({ byokWallets: [{ address: '0xeD4c2576A79D1BB10f9076A69b7Def188A97909A' }] }) } };
      await cmd.execute(createIO({ token, amount }));
      break;
    }
    case 'positions': {
      console.log('$ mm brain positions\n');
      const BrainPositions = require('./src/commands/brain/positions.ts');
      const Cmd = BrainPositions.default || BrainPositions;
      const cmd = new Cmd();
      await cmd.execute(createIO());
      break;
    }
    case 'status': {
      console.log('$ mm brain status\n');
      const BrainStatus = require('./src/commands/brain/status.ts');
      const Cmd = BrainStatus.default || BrainStatus;
      const cmd = new Cmd();
      await cmd.execute(createIO());
      break;
    }
    case 'auto-trade': {
      const disable = rest.includes('--disable');
      const maxPerTrade = rest.includes('--max-per-trade') ? rest[rest.indexOf('--max-per-trade') + 1] : '0.5';
      const totalLimit = rest.includes('--total-limit') ? rest[rest.indexOf('--total-limit') + 1] : '10';
      console.log(`$ mm brain auto-trade${disable ? ' --disable' : ` --max-per-trade ${maxPerTrade} --total-limit ${totalLimit}`}\n`);
      const BrainAutoTrade = require('./src/commands/brain/auto-trade.ts');
      const Cmd = BrainAutoTrade.default || BrainAutoTrade;
      const cmd = new Cmd();
      cmd.ctx = { walletStateManager: { read: () => ({ byokWallets: [{ address: '0xeD4c2576A79D1BB10f9076A69b7Def188A97909A' }] }) } };
      await cmd.execute(createIO({}, { disable, 'max-per-trade': maxPerTrade, 'total-limit': totalLimit }));
      break;
    }
    default: {
      console.log('Usage: node demo.js <command> [args]\n');
      console.log('Commands:');
      console.log('  check <token>           AI pre-trade check');
      console.log('  decision <token>        Full 12-dimension voting');
      console.log('  risk <token> <amount>   Risk assessment');
      console.log('  auto-trade              Enable AI auto-trading (wallet-submit)');
      console.log('  positions               View active positions');
      console.log('  status                  Service status');
      console.log('\nExamples:');
      console.log('  node demo.js check MON');
      console.log('  node demo.js decision WETH');
      console.log('  node demo.js auto-trade --max-per-trade 1 --total-limit 20');
    }
  }

  console.log('');
}

// Register ts-node if available for .ts imports
try { require('ts-node').register({ transpileOnly: true }); } catch {}
try { require('tsx/cjs'); } catch {}

main().catch(e => console.error('Error:', e.message));
