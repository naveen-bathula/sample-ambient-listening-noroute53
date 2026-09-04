/**
 * POST /api/sessions — Create a new ambient documentation session.
 *
 * Creates the session via Connect Health SDK, registers it in the stream registry,
 * and starts the background streaming process that feeds audio to Connect Health
 * and publishes transcript events.
 *
 * HIPAA NOTICE: This endpoint receives patient context (PHI) to configure the
 * ambient documentation session. All data is encrypted in transit (TLS) and
 * handled in accordance with HIPAA requirements. Ensure BAA agreements are in
 * place with AWS for production deployments with real PHI.
 *
 * Returns { sessionId, domainId, subscriptionId, status } on success.
 */

import { NextResponse } from 'next/server';
import { validateRegion, validateConfig } from '@/lib/config';
import {
  ConnectHealthClient,
  ListDomainsCommand,
  CreateSubscriptionCommand,
} from '@aws-sdk/client-connecthealth';

export async function POST(request: Request) {
  try {
    const configResult = validateConfig();
    if (!configResult.valid) {
      return NextResponse.json(
        { code: 'CONFIG_ERROR', message: configResult.errors.join('; '), retryable: false },
        { status: 500 }
      );
    }

    const { config } = configResult;

    if (!validateRegion(config.aws.region)) {
      return NextResponse.json(
        { code: 'UNSUPPORTED_REGION', message: `Region "${config.aws.region}" is not supported.`, retryable: false },
        { status: 400 }
      );
    }

    const body = await request.json() as { patientId?: string; patientContext?: string };
    const { patientId, patientContext } = body;

    if (!patientId || !patientContext) {
      return NextResponse.json(
        { code: 'INVALID_REQUEST', message: 'Request body must include "patientId" and "patientContext"', retryable: false },
        { status: 400 }
      );
    }

    const region = config.aws.region;
    const client = new ConnectHealthClient({ region });

    // Step 1: Look up the pre-existing Connect Health domain.
    // The domain must be created out-of-band (e.g. via the AWS console during the
    // workshop) and its name supplied through the CONNECT_HEALTH_DOMAIN_NAME
    // environment variable on the ECS task. The application intentionally does NOT
    // create the domain: if it is missing, we fail with a clear, actionable error
    // so the operator knows to create it and update the environment variable.
    const domainName = config.connectHealth.domainName;
    let domainId: string;

    const listResponse = await client.send(new ListDomainsCommand({}));
    const existingDomain = listResponse.domains?.find(d => d.name === domainName);

    if (!existingDomain) {
      console.error(`[Sessions] Connect Health domain "${domainName}" not found; not creating it.`);
      return NextResponse.json(
        {
          code: 'DOMAIN_NOT_FOUND',
          message:
            `Amazon Connect Health domain "${domainName}" was not found in this account/region. ` +
            `Create the domain manually (AWS console) and set the CONNECT_HEALTH_DOMAIN_NAME ` +
            `environment variable on the Demo App ECS task to its name.`,
          retryable: false,
        },
        { status: 400 }
      );
    }

    domainId = existingDomain.domainId || '';
    console.log(`[Sessions] Using existing domain: ${domainId}`);

    // Step 2: Create subscription
    const subResponse = await client.send(new CreateSubscriptionCommand({ domainId }));
    const subscriptionId = subResponse.subscriptionId || '';
    console.log(`[Sessions] Created subscription: ${subscriptionId}`);

    // Step 3: Generate session ID and register in stream registry
    const sessionId = crypto.randomUUID();

    // Sanitize patient context for Connect Health API.
    // This allowlist preserves standard medical notation (units, abbreviations, punctuation)
    // while removing control characters and invalid Unicode that could break the API.
    const sanitizedContext = patientContext.replace(/[^\x20-\x7E\n\r\t]/g, ' ').replace(/\s{2,}/g, ' ');

    // Step 4: Session registration happens in audio-stream route on first chunk
    // This avoids the Next.js module isolation issue where in-memory state
    // isn't shared between different route handler modules.

    return NextResponse.json(
      {
        sessionId,
        domainId,
        subscriptionId,
        status: 'active',
        patientContext: sanitizedContext,
      },
      { status: 201 }
    );
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'Unknown';
    console.error('[Sessions] Session creation failed:', errorName);
    return NextResponse.json(
      { code: 'SESSION_CREATION_FAILED', message: 'Session creation failed', retryable: false },
      { status: 500 }
    );
  }
}

