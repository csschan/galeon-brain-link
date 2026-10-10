/**
 * 智能合约地址配置
 * 包含: 稳定币、DEX Router、DEX Factory
 * 链: BSC, Base, Monad
 */

module.exports = {
  BSC: {
    // 稳定币
    USDT: '0x55d398326f99059fF775485246999027B3197955',
    BUSD: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56',

    // PancakeSwap V2
    PancakeRouterV2: '0x10ED43C718714eb63d5aA57B78B54704E256024E',
    PancakeFactoryV2: '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73',

    // PancakeSwap V3
    PancakeRouter: '0x13f4EA83D0bd40E75C8222255bc855a974568Dd4', // SmartRouter
    PancakeFactory: '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865',
    PancakeQuoter: '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997',

    // WBNB
    WBNB: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c',
  },

  Base: {
    // 稳定币
    USDC: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    USDbC: '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA', // Bridged USDC

    // Aerodrome DEX
    AerodromeRouter: '0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43',
    AerodromeFactory: '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',

    // WETH
    WETH: '0x4200000000000000000000000000000000000006',

    // 常用代币
    RECALL: '0x7c7c4d45f9e3e8e2adc2e1a89c4d6e1f8b5c6d7e', // 示例地址
  },

  Monad: {
    // 主网稳定币
    USDC: process.env.MONAD_USDC_ADDRESS || '0x754704Bc059F8C67012fEd69BC8A327a5aafb603',

    // Galeon Brain Link 合约 (Monad Mainnet)
    GaleonBrain: process.env.MONAD_GALEON_BRAIN_ADDRESS || '0xE1E61ecdc2C98f22A83E22a9207b43Bf64e63f98',
    GaleonRouter: process.env.MONAD_GALEON_ROUTER_ADDRESS || '0xB7D5aD3ff190B556de41832204530FdA006a85A2',

    // Kuru DEX (主网)
    KuruRouter: process.env.MONAD_KURU_ROUTER || '0xd651346d7c789536ebf06dc72aE3C8502cd695CC',
    KuruFlowEntrypoint: '0xb3e6778480b2E488385E8205eA05E20060B813cb',

    // Wrapped Token
    WMON: process.env.MONAD_WMON_ADDRESS || '0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A',
  }
};
