# Google zkLogin on Sui testnet

The Google button starts real OAuth and obtains a real zkLogin proof. It stays disabled when required server configuration is missing. There is no address-only login, pasted-token bypass, generated salt fallback, or simulated proof.

## Configure and run

1. Copy `.env.example` to `.env.local` and set all five required variables. Keep `.env.local` out of source control. Restart Next.js after environment changes.
2. Create a **Web application** OAuth client in Google Cloud, configure the consent screen and permitted test users, and register the exact authorized redirect URI `${ZKLOGIN_ORIGIN}/auth/callback`. Register the corresponding JavaScript origin if required by your Google project.
3. Set `ZKLOGIN_ORIGIN` to the app's exact canonical origin, without a path or trailing slash. HTTPS is required except `http://localhost:<port>`, `http://127.0.0.1:<port>` or IPv6 loopback during development. Use that same URL in the browser.
4. Set `ZKLOGIN_GOOGLE_CLIENT_ID` to the Google Web OAuth client ID ending in `.apps.googleusercontent.com`. A Google client secret is not used: this flow returns an ID token in the URL fragment.
5. Generate `ZKLOGIN_SESSION_SECRET` with `openssl rand -hex 32`. All server instances must use the same secret. Rotating it invalidates outstanding OAuth flows.
6. Configure the salt and prover endpoints described below. Provider API credentials must remain in server environment variables, never in `NEXT_PUBLIC_*`, source code or browser storage.
7. Run `pnpm dev`, open the configured origin, choose **Google**, complete Google login in the same tab, and wait for proof verification. The callback returns to `/` only after Sui testnet verifies a proof-backed signature.
8. Fund the displayed zkLogin address with testnet SUI before sending transactions. This integration does not sponsor gas. Submit a transaction and inspect its digest on a Sui testnet explorer.

`GET /api/zklogin/config` returns a public client ID and redirect URI when ready, or a helpful setup error. It never exposes provider URLs, credentials or the session secret.

## Stable salt provider

Set `ZKLOGIN_SALT_URL` to an HTTPS POST endpoint. The server sends:

```json
{ "jwt": "<verified Google ID token>" }
```

If `ZKLOGIN_SALT_API_KEY` is set, it adds `Authorization: Bearer <credential>`.

The endpoint must return:

```json
{ "salt": "<decimal unsigned 128-bit integer>" }
```

The provider must authenticate the JWT and consistently return the same salt for the verified `(iss, aud, sub)` identity, with a documented backup and recovery process. Issuer normalization must treat Google's supported issuer spellings consistently. Random values on each login, a common salt shared by all users, and browser-local salt assignment are unsuitable. Losing or changing this value changes the Sui address and can permanently prevent access to assets. The adapter intentionally accepts this small JSON contract rather than guessing a vendor-specific API; put a server adapter in front of a vendor with a different contract.

JWTs and salts must be redacted from provider/access/error logs. Use an appropriately trusted provider. The app never forwards the ephemeral private key to any service.

## Prover

Set `ZKLOGIN_PROVER_URL` to an HTTPS endpoint compatible with the Mysten zkLogin prover. If `ZKLOGIN_PROVER_API_KEY` is set, the server sends it as a Bearer credential. The POST body is:

```json
{
  "jwt": "<verified Google ID token>",
  "extendedEphemeralPublicKey": "<base64 flag + Ed25519 public key>",
  "maxEpoch": "<current testnet epoch + 2, decimal string>",
  "jwtRandomness": "<decimal 128-bit nonce randomness>",
  "salt": "<stable decimal 128-bit user salt>",
  "keyClaimName": "sub"
}
```

The response is:

```json
{
  "proofPoints": {
    "a": ["<field>", "<field>", "1"],
    "b": [["<field>", "<field>"], ["<field>", "<field>"], ["1", "0"]],
    "c": ["<field>", "<field>", "1"]
  },
  "issBase64Details": { "value": "<packed issuer claim>", "indexMod4": 0 },
  "headerBase64": "<JWT protected header segment>"
}
```

