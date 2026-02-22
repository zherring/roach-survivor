# Roach Survivor Security Review (2026-02-21)

## Scope
- Node.js HTTP + WebSocket server (`server/`)
- Browser client payment/auth flows (`client/`)
- PostgreSQL persistence and payment bookkeeping (`server/db.js`)
- On-chain payment verification flow (`server/payment-verifier.js`)
- ERC20 contract (`smart-contracts/src/RoachToken.sol`)

## Executive summary
- **High-risk issues fixed in this pass:**
  1. Removed an unauthenticated debug-log ingestion endpoint that could be abused for disk-fill/log-injection and accidental sensitive data persistence.
  2. Removed client-side telemetry calls that sent wallet/payment metadata to that endpoint.
  3. Hardened WebSocket message size handling to reduce DoS risk from oversized payloads.
  4. Hardened SIWE origin derivation to avoid trusting spoofable `x-forwarded-*` headers unless explicitly enabled.
  5. Added baseline security response headers (`nosniff`, `no-referrer`, CORP) on API/static responses.

- **Remaining non-blocking risks before public launch (recommended):**
  - Add explicit per-IP rate limiting on payment + SIWE endpoints.
  - Add WebSocket handshake origin allowlist (today any origin can connect).
  - Add stricter secure cookie defaults behind TLS termination + trusted proxy in production.
  - Add automated dependency vulnerability scanning in CI (audit endpoint unavailable in this environment).

## Findings

### 1) Unauthenticated debug log ingestion endpoint (Fixed)
- **Severity:** High
- **Impact:** Public attackers could POST unbounded arbitrary strings to server-side file append path, creating storage pressure and poisoning operational logs.
- **Fix:** Removed `/api/debug-log` endpoint and all client calls to it.

### 2) Wallet/payment metadata over debug telemetry (Fixed)
- **Severity:** Medium
- **Impact:** Client emitted wallet and transaction metadata to server debug endpoint, increasing privacy and data retention risk.
- **Fix:** Removed all debug telemetry emission from wallet flow.

### 3) WebSocket oversized payload DoS window (Fixed)
- **Severity:** Medium
- **Impact:** Oversized messages could consume memory/CPU before parse failures.
- **Fix:** Added `maxPayload` at WebSocket server level and explicit runtime checks before parsing.

### 4) SIWE origin trust model depended on spoofable headers (Fixed)
- **Severity:** Medium
- **Impact:** If app is deployed without strict proxy sanitation, attacker-controlled `x-forwarded-host/proto` could alter SIWE origin/domain expectations.
- **Fix:** Ignore forwarded headers by default; only trust when `TRUST_PROXY=true`; sanitize host header format.

### 5) Missing baseline hardening response headers (Fixed)
- **Severity:** Low
- **Impact:** Increased browser content sniffing/referrer leakage risk.
- **Fix:** Added `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and API CORP header.

## Additional observations (not changed)
- Payment verification logic correctly validates tx receipt success, token contract, sender/recipient, and minimum amount in USDC units.
- DB writes are parameterized; payment linking uses transaction + uniqueness checks.
- SIWE challenge nonce is random and challenge is one-time consumed.
- Smart contract is a simple fixed-supply ERC20 with no admin mint/burn paths.

## Recommended next steps before Sunday
1. Add IP/user-agent aware rate limits for `/api/siwe/*`, `/api/verify-payment`, and `/api/wallet-paid-status`.
2. Add WS upgrade-time origin validation and connection throttling.
3. Set `TRUST_PROXY=true` only when behind trusted reverse proxy that strips inbound forwarded headers.
4. Add structured security logging with redaction policy (no wallet signatures/raw secrets).
5. Add CI job: `npm audit`, `npm outdated`, and optional SAST.
