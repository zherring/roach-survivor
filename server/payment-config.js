const BASE_MAINNET_RPC = 'https://mainnet.base.org';

export const BASE_CHAIN_ID = 8453;
export const USDC_DECIMALS = 6;
export const USDC_CONTRACT_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export const BASE_RPC_URL = process.env.BASE_RPC_URL || BASE_MAINNET_RPC;

// Keep TREASURY_ADDRESS fallback for backwards compatibility.
const recipientRaw = process.env.PAYMENT_RECIPIENT_ADDRESS || process.env.TREASURY_ADDRESS || '';
export const PAYMENT_RECIPIENT_ADDRESS = normalizeAddress(recipientRaw);

export const PRICING_TIERS = Object.freeze([
  { threshold: 10, price: 0.01 },
  { threshold: 35, price: 0.25 },
  { threshold: 135, price: 1.0 },
  { threshold: 235, price: 2.5 },
  { threshold: Infinity, price: 5.0 },
]);

export function normalizeAddress(value) {
  if (!value || typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(trimmed)) return '';
  return trimmed.toLowerCase();
}

export function isValidAddress(value) {
  return normalizeAddress(value) !== '';
}

export function getPriceForPlayerCount(paidCount) {
  const count = Number.isFinite(paidCount) ? Math.max(0, Math.floor(paidCount)) : 0;
  for (const tier of PRICING_TIERS) {
    if (count < tier.threshold) return tier.price;
  }
  return PRICING_TIERS[PRICING_TIERS.length - 1].price;
}

export function usdcToBaseUnits(amountUSDC) {
  if (!Number.isFinite(amountUSDC) || amountUSDC < 0) return 0n;
  return BigInt(Math.round(amountUSDC * (10 ** USDC_DECIMALS)));
}

export function baseUnitsToUSDC(baseUnits) {
  const units = typeof baseUnits === 'bigint' ? baseUnits : BigInt(baseUnits || 0);
  return Number(units) / (10 ** USDC_DECIMALS);
}
