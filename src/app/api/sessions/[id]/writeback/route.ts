/**
 * POST /api/sessions/[id]/writeback — Write clinical note back to OpenEMR.
 *
 * Accepts { patientId, clinicalNote, sessionDate } in the request body.
 * Uses DocumentReferenceBuilder to create a FHIR DocumentReference resource
 * and POSTs it to the OpenEMR FHIR API.
 *
 * Returns { success: true, documentId } on success.
 * Returns 400 if required fields are missing.
 * Returns 502 if the FHIR API write fails.
 * Supports up to 3 retry attempts (client can retry).
 *
 * @see Requirements 14.1, 14.2, 14.3, 14.4
 */

import { NextResponse } from 'next/server';
import { validateConfig } from '@/lib/config';
import { buildDocumentReference } from '@/lib/document-reference-builder';
import { createFHIRClient } from '@/lib/fhir-client';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    await params; // Consume the params (sessionId available if needed for logging)

    // Parse request body
    const body = await request.json() as {
      patientId?: string;
      clinicalNote?: string;
      sessionDate?: string;
    };
    const { patientId, clinicalNote, sessionDate } = body;

    if (!patientId || !clinicalNote || !sessionDate) {
      return NextResponse.json(
        {
          code: 'INVALID_REQUEST',
          message: 'Request body must include "patientId", "clinicalNote", and "sessionDate"',
          retryable: false,
        },
        { status: 400 }
      );
    }

    // Validate configuration
    const configResult = validateConfig();
    if (!configResult.valid) {
      return NextResponse.json(
        { code: 'CONFIG_ERROR', message: configResult.errors.join('; '), retryable: false },
        { status: 500 }
      );
    }

    const { config } = configResult;

    // Build the FHIR DocumentReference resource
    const documentReference = buildDocumentReference({
      clinicalNoteContent: clinicalNote,
      patientId,
      sessionDate,
    });

    // Create FHIR client and POST the DocumentReference (authenticated, via TLS agent
    // that trusts the self-signed OpenEMR ALB certificate).
    const fhirClient = createFHIRClient({
      fhirBaseUrl: config.openemr.fhirBaseUrl,
      region: config.aws.region,
    });

    const writeResult = await fhirClient.postResource<{ id?: string }>(
      '/DocumentReference',
      documentReference
    );

    if (!writeResult.success) {
      return NextResponse.json(
        {
          code: 'FHIR_WRITE_FAILED',
          message: writeResult.error ?? 'FHIR write failed',
          retryable: true,
          maxRetries: 3,
        },
        { status: 502 }
      );
    }

    const documentId = writeResult.data?.id ?? 'unknown';

    return NextResponse.json({
      success: true,
      documentId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json(
      {
        code: 'WRITEBACK_FAILED',
        message,
        retryable: true,
        maxRetries: 3,
      },
      { status: 500 }
    );
  }
}
