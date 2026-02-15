// Platform detection and SDK adapter for Farcaster, Base App, and standalone browser.
// World App support is a stretch goal — detection is attempted but not prioritized.
// Loads SDKs dynamically via CDN — no build step required.
//
// Priority: Farcaster/Base App (primary) > World App (stretch) > standalone (fallback)

const FARCASTER_SDK_URL = 'https://esm.sh/@farcaster/miniapp-sdk@latest';
const WORLD_SDK_URL = 'https://cdn.jsdelivr.net/npm/@worldcoin/minikit-js@latest/+esm';

class Platform {
  constructor() {
    this.type = 'standalone'; // 'farcaster' | 'base' | 'world' | 'standalone'
    this.sdk = null;
    this.context = null;
    this._ready = false;
  }

  async init() {
    // Detect platform by checking environment signals
    if (await this._tryFarcaster()) return;
    if (await this._tryWorld()) return;
    // Standalone fallback — no SDK needed
    this.type = 'standalone';
    this._ready = true;
  }

  async _tryFarcaster() {
    // Farcaster/Base miniapp context injects signals into the page.
    // The SDK always exports actions.ready(), so we can't use that to detect context.
    // Instead, check sdk.context which is only populated inside a Farcaster client.
    try {
      const mod = await import(FARCASTER_SDK_URL);
      const sdk = mod.default || mod;

      // sdk.context is only available when running inside a Farcaster/Base client
      const context = sdk.context;
      if (!context || !context.user) {
        return false; // SDK loaded but we're not in a miniapp context
      }

      this.sdk = sdk;
      this.context = context;
      this.type = 'farcaster';

      // Signal to the host app that we're ready
      if (typeof sdk.actions?.ready === 'function') {
        sdk.actions.ready();
      }
      this._ready = true;
      console.log(`[platform] Detected Farcaster miniapp context (fid: ${context.user.fid})`);
      return true;
    } catch (e) {
      // SDK import failed or not in Farcaster context — continue detection
    }
    return false;
  }

  async _tryWorld() {
    try {
      const mod = await import(WORLD_SDK_URL);
      const MiniKit = mod.MiniKit || mod.default?.MiniKit;

      if (MiniKit) {
        MiniKit.install();
        // MiniKit.isInstalled() returns true only inside World App
        if (MiniKit.isInstalled()) {
          this.sdk = MiniKit;
          this.type = 'world';
          this._ready = true;
          console.log(`[platform] Detected World App miniapp context`);
          return true;
        }
      }
    } catch (e) {
      // Not in World App context — continue detection
    }
    return false;
  }

  // Returns platform user identity, or null for standalone/anonymous
  getUser() {
    if (this.type === 'farcaster' && this.context?.user) {
      const u = this.context.user;
      return {
        platformType: 'farcaster',
        platformId: String(u.fid),
        name: u.displayName || u.username || `fid:${u.fid}`,
        avatar: u.pfpUrl || null,
      };
    }
    if (this.type === 'world' && this.sdk) {
      // World App provides user info through MiniKit
      const walletAddress = this.sdk.walletAddress;
      if (walletAddress) {
        return {
          platformType: 'world',
          platformId: walletAddress,
          name: `world:${walletAddress.slice(0, 8)}`,
          avatar: null,
        };
      }
    }
    return null;
  }

  // Returns EIP-1193 wallet provider, or null
  async getWalletProvider() {
    if (this.type === 'farcaster' && this.sdk?.wallet?.getEthereumProvider) {
      try {
        return await this.sdk.wallet.getEthereumProvider();
      } catch (e) {
        console.warn('[platform] Failed to get Farcaster wallet provider:', e);
      }
    }
    // World App and standalone don't expose a standard EIP-1193 provider here
    return null;
  }

  get isEmbedded() {
    return this.type !== 'standalone';
  }
}

export const platform = new Platform();
