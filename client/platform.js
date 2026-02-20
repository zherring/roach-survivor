// Platform detection and SDK adapter for Farcaster, Base App, and standalone browser.
// World App support is a stretch goal — detection is attempted but not prioritized.
// Loads SDKs dynamically via CDN — no build step required.
//
// Priority: Farcaster/Base App (primary) > World App (stretch) > standalone (fallback)

const FARCASTER_SDK_URL = 'https://esm.sh/@farcaster/miniapp-sdk@0.2.3';
const WORLD_SDK_URL = 'https://cdn.jsdelivr.net/npm/@worldcoin/minikit-js@latest/+esm';

class Platform {
  constructor() {
    this.type = 'standalone'; // 'farcaster' | 'base' | 'world' | 'standalone'
    this.sdk = null;
    this.context = null;
    this._ready = false;
    this._initPromise = null;
  }

  async init() {
    if (this._ready) return;
    if (this._initPromise) return this._initPromise;

    // Detect platform by checking environment signals
    this._initPromise = (async () => {
      if (await this._tryFarcaster()) return;
      if (await this._tryWorld()) return;
      // Standalone fallback — no SDK needed
      this.type = 'standalone';
      this._ready = true;
    })();

    try {
      await this._initPromise;
    } finally {
      this._initPromise = null;
    }
  }

  async _tryFarcaster() {
    try {
      const mod = await import(FARCASTER_SDK_URL);
      const sdk = mod.default || mod.sdk || mod;

      if (!sdk) return false;

      if (typeof sdk.isInMiniApp === 'function') {
        const inMiniApp = await sdk.isInMiniApp(300);
        if (!inMiniApp) return false;
      }

      const context = await Promise.resolve(sdk.context).catch(() => null);

      if (!context || !context.user) {
        return false;
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
    if (!this._ready) {
      try {
        await this.init();
      } catch {
        // Fall through to null for non-miniapp contexts.
      }
    }

    if (this.type === 'farcaster' && this.sdk?.wallet) {
      if (typeof this.sdk.wallet.getEthereumProvider === 'function') {
        try {
          const provider = await this.sdk.wallet.getEthereumProvider();
          // #region agent log
          fetch('/api/debug-log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'5be6bb',location:'platform.js:getWalletProvider',message:'Farcaster getEthereumProvider result',data:{hasProvider:!!provider,providerType:typeof provider},timestamp:Date.now(),hypothesisId:'H3',runId:'post-fix'})}).catch(()=>{});
          // #endregion
          if (provider) return provider;
        } catch (e) {
          console.warn('[platform] Failed to get Farcaster wallet provider:', e);
        }
      }

      if (this.sdk.wallet.ethProvider) {
        // #region agent log
        fetch('/api/debug-log',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sessionId:'5be6bb',location:'platform.js:getWalletProvider:fallback',message:'Using fallback ethProvider',data:{hasEthProvider:true},timestamp:Date.now(),hypothesisId:'H3',runId:'post-fix'})}).catch(()=>{});
        // #endregion
        return this.sdk.wallet.ethProvider;
      }
    }

    return null;
  }

  get isEmbedded() {
    return this.type !== 'standalone';
  }
}

export const platform = new Platform();
