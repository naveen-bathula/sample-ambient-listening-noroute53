import { NextRequest, NextResponse } from 'next/server';
import { verifySessionToken, SESSION_COOKIE } from '@/lib/auth';

/**
 * Route protection for the application. Requests without a valid session cookie
 * are redirected to the Cognito login flow (browser navigations) or rejected
 * with 401 (API/XHR requests).
 *
 * Public paths (no auth): the auth routes themselves, the health check, Next.js
 * internals and static assets (handled by the matcher below).
 */

const PUBLIC_PREFIXES = ['/api/auth/', '/api/health'];

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Allow public paths through untouched.
  if (PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(p))) {
    return NextResponse.next();
  }

  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const session = token ? await verifySessionToken(token) : null;

  if (session) {
    return NextResponse.next();
  }

  // No valid session.
  const isApi = pathname.startsWith('/api/');
  if (isApi) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  // Browser navigation -> start login, remembering where the user was headed.
  const loginUrl = request.nextUrl.clone();
  loginUrl.pathname = '/api/auth/login';
  loginUrl.search = '';
  loginUrl.searchParams.set('returnTo', pathname + request.nextUrl.search);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // Match everything except Next.js internals and common static assets.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|css|js|woff2?)$).*)'],
};
