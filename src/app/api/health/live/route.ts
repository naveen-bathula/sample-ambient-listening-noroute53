import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Liveness probe for the ALB target group health check.
 *
 * Always returns 200 when the Next.js server is up and serving requests. Unlike
 * /api/health (which is a deep check that also verifies FHIR/OpenEMR backend
 * connectivity), this endpoint only reflects that the container itself is alive,
 * so transient backend issues do not cause the ALB to kill healthy tasks.
 */
export async function GET() {
  return NextResponse.json({ status: 'ok' }, { status: 200 });
}