`indexMod4` is the actual packed claim offset (0–2), not necessarily zero. The server validates response structure and JWT header/issuer/address consistency, computes `addressSeed`, and returns the proof to the same browser tab. The browser then signs a random personal-message challenge with the ephemeral key and asks Sui testnet to verify the full zkLogin signature. Invalid proofs and mismatched proving keys fail login. Each provider request has a 45-second timeout; provider errors are reported without echoing response bodies or secrets. Salt/prover URLs cannot redirect requests to another destination.

The callback route permits up to 120 seconds of server execution; configure the deployment's actual function duration accordingly. The complete client request times out after 115 seconds. Public Sui testnet gRPC is used for epoch reads, proof verification, transaction building and execution.

## Session and signing behavior

The browser generates an Ed25519 ephemeral key and secure nonce randomness. The server reads the actual testnet epoch, binds the public key and randomness to `maxEpoch = epoch + 2`, and generates a cryptographically random 256-bit OAuth state. A signed, HttpOnly, SameSite cookie binds the flow to the server; the pending private key and state live in `sessionStorage` in the initiating tab. OAuth must complete within ten minutes.

The callback immediately removes the token fragment from browser history. State, issuer, audience, authorized party, nonce, issuance time, expiry and the RSA signature against Google's HTTPS JWKS are checked. A successful callback stores the ephemeral private key and proof only in `sessionStorage`; JWTs are never persisted. Public account metadata stays in the existing `sui_active_account` record. The existing `sui-account-switched` and `storage` events remain available to application consumers.

A refresh in the same tab retains the signer. A new tab or closed browser session requires Google login again. The address remains the same when the Google identity and stable provider salt remain the same. The key remains usable through `maxEpoch`, then signing explicitly requires a new Google login. JWT expiration after proof creation does not end the Sui epoch-bound signing session.

Signing routes by the selected account type, with zkLogin checked first. Transactions must use the selected sender. Keystore failure never falls through to an extension wallet. Extension signing matches the selected provider, account address and `sui:testnet` chain; the signed bytes are checked when the wallet supports separate signing. Execution effects and on-chain sender are verified before reporting success.

Logout through the dialog removes the tab's zkLogin secrets and broadcasts account changes. Selecting another account through the dialog clears the zkLogin session. Protect the app from XSS: any script on the same origin can access `sessionStorage`. Do not log ID tokens, salts, ephemeral keys or complete provider responses.

## Deployment limits

The HMAC flow cookie works across instances sharing `ZKLOGIN_SESSION_SECRET`. Rate limits (100 requests/minute globally, 15/minute per reported IP) and the consumed-state replay cache are **per Node process** and reset on restart. Cookies are cleared after a complete attempt, and the browser consumes the pending state. For a public deployment with multiple processes or regions, add a shared gateway rate limit and shared atomic one-use state storage before relying on these protections across instances. Proxy IP headers must be sanitized by the gateway. No production-wide replay guarantee is claimed for the current in-memory cache.

Request JSON is bounded to 1 KiB for start and 18 KiB for complete; external JSON responses are bounded to 32 KiB. POSTs require the exact configured Origin and same-origin Fetch Metadata when present. Browser metadata alone does not authenticate callers, so upstream rate limiting remains necessary. The salt and prover endpoints are server-private and must be HTTPS.

## Verification

Run:

```sh
pnpm exec tsx --test lib/zklogin.test.ts
pnpm exec tsc --noEmit
pnpm build
```

Tests cover HMAC tampering, OAuth timeout and replay, invalid JWT claims, RSA signature verification, forged tokens, ephemeral signature assembly, epoch expiration, account mismatches, wallet selection, sender binding and execution failures. The proof fixture only tests SDK serialization; it is not accepted as a real chain proof or substituted into the application.

Completing the external acceptance test requires configured Google OAuth, stable salt and testnet prover services, a browser login, and testnet SUI. Without those services the disabled Google state is intentional; unit tests and a successful build do not establish an end-to-end login or funded transaction.

References: [Sui integration guide](https://docs.sui.io/sui-stack/zklogin-integration/integration-guide), [Mysten zkLogin SDK](https://sdk.mystenlabs.com/sui/zklogin), [transaction signing](https://sdk.mystenlabs.com/sui/transactions/signing-and-execution).
