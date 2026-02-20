import {
  BASE_RPC_URL,
  USDC_CONTRACT_ADDRESS,
  normalizeAddress,
  usdcToBaseUnits,
  baseUnitsToUSDC,
} from './payment-config.js';

const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

async function rpcCall(method, params) {
  const res = await fetch(BASE_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) {
    throw new Error(`RPC HTTP ${res.status}`);
  }
  const body = await res.json();
  if (body.error) {
    throw new Error(body.error.message || 'RPC error');
  }
  return body.result;
}

function addressFromTopic(topic) {
  if (typeof topic !== 'string' || topic.length < 66) return '';
  return normalizeAddress(`0x${topic.slice(-40)}`);
}

function parseAmountFromLogData(data) {
  if (typeof data !== 'string' || !data.startsWith('0x')) return 0n;
  return BigInt(data);
}

export async function verifyUSDCTransfer({
  txHash,
  sender,
  recipient,
  minAmountUSDC,
}) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash || '')) {
    return { valid: false, reason: 'Invalid transaction hash' };
  }

  const senderAddress = normalizeAddress(sender);
  if (!senderAddress) {
    return { valid: false, reason: 'Invalid sender address' };
  }

  const recipientAddress = normalizeAddress(recipient);
  if (!recipientAddress) {
    return { valid: false, reason: 'Payment recipient not configured' };
  }

  const minBaseUnits = usdcToBaseUnits(minAmountUSDC);

  try {
    const receipt = await rpcCall('eth_getTransactionReceipt', [txHash]);
    if (!receipt) {
      return { valid: false, reason: 'Transaction not found or pending' };
    }

    if (receipt.status !== '0x1') {
      return { valid: false, reason: 'Transaction reverted' };
    }

    const usdcContract = normalizeAddress(USDC_CONTRACT_ADDRESS);
    let matchedLog = null;

    for (const log of receipt.logs || []) {
      if (normalizeAddress(log.address) !== usdcContract) continue;
      if (!Array.isArray(log.topics) || log.topics.length < 3) continue;
      if (log.topics[0] !== TRANSFER_TOPIC) continue;

      const from = addressFromTopic(log.topics[1]);
      const to = addressFromTopic(log.topics[2]);
      if (!from || !to) continue;
      if (from !== senderAddress) continue;
      if (to !== recipientAddress) continue;

      matchedLog = {
        from,
        to,
        amountBaseUnits: parseAmountFromLogData(log.data),
      };
      break;
    }

    if (!matchedLog) {
      return { valid: false, reason: 'No matching USDC transfer found' };
    }

    if (matchedLog.amountBaseUnits < minBaseUnits) {
      return {
        valid: false,
        reason: `Insufficient amount: ${baseUnitsToUSDC(matchedLog.amountBaseUnits)} < ${minAmountUSDC}`,
      };
    }

    return {
      valid: true,
      sender: matchedLog.from,
      recipient: matchedLog.to,
      amountBaseUnits: matchedLog.amountBaseUnits,
      amountUSDC: baseUnitsToUSDC(matchedLog.amountBaseUnits),
    };
  } catch (err) {
    return { valid: false, reason: `Verification failed: ${err.message}` };
  }
}
