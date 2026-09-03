import { NextResponse } from 'next/server';
import { getCognitoConfig, logoutUrl, SESSION_COOKIE } from '@/lib/auth';

export const dynamic = 'force-dynamic';

/**
 * Logs the user out: clears the app session cookie and redirects to the Cognito
 * hosted-UI logout endpoint, which then returns to the app root.
 */
export async function GET() {
  let target = '/';
  try {
    target = logoutUrl(getCognitoConfig());
  } catch {
    // Fall back to clearing the cookie and returning home if config is missing.
  }

  const response = NextResponse.redirect(target);
  response.cookies.set(SESSION_COOKIE, '', { path: '/', maxAge: 0 });
  return response;
}
