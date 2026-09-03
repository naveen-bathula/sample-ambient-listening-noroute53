import { NextRequest, NextResponse } from 'next/server';
import {
  getCognitoConfig,
  authorizeUrl,
  randomString,
  pkceChallenge,
  OAUTH_STATE_COOKIE,
} from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Starts the Cognito authorization-code login flow.
 * Generates state + PKCE verifier, stores them in a short-lived first-party
 * cookie, and redirects the browser to the Cognito hosted UI.
 */
export async function GET(request: NextRequest) {
  let cfg;
  try {
    cfg = getCognitoConfig();
  } catch (e) {
    return NextResponse.json(
      { error: 'Auth not configured', detail: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }

  // Where to send the user after successful login (relative path only, to avoid open redirects).
  const rawReturn = request.nextUrl.searchParams.get('returnTo') || '/';
  const returnTo = rawReturn.startsWith('/') && !rawReturn.startsWith('//') ? rawReturn : '/';

  const state = randomString(16);
  const codeVerifier = randomString(32);
  const codeChallenge = await pkceChallenge(codeVerifier);

  const url = authorizeUrl(cfg, { state, codeChallenge });
  const response = NextResponse.redirect(url);

  // Store state + verifier + returnTo in a short-lived, first-party cookie.
  // SameSite=Lax lets it accompany the top-level GET redirect back from Cognito.
  const payload = JSON.stringify({ state, codeVerifier, returnTo });
  response.cookies.set(OAUTH_STATE_COOKIE, payload, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 600, // 10 minutes
  });

  return response;
}
