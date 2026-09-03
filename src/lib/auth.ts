/**
 * Application-level Cognito OIDC authentication.
 *
 * Authentication is handled inside the Next.js application (authorization code
 * flow against the Cognito hosted UI) instead of at the ALB. This avoids the
 * ALB `authenticate-cognito` action's cross-domain session-cookie/nonce
 * round-trip, which fails when the app is served from a raw ALB DNS name with a
 * self-signed certificate (no shared parent domain, no Route 53).
 *
 * Flow:
 *  1. Middleware sees no valid session cookie -> redirect to /api/auth/login.
 *  2. /api/auth/login generates state + PKCE, stores them in a short-lived
 *     first-party cookie (same origin as the app, SameSite=Lax so it survives
 *     the top-level GET redirect back from Cognito), and redirects the browser
 *     to the Cognito hosted UI /oauth2/authorize.
 *  3. Cognito authenticates the user and redirects back to
 *     https://<app>/api/auth/callback?code=...&state=... (same origin).
 *  4. /api/auth/callback validates state, exchanges the code at /oauth2/token
 *     (using the confidential client secret), verifies the ID token, and sets a
 *     signed session cookie.
 *  5. Middleware allows subsequent requests that present a valid session cookie.
 */

import { SignJWT, jwtVerify, createRemoteJWKSet } from 'jose';

// ─── Cognito configuration (from environment) ────────────────────────────────

export interface CognitoConfig {
  region: string;
  userPoolId: string;
  clientId: string;
  clientSecret: string;
  /** Hosted UI domain host, e.g. "demoappstack-auth-1234.auth.us-east-1.amazoncognito.com" */
  domain: string;
  /** Public base URL of the app on the ALB, e.g. "https://demoapp-...elb.amazonaws.com" */
  appBaseUrl: string;
}

/** Reads Cognito configuration from environment variables. Throws if incomplete. */
export function getCognitoConfig(): CognitoConfig {
  const region = process.env.AWS_REGION || process.env.COGNITO_REGION || '';
  const userPoolId = process.env.COGNITO_USER_POOL_ID || '';
  const clientId = process.env.COGNITO_CLIENT_ID || '';
  const clientSecret = process.env.COGNITO_CLIENT_SECRET || '';
  const domain = (process.env.COGNITO_DOMAIN || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  const appBaseUrl = (process.env.APP_BASE_URL || '').replace(/\/$/, '');

  const missing = Object.entries({
    AWS_REGION: region,
    COGNITO_USER_POOL_ID: userPoolId,
    COGNITO_CLIENT_ID: clientId,
    COGNITO_CLIENT_SECRET: clientSecret,
    COGNITO_DOMAIN: domain,
    APP_BASE_URL: appBaseUrl,
  })
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(`Missing Cognito auth env vars: ${missing.join(', ')}`);
  }

  return { region, userPoolId, clientId, clientSecret, domain, appBaseUrl };
}

export const CALLBACK_PATH = '/api/auth/callback';
export const SESSION_COOKIE = 'app_session';
export const OAUTH_STATE_COOKIE = 'oauth_state';
/** Session lifetime in seconds (8 hours). */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

// ─── Session JWT (signed cookie) ─────────────────────────────────────────────

/**
 * Returns the HMAC key used to sign the session cookie. Derived from the
 * Cognito client secret so no additional secret needs provisioning; the client
 * secret already lives only server-side.
 */
function getSessionKey(): Uint8Array {
  const secret = process.env.COGNITO_CLIENT_SECRET || process.env.SESSION_SECRET || '';
  if (!secret) throw new Error('No secret available to sign session cookie');
  return new TextEncoder().encode(secret);
}

export interface SessionClaims {
  sub: string;
  email?: string;
  username?: string;
}

/** Creates a signed session token for the authenticated user. */
export async function createSessionToken(claims: SessionClaims): Promise<string> {
  return new SignJWT({ email: claims.email, username: claims.username })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSessionKey());
}

/** Verifies a session token. Returns claims if valid, null otherwise. */
export async function verifySessionToken(token: string): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, getSessionKey(), { algorithms: ['HS256'] });
    if (!payload.sub) return null;
    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : undefined,
      username: typeof payload.username === 'string' ? payload.username : undefined,
    };
  } catch {
    return null;
  }
}

// ─── Cognito hosted-UI URLs ──────────────────────────────────────────────────

export function authorizeUrl(
  cfg: CognitoConfig,
  params: { state: string; codeChallenge: string }
): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    response_type: 'code',
    scope: 'openid email profile',
    redirect_uri: `${cfg.appBaseUrl}${CALLBACK_PATH}`,
    state: params.state,
    code_challenge: params.codeChallenge,
    code_challenge_method: 'S256',
  });
  return `https://${cfg.domain}/oauth2/authorize?${q.toString()}`;
}

export function logoutUrl(cfg: CognitoConfig): string {
  const q = new URLSearchParams({
    client_id: cfg.clientId,
    logout_uri: `${cfg.appBaseUrl}/`,
  });
  return `https://${cfg.domain}/logout?${q.toString()}`;
}

// ─── Token exchange + ID token verification ──────────────────────────────────

interface TokenResponse {
  access_token: string;
  id_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in: number;
}

/** Exchanges an authorization code for tokens at the Cognito token endpoint. */
export async function exchangeCodeForTokens(
  cfg: CognitoConfig,
  code: string,
  codeVerifier: string
): Promise<TokenResponse> {
  const tokenUrl = `https://${cfg.domain}/oauth2/token`;
  const basic = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: cfg.clientId,
    code,
    redirect_uri: `${cfg.appBaseUrl}${CALLBACK_PATH}`,
    code_verifier: codeVerifier,
  });

  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${basic}`,
    },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Token exchange failed: ${resp.status} ${text.slice(0, 200)}`);
  }
  return (await resp.json()) as TokenResponse;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

/** Verifies a Cognito ID token and returns its claims. */
export async function verifyIdToken(
  cfg: CognitoConfig,
  idToken: string
): Promise<SessionClaims> {
  const issuer = `https://cognito-idp.${cfg.region}.amazonaws.com/${cfg.userPoolId}`;
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  }
  const { payload } = await jwtVerify(idToken, jwks, {
    issuer,
    audience: cfg.clientId,
  });
  return {
    sub: String(payload.sub),
    email: typeof payload.email === 'string' ? payload.email : undefined,
    username:
      typeof payload['cognito:username'] === 'string'
        ? (payload['cognito:username'] as string)
        : undefined,
  };
}

// ─── PKCE + state helpers (Web Crypto, edge-compatible) ──────────────────────

function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function randomString(byteLen = 32): string {
  const arr = new Uint8Array(byteLen);
  crypto.getRandomValues(arr);
  return base64url(arr);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}
