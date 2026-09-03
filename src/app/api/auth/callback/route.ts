import { NextRequest, NextResponse } from 'next/server';
import {
  getCognitoConfig,
  exchangeCodeForTokens,
  verifyIdToken,
  createSessionToken,
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
} from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Cognito redirects here after login with ?code & ?state.
 * Validates state, exchanges the code for tokens, verifies the ID token, and
 * establishes a signed application session cookie.
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

  const params = request.nextUrl.searchParams;
  const error = params.get('error');
  if (error) {
    return NextResponse.json(
      { error: 'Cognito returned an error', detail: `${error}: ${params.get('error_description') || ''}` },
      { status: 400 }
    );
  }

  const code = params.get('code');
  const state = params.get('state');
  if (!code || !state) {
    return NextResponse.json({ error: 'Missing code or state' }, { status: 400 });
  }

  // Recover state + PKCE verifier from the first-party cookie.
  const stateCookie = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
  if (!stateCookie) {
    return NextResponse.json(
      { error: 'Login session expired. Please try again.' },
      { status: 400 }
    );
  }

  let stored: { state: string; codeVerifier: string; returnTo: string };
  try {
    stored = JSON.parse(stateCookie);
  } catch {
    return NextResponse.json({ error: 'Invalid login state' }, { status: 400 });
  }

  if (stored.state !== state) {
    return NextResponse.json({ error: 'State mismatch' }, { status: 400 });
  }

  try {
    const tokens = await exchangeCodeForTokens(cfg, code, stored.codeVerifier);
    const claims = await verifyIdToken(cfg, tokens.id_token);
    const sessionToken = await createSessionToken(claims);

    const returnTo =
      stored.returnTo && stored.returnTo.startsWith('/') && !stored.returnTo.startsWith('//')
        ? stored.returnTo
        : '/';

    const response = NextResponse.redirect(`${cfg.appBaseUrl}${returnTo}`);
    response.cookies.set(SESSION_COOKIE, sessionToken, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL_SECONDS,
    });
    // Clear the transient state cookie.
    response.cookies.set(OAUTH_STATE_COOKIE, '', { path: '/', maxAge: 0 });
    return response;
  } catch (e) {
    return NextResponse.json(
      { error: 'Login failed', detail: e instanceof Error ? e.message : String(e) },
      { status: 502 }
    );
  }
}
