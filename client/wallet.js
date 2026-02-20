import { platform } from './platform.js';
import {
  USDC_CONTRACT_ADDRESS,
  BASE_CHAIN_ID,
  USDC_DECIMALS,
} from '/shared/constants.js';

let ethers = null;

const USDC_ABI = [
  'function transfer(address to, uint256 amount) returns (bool)',
];

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

  const provider = new lib.BrowserProvider(eip1193);
  await provider.send('eth_requestAccounts', []);

  const network = await provider.getNetwork();
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
  const signer = walletContext?.signer || (await connectWallet()).signer;

  if (!recipientAddress || typeof recipientAddress !== 'string') {
    throw new Error('Missing payment recipient address.');
  }

  const amountUnits = lib.parseUnits(String(amountUSDC), USDC_DECIMALS);
  const usdc = new lib.Contract(USDC_CONTRACT_ADDRESS, USDC_ABI, signer);
  const tx = await usdc.transfer(recipientAddress, amountUnits);
  const receipt = await tx.wait();

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
