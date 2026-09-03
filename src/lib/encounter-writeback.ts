/**
 * Encounter writeback module for creating new encounters with clinical notes in OpenEMR.
 *
 * Uses a hybrid approach:
 * 1. OpenEMR Standard API to create the encounter (handles UUID generation, etc.)
 * 2. Direct DB insert for the clinical note (the soap_note API endpoint is buggy
 *    and doesn't properly wire up the forms table linkage)
 *
 * The DB insert replicates exactly what the OpenEMR UI does when a user creates
 * a Clinical Notes Form entry through the web interface.
 *
 * HIPAA NOTICE: This module handles Protected Health Information (PHI) including
 * patient identifiers, clinical notes, and encounter data. Deployments must implement
 * appropriate HIPAA safeguards including encryption at rest and in transit, access
 * controls, audit logging, and BAA agreements with AWS. See the AWS HIPAA compliance
 * documentation and shared responsibility model for additional requirements.
 */

import https from 'https';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import mysql from 'mysql2/promise';

const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const FHIR_BASE_URL = process.env.OPENEMR_FHIR_BASE_URL || '';

// The OpenEMR ALB uses a self-signed certificate (no Route53/ACM DNS-validated cert).
// When OPENEMR_ALLOW_SELF_SIGNED_TLS is set, relax cert chain verification for these
// internal service-to-service calls while still enforcing TLS 1.2+.
const ALLOW_SELF_SIGNED_TLS =
  (process.env.OPENEMR_ALLOW_SELF_SIGNED_TLS || '').toLowerCase() === 'true';
const tlsAgent = new https.Agent({
  minVersion: 'TLSv1.2',
  keepAlive: true,
  rejectUnauthorized: !ALLOW_SELF_SIGNED_TLS,
});
const FHIR_CREDENTIALS_SECRET = process.env.FHIR_CREDENTIALS_SECRET_NAME || 'DemoAppStack/fhir-api-credentials';
const DB_SECRET_ARN = process.env.DB_SECRET_ARN || '';

export interface WritebackResult {
  encounterId: number;
  createdAt: Date;
}

export interface SOAPSection {
  heading: string;
  content: string;
}

interface OAuthCredentials {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
}

interface DbCredentials {
  host: string;
  port: number;
  username: string;
  password: string;
}

let cachedToken: string | null = null;
let tokenExpiresAt = 0;
let cachedOAuthCreds: OAuthCredentials | null = null;
let cachedDbCreds: DbCredentials | null = null;

/**
 * Formats SOAP sections into a single string with clear headings.
 */
export function formatSOAPContent(sections: SOAPSection[]): string {
  return sections
    .map((section) => `${section.heading}:\n${section.content}`)
    .join('\n\n');
}

async function getOAuthCredentials(): Promise<OAuthCredentials> {
  if (cachedOAuthCreds) return cachedOAuthCreds;
  const client = new SecretsManagerClient({ region: AWS_REGION });
  const response = await client.send(new GetSecretValueCommand({ SecretId: FHIR_CREDENTIALS_SECRET }));
  if (!response.SecretString) throw new Error('FHIR credentials secret has no value');
  const secret = JSON.parse(response.SecretString);
  cachedOAuthCreds = {
    clientId: secret.clientId,
    clientSecret: secret.clientSecret,
    username: secret.username || 'admin',
    password: secret.password,
  };
  return cachedOAuthCreds;
}

