import { platform } from './platform.js';
import {
  USDC_CONTRACT_ADDRESS,
  BASE_CHAIN_ID,
  USDC_DECIMALS,
} from '/shared/constants.js';

let ethers = null;

const USDC_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
];

const TX_RECEIPT_TIMEOUT_MS = 90_000;
const TX_RECEIPT_POLL_MS = 1_500;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForReceipt(provider, txHash) {
  const deadline = Date.now() + TX_RECEIPT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const receipt = await provider.getTransactionReceipt(txHash).catch(() => null);
    if (receipt) return receipt;
    await sleep(TX_RECEIPT_POLL_MS);
  }
  throw new Error('Transaction submitted but not confirmed yet. Check your wallet activity and try again.');
}

async function canUseFarcasterSendToken() {
  try {
    await platform.init();
  } catch {
    return false;
  }
  if (!platform.sdk?.actions || typeof platform.sdk.actions.sendToken !== 'function') {
    return false;
  }
  if (typeof platform.sdk.getCapabilities === 'function') {
    try {
      const capabilities = await platform.sdk.getCapabilities();
      return capabilities.includes('actions.sendToken');
    } catch {
      // Ignore and fall back to SDK shape check.
    }
  }
  return platform.type === 'farcaster';
}

async function loadEthers() {
  if (ethers) return ethers;
  const mod = await import('https://esm.sh/ethers@6');
  ethers = mod;
  return ethers;
}

async function getEIP1193Provider() {
  const farcasterProvider = await platform.getWalletProvider();
  if (farcasterProvider) return farcasterProvider;
  if (window.ethereum) return window.ethereum;
  return null;
}

function ensureOkResponse(res, body) {
  if (res.ok) return body;
  const message = body?.error || `Request failed (${res.status})`;
  throw new Error(message);
}

export async function hasWallet() {
  return !!(await getEIP1193Provider());
}

export async function connectWallet() {
  const lib = await loadEthers();
  const eip1193 = await getEIP1193Provider();

  if (!eip1193) {
    throw new Error('No wallet found. Install MetaMask/Coinbase or open inside Farcaster.');
  }

  // #region agent log
  fetch('http://127.0.0.1:7309/ingest/fa0e0030-c27e-4a3e-b67d-b2a351d6c4d9',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'5be6bb'},body:JSON.stringify({sessionId:'5be6bb',location:'wallet.js:connectWallet',message:'EIP1193 provider type',data:{platformType:platform.type,providerType:typeof eip1193,providerMethods:Object.keys(eip1193).slice(0,20),hasRequest:typeof eip1193.request},timestamp:Date.now(),hypothesisId:'H1-provider-capabilities'})}).catch(()=>{});
  // #endregion

  const provider = new lib.BrowserProvider(eip1193);
  await provider.send('eth_requestAccounts', []);

  const network = await provider.getNetwork();

  // #region agent log
  fetch('http://127.0.0.1:7309/ingest/fa0e0030-c27e-4a3e-b67d-b2a351d6c4d9',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'5be6bb'},body:JSON.stringify({sessionId:'5be6bb',location:'wallet.js:connectWallet:network',message:'Network after connect',data:{chainId:Number(network.chainId),networkName:network.name,expectedChainId:BASE_CHAIN_ID},timestamp:Date.now(),hypothesisId:'H2-chain-mismatch'})}).catch(()=>{});
  // #endregion

  if (Number(network.chainId) !== BASE_CHAIN_ID) {
    try {
      await eip1193.request({
        method: 'wallet_switchEthereumChain',
        params: [{ chainId: `0x${BASE_CHAIN_ID.toString(16)}` }],
      });
    } catch (switchErr) {
      if (switchErr?.code === 4902) {
        await eip1193.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: `0x${BASE_CHAIN_ID.toString(16)}`,
            chainName: 'Base',
            nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: ['https://mainnet.base.org'],
            blockExplorerUrls: ['https://basescan.org'],
          }],
        });
      } else {
        throw new Error('Please switch your wallet network to Base.');
      }
    }
    return connectWallet();
  }

  const signer = await provider.getSigner();
  const address = await signer.getAddress();
  return { provider, signer, address: address.toLowerCase() };
}

export async function getPaymentPrice() {
  const res = await fetch('/api/payment-price');
  const body = await res.json().catch(() => ({}));
  return ensureOkResponse(res, body);
}

export async function getWalletPaidStatus(walletAddress) {
  const query = new URLSearchParams({ walletAddress: walletAddress || '' }).toString();
  const res = await fetch(`/api/wallet-paid-status?${query}`);
  const body = await res.json().catch(() => ({}));
  return ensureOkResponse(res, body);
}

