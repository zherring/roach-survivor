// Backward-compatible wrapper. Prefer importing from payment-config.js and payment-verifier.js.
export { verifyUSDCTransfer } from './payment-verifier.js';
export {
  BASE_CHAIN_ID,
  BASE_RPC_URL,
  PAYMENT_RECIPIENT_ADDRESS,
  USDC_CONTRACT_ADDRESS,
  USDC_DECIMALS,
  getPriceForPlayerCount,
  normalizeAddress,
} from './payment-config.js';