async function getDbCredentials(): Promise<DbCredentials> {
  if (cachedDbCreds) return cachedDbCreds;

  if (!DB_SECRET_ARN) throw new Error('DB_SECRET_ARN environment variable is not set');

  const client = new SecretsManagerClient({ region: AWS_REGION });
  const response = await client.send(new GetSecretValueCommand({ SecretId: DB_SECRET_ARN }));
  if (!response.SecretString) throw new Error('DB secret has no value');
  const secret = JSON.parse(response.SecretString);
  cachedDbCreds = {
    host: secret.host,
    port: secret.port || 3306,
    username: secret.username,
    password: secret.password,
  };
  return cachedDbCreds;
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt - 30000) {
    return cachedToken;
  }
  const creds = await getOAuthCredentials();
  const baseHost = FHIR_BASE_URL.replace(/\/apis\/.*$/, '');
  const tokenUrl = baseHost + '/oauth2/default/token';

  const body = new URLSearchParams({
    grant_type: 'password',
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    username: creds.username,
    password: creds.password,
    user_role: 'users',
    scope: 'openid api:oemr user/encounter.write user/encounter.read',
  });

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    // @ts-expect-error Node.js fetch supports the agent option for https (self-signed ALB cert)
    agent: tlsAgent,
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OAuth2 token request failed: ${response.status} ${errText.substring(0, 200)}`);
  }

  const tokenData = await response.json();
  cachedToken = tokenData.access_token;
  tokenExpiresAt = Date.now() + (tokenData.expires_in || 3600) * 1000;
  return cachedToken!;
}

/**
 * Creates a new encounter with a clinical note in OpenEMR.
 *
 * Step 1: Create encounter via Standard API (handles UUID, encounter number, etc.)
 * Step 2: Insert clinical note via direct DB (replicates exact UI behavior)
 *
 * @param patientUuid - The patient's FHIR UUID
 * @param sections - Array of SOAP sections with heading and content
 * @returns WritebackResult with encounterId and createdAt on success
 */
export async function createEncounterWithNote(
  patientUuid: string,
  sections: SOAPSection[]
): Promise<WritebackResult> {
  const token = await getAccessToken();
  const now = new Date();
  const dateStr = now.toISOString().substring(0, 10);

  // Standard API base
  const apiBase = FHIR_BASE_URL.replace(/\/fhir\/?$/, '/api');

  // Step 1: Create encounter via API
  console.log(`[Writeback] Creating encounter`);
  const encResp = await fetch(`${apiBase}/patient/${patientUuid}/encounter`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    // @ts-expect-error Node.js fetch supports the agent option for https (self-signed ALB cert)
    agent: tlsAgent,
    body: JSON.stringify({
      date: dateStr,
      reason: 'Ambient Clinical Documentation',
      onset_date: dateStr,
      pc_catid: '5',
      class_code: 'AMB',
      facility_id: '3',
      billing_facility: '3',
      sensitivity: 'normal',
      pos_code: '0',
    }),
  });

  if (!encResp.ok) {
    const errText = await encResp.text();
    throw new Error(`Failed to create encounter: ${encResp.status} ${errText.substring(0, 300)}`);
  }

  const encData = await encResp.json();
  const encounterId = encData?.data?.eid || encData?.eid;
  const encounterNum = encData?.data?.eid || encData?.eid;

  if (!encounterId) {
    throw new Error('Encounter created but no ID returned');
  }
  console.log(`[Writeback] Encounter created`);

  // Step 2: Insert clinical note via direct DB (matching UI pattern exactly)
  const noteContent = formatSOAPContent(sections);
  const dbCreds = await getDbCredentials();

  const conn = await mysql.createConnection({
    host: dbCreds.host,
    port: dbCreds.port,
    user: dbCreds.username,
    password: dbCreds.password,
    database: 'openemr',
    connectTimeout: 10000,
    ssl: { rejectUnauthorized: true },
  });

  try {
    // Resolve patient UUID to PID
    const uuidHex = patientUuid.replace(/-/g, '');
    const [pidRows] = await conn.execute<mysql.RowDataPacket[]>(
      'SELECT pid FROM patient_data WHERE uuid = UNHEX(?)',
      [uuidHex]
    );
    if (!pidRows || pidRows.length === 0) {
      throw new Error(`Patient not found for UUID: ${patientUuid}`);
    }
    const pid = pidRows[0]!.pid;

    // Get next form_id for form_clinical_notes
    const [maxFormId] = await conn.execute<mysql.RowDataPacket[]>(
      'SELECT COALESCE(MAX(form_id), 0) + 1 AS next_id FROM form_clinical_notes'
    );
    const nextFormId = maxFormId[0]!.next_id;

    // Insert into form_clinical_notes (matching exact UI pattern)
    await conn.execute<mysql.ResultSetHeader>(
      `INSERT INTO form_clinical_notes 
       (form_id, date, pid, encounter, user, groupname, authorized, activity, code, codetext, description, clinical_notes_type, note_related_to)
       VALUES (?, CURDATE(), ?, ?, 'admin', 'Default', 1, 1, 'LOINC:34109-9', 'General Note', ?, 'progress_note', '[]')`,
      [nextFormId, pid, encounterNum, noteContent]
    );
    console.log(`[Writeback] Clinical note inserted`);

    // Insert into forms table (links the note to the encounter)
    await conn.execute(
      `INSERT INTO forms 
       (date, encounter, form_name, form_id, pid, user, groupname, authorized, deleted, formdir)
       VALUES (NOW(), ?, 'Clinical Notes Form', ?, ?, 'admin', 'Default', 1, 0, 'clinical_notes')`,
      [encounterNum, nextFormId, pid]
    );
    console.log(`[Writeback] Forms entry created`);

  } finally {
    await conn.end().catch(() => {});
  }

  console.log(`[Writeback] Success: encounter written to EHR`);

  return {
    encounterId,
    createdAt: now,
  };
}