export async function sendUSDCPayment(recipientAddress, amountUSDC, walletContext = null) {
  const lib = await loadEthers();
  const wallet = walletContext || await connectWallet();
  const { provider, signer } = wallet;

  if (!recipientAddress || typeof recipientAddress !== 'string') {
    throw new Error('Missing payment recipient address.');
  }

  const amountUnits = lib.parseUnits(String(amountUSDC), USDC_DECIMALS);
  if (amountUnits <= 0n) {
    throw new Error('Payment amount must be greater than zero.');
  }

  const senderAddress = wallet.address || (await signer.getAddress()).toLowerCase();

  // #region agent log
  fetch('http://127.0.0.1:7309/ingest/fa0e0030-c27e-4a3e-b67d-b2a351d6c4d9',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'5be6bb'},body:JSON.stringify({sessionId:'5be6bb',location:'wallet.js:sendUSDCPayment:preBalance',message:'About to call balanceOf',data:{senderAddress,usdcContract:USDC_CONTRACT_ADDRESS,providerType:typeof provider,providerConstructorName:provider?.constructor?.name},timestamp:Date.now(),hypothesisId:'H1-provider-capabilities'})}).catch(()=>{});
  // #endregion

  // #region agent log — test raw eth_call to check H1 & H4
  let rawCallResult = 'not_attempted';
  try {
    rawCallResult = await provider.call({to: USDC_CONTRACT_ADDRESS, data: '0x70a08231000000000000000000000000' + senderAddress.replace('0x','')});
    fetch('http://127.0.0.1:7309/ingest/fa0e0030-c27e-4a3e-b67d-b2a351d6c4d9',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'5be6bb'},body:JSON.stringify({sessionId:'5be6bb',location:'wallet.js:sendUSDCPayment:rawCall',message:'Raw eth_call result',data:{rawCallResult,resultType:typeof rawCallResult},timestamp:Date.now(),hypothesisId:'H1-provider-capabilities'})}).catch(()=>{});
  } catch (rawErr) {
    fetch('http://127.0.0.1:7309/ingest/fa0e0030-c27e-4a3e-b67d-b2a351d6c4d9',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'5be6bb'},body:JSON.stringify({sessionId:'5be6bb',location:'wallet.js:sendUSDCPayment:rawCallError',message:'Raw eth_call FAILED',data:{error:rawErr?.message,code:rawErr?.code,dataField:rawErr?.data},timestamp:Date.now(),hypothesisId:'H1-provider-capabilities'})}).catch(()=>{});
  }
  // #endregion

  const readOnlyUsdc = new lib.Contract(USDC_CONTRACT_ADDRESS, USDC_ABI, provider);
  let balance;
  try {
    balance = await readOnlyUsdc.balanceOf(senderAddress);
  } catch (balErr) {
    // #region agent log
    fetch('http://127.0.0.1:7309/ingest/fa0e0030-c27e-4a3e-b67d-b2a351d6c4d9',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'5be6bb'},body:JSON.stringify({sessionId:'5be6bb',location:'wallet.js:sendUSDCPayment:balanceError',message:'balanceOf FAILED',data:{error:balErr?.message,code:balErr?.code,dataField:balErr?.data,reason:balErr?.reason,rawCallResult},timestamp:Date.now(),hypothesisId:'H1-provider-capabilities'})}).catch(()=>{});
    // #endregion
    throw balErr;
  }

  // #region agent log
  fetch('http://127.0.0.1:7309/ingest/fa0e0030-c27e-4a3e-b67d-b2a351d6c4d9',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'5be6bb'},body:JSON.stringify({sessionId:'5be6bb',location:'wallet.js:sendUSDCPayment:balanceOk',message:'balanceOf succeeded',data:{balance:balance?.toString(),senderAddress},timestamp:Date.now(),hypothesisId:'H1-provider-capabilities'})}).catch(()=>{});
  // #endregion

  if (balance < amountUnits) {
    throw new Error('Not enough USDC balance for this payment.');
  }

  if (await canUseFarcasterSendToken()) {
    const result = await platform.sdk.actions.sendToken({
      token: `eip155:${BASE_CHAIN_ID}/erc20:${USDC_CONTRACT_ADDRESS}`,
      amount: amountUnits.toString(),
      recipientAddress,
    });

    if (!result?.success || !result?.send?.transaction) {
      if (result?.reason === 'rejected_by_user') {
        throw new Error('Wallet request was canceled.');
      }
      const detail = result?.error?.message || result?.error?.error || 'Farcaster wallet failed to send USDC.';
      throw new Error(detail);
    }

    const receipt = await waitForReceipt(provider, result.send.transaction);
    return {
      txHash: receipt?.hash || result.send.transaction,
    };
  }

  const usdc = new lib.Contract(USDC_CONTRACT_ADDRESS, USDC_ABI, signer);
  const tx = await usdc.transfer(recipientAddress, amountUnits);
  const receipt = await tx.wait(1);

  return {
    txHash: receipt?.hash || tx.hash,
  };
}

export async function verifyPaymentWithServer({ txHash, walletAddress, playerId }) {
  const res = await fetch('/api/verify-payment', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ txHash, walletAddress, playerId }),
  });
  const body = await res.json().catch(() => ({}));
  return ensureOkResponse(res, body);
}

export async function recoverPaidAccount(walletContext = null) {
  const wallet = walletContext || await connectWallet();
  const walletAddress = wallet?.address;
  if (!walletAddress) {
    throw new Error('Wallet connection failed.');
  }

  const challengeRes = await fetch('/api/siwe/challenge', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress }),
  });
  const challengeBody = await challengeRes.json().catch(() => ({}));
  const challenge = ensureOkResponse(challengeRes, challengeBody);

  const signature = await wallet.signer.signMessage(challenge.message);
  const verifyRes = await fetch('/api/siwe/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      walletAddress,
      nonce: challenge.nonce,
      signature,
    }),
  });
  const verifyBody = await verifyRes.json().catch(() => ({}));
  const verified = ensureOkResponse(verifyRes, verifyBody);
  return {
    ...verified,
    walletAddress,
  };
}
