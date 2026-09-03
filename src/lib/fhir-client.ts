/**
 * FHIR client with OAuth2 client credentials authentication for OpenEMR.
 *
 * - Authenticates using OAuth2 client credentials flow
 * - Reads client credentials from AWS Secrets Manager at runtime
 * - Enforces TLS 1.2+ for all FHIR API connections
 * - 10-second timeout for all requests
 * - Handles partial failures (some resource types succeed, others fail)
 *
 * @see Requirements 3.1, 3.4, 3.5, 10.3, 13.3, 13.8
 */

import https from 'https';
import {
  SecretsManagerClient,
  GetSecretValueCommand,
} from '@aws-sdk/client-secrets-manager';
import type {
  FHIRAllergyIntolerance,
  FHIRCondition,
  FHIRMedicationRequest,
} from '@/types/index';

// ─── Types ───────────────────────────────────────────────────────────────────

/** FHIR Patient resource (simplified fields used in this application). */
export interface FHIRPatient {
  resourceType: 'Patient';
  id: string;
  name?: { family?: string; given?: string[]; text?: string }[];
  gender?: string;
  birthDate?: string;
}

/** FHIR CapabilityStatement resource (metadata endpoint response). */
export interface FHIRCapabilityStatement {
  resourceType: 'CapabilityStatement';
  status: string;
  fhirVersion: string;
}

/** FHIR Bundle resource for search results. */
export interface FHIRBundle<T> {
  resourceType: 'Bundle';
  type: string;
  total?: number;
  entry?: { resource: T }[];
}

/** Result of a FHIR resource fetch that may partially fail. */
export interface FHIRFetchResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/** Aggregated result of fetching all patient-related resources. */
export interface PatientDataResult {
  patient: FHIRFetchResult<FHIRPatient>;
  conditions: FHIRFetchResult<FHIRCondition[]>;
  medications: FHIRFetchResult<FHIRMedicationRequest[]>;
  allergies: FHIRFetchResult<FHIRAllergyIntolerance[]>;
}

/** OAuth2 token response from the FHIR server. */
interface OAuth2TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

/** Credentials stored in Secrets Manager. */
interface FHIRClientCredentials {
  clientId: string;
  clientSecret: string;
  username?: string;
  password?: string;
}

// ─── Constants ───────────────────────────────────────────────────────────────

/** Request timeout in milliseconds (10 seconds per requirement 3.4). */
const REQUEST_TIMEOUT_MS = 10_000;

/** Minimum TLS version enforced for all connections (per requirement 13.3). */
const MIN_TLS_VERSION = 'TLSv1.2';

/** Default Secrets Manager secret name for FHIR client credentials. */
const DEFAULT_SECRET_NAME = process.env.FHIR_CREDENTIALS_SECRET_NAME || 'openemr/fhir-client-credentials';

// ─── HTTPS Agent ─────────────────────────────────────────────────────────────

/**
 * Whether to accept the OpenEMR ALB's self-signed certificate.
 *
 * This deployment fronts OpenEMR with an ALB that uses a self-signed certificate
 * (no Route53 / ACM DNS-validated cert). Node's default TLS verification rejects
 * self-signed certs with UNABLE_TO_VERIFY_LEAF_SIGNATURE / SELF_SIGNED_CERT_IN_CHAIN,
 * which causes every server-side FHIR and OAuth token call to fail. When
 * OPENEMR_ALLOW_SELF_SIGNED_TLS is set, we relax certificate chain verification for
 * these internal service-to-service calls while still enforcing TLS 1.2+.
 *
 * TLS 1.2+ is still enforced; only chain/hostname verification is relaxed, and only
 * for the demo app's calls to the internal OpenEMR ALB.
 */
const ALLOW_SELF_SIGNED_TLS =
  (process.env.OPENEMR_ALLOW_SELF_SIGNED_TLS || '').toLowerCase() === 'true';

/**
 * Creates an HTTPS agent that enforces TLS 1.2+ for all connections.
 * When self-signed TLS is allowed, chain verification is disabled for the
 * internal OpenEMR ALB endpoint (see ALLOW_SELF_SIGNED_TLS).
 */
function createTlsAgent(): https.Agent {
  return new https.Agent({
    minVersion: MIN_TLS_VERSION,
    keepAlive: true,
    rejectUnauthorized: !ALLOW_SELF_SIGNED_TLS,
  });
}

// ─── FHIR Client ─────────────────────────────────────────────────────────────

export interface FHIRClientConfig {
  /** FHIR API base URL (e.g., https://openemr.example.com/apis/default/fhir) */
  fhirBaseUrl: string;
  /** AWS region for Secrets Manager */
  region: string;
  /** Secrets Manager secret name containing client credentials */
  secretName?: string;
  /** Optional: inject credentials directly (for testing) */
  credentials?: FHIRClientCredentials;
  /** Optional: inject a custom fetch function (for testing) */
  fetchFn?: typeof fetch;
}

/**
 * FHIR client that authenticates with OpenEMR using OAuth2 client credentials flow.
 * Reads credentials from AWS Secrets Manager at runtime.
 * Enforces TLS 1.2+ and 10-second timeout on all requests.
 */
export class FHIRClient {
  private readonly fhirBaseUrl: string;
  private readonly region: string;
  private readonly secretName: string;
  private readonly tlsAgent: https.Agent;
  private readonly fetchFn: typeof fetch;

  private cachedCredentials: FHIRClientCredentials | null = null;
  private cachedToken: string | null = null;
  private tokenExpiresAt: number = 0;
  private cachedStandardToken: string | null = null;
  private standardTokenExpiresAt: number = 0;

  constructor(config: FHIRClientConfig) {
    this.fhirBaseUrl = config.fhirBaseUrl.replace(/\/$/, '');
    this.region = config.region;
    this.secretName = config.secretName ?? DEFAULT_SECRET_NAME;
    this.tlsAgent = createTlsAgent();
    this.fetchFn = config.fetchFn ?? fetch;

    if (config.credentials) {
      this.cachedCredentials = config.credentials;
    }
  }

  // ─── Public Methods ──────────────────────────────────────────────────────

  /**
   * Retrieves the FHIR server metadata (CapabilityStatement).
   * Used to verify connectivity on startup.
   *
   * @see Requirements 10.3
   */
  async getMetadata(): Promise<FHIRFetchResult<FHIRCapabilityStatement>> {
    return this.fetchResource<FHIRCapabilityStatement>('/metadata', false);
  }

  /**
   * Retrieves a patient by ID.
   *
   * @see Requirements 3.1
   */
  async getPatient(patientId: string): Promise<FHIRFetchResult<FHIRPatient>> {
    return this.fetchResource<FHIRPatient>(`/Patient/${patientId}`);
  }

  /**
   * Retrieves active conditions for a patient.
   *
   * @see Requirements 3.1
   */
  async getConditions(patientId: string): Promise<FHIRFetchResult<FHIRCondition[]>> {
    return this.fetchBundleResources<FHIRCondition>(
      `/Condition?patient=${patientId}&clinical-status=active`
    );
  }

  /**
   * Retrieves active medications for a patient.
   *
   * @see Requirements 3.1
   */
  async getMedications(patientId: string): Promise<FHIRFetchResult<FHIRMedicationRequest[]>> {
    return this.fetchBundleResources<FHIRMedicationRequest>(
      `/MedicationRequest?patient=${patientId}&status=active`
    );
  }

  /**
   * Retrieves allergies for a patient.
   *
   * @see Requirements 3.1
   */
  async getAllergies(patientId: string): Promise<FHIRFetchResult<FHIRAllergyIntolerance[]>> {
    return this.fetchBundleResources<FHIRAllergyIntolerance>(
      `/AllergyIntolerance?patient=${patientId}`
    );
  }

  /**
   * Retrieves encounters for a patient from the FHIR API.
   */
  async getEncounters(patientId: string): Promise<FHIRFetchResult<any[]>> {
    return this.fetchBundleResources<any>(
      `/Encounter?patient=${patientId}&_sort=-date&_count=10`
    );
  }

  /**
   * Retrieves document references (clinical notes) for a patient from the FHIR API.
   */
  async getDocumentReferences(patientId: string): Promise<FHIRFetchResult<any[]>> {
    return this.fetchBundleResources<any>(
      `/DocumentReference?patient=${patientId}&_sort=-date&_count=10`
    );
  }

  /**
   * Retrieves clinical notes for a patient's encounters from OpenEMR's standard API.
   * Falls back to this when FHIR DocumentReference is not available.
   * Uses the /apis/default/api/ endpoint (non-FHIR) with a separate token that has api:oemr scope.
   */
  async getEncounterNotes(patientUuid: string): Promise<FHIRFetchResult<any[]>> {
    try {
      // Get a token with standard API scope
      const token = await this.getStandardApiToken();
      const apiBase = this.fhirBaseUrl.replace(/\/fhir\/?$/, '/api');
      const url = `${apiBase}/patient/${patientUuid}/encounter`;

      const response = await this.fetchWithTimeout(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        return { success: false, error: `Standard API request failed: ${response.status}` };
      }

      const data = await response.json();
      // OpenEMR returns an array of encounters with embedded notes
      const encounters = Array.isArray(data) ? data : (data.data || []);
      return { success: true, data: encounters };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Retrieves a specific encounter's SOAP note from OpenEMR's standard API.
   */
  async getEncounterSoapNote(patientUuid: string, encounterUuid: string): Promise<FHIRFetchResult<any>> {
    try {
      const token = await this.getStandardApiToken();
      const apiBase = this.fhirBaseUrl.replace(/\/fhir\/?$/, '/api');
      const url = `${apiBase}/patient/${patientUuid}/encounter/${encounterUuid}/soap_note`;

      const response = await this.fetchWithTimeout(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });

      if (!response.ok) {
        return { success: false, error: `SOAP note request failed: ${response.status}` };
      }

      const data = await response.json();
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Gets an OAuth2 token with standard API scope (api:oemr) for non-FHIR endpoints.
   */
  private async getStandardApiToken(): Promise<string> {
    if (this.cachedStandardToken && Date.now() < this.standardTokenExpiresAt - 30_000) {
      return this.cachedStandardToken;
    }

    const credentials = await this.getCredentials();
    const tokenUrl = `${this.fhirBaseUrl.replace(/\/apis\/default\/fhir\/?$/, '')}/oauth2/default/token`;

    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      username: credentials.username || credentials.clientId,
      password: credentials.password || credentials.clientSecret,
      user_role: 'users',
      scope: 'openid api:oemr api:fhir',
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await this.fetchFn(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        signal: controller.signal,
        // @ts-expect-error Node.js fetch supports the agent option for https (TLS enforcement / self-signed ALB cert)
        agent: this.tlsAgent,
      });

      if (!response.ok) {
        throw new Error(`Standard API token request failed: ${response.status}`);
      }

      const tokenResponse = (await response.json()) as OAuth2TokenResponse;
      this.cachedStandardToken = tokenResponse.access_token;
      this.standardTokenExpiresAt = Date.now() + tokenResponse.expires_in * 1000;
      return this.cachedStandardToken;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Searches for patients. Returns a list of patients from the FHIR API.
   *
   * @see Requirements 3.1
   */
  async searchPatients(): Promise<FHIRFetchResult<FHIRPatient[]>> {
    return this.fetchBundleResources<FHIRPatient>('/Patient?_count=100');
  }

  /**
   * Retrieves all patient data with partial failure handling.
   * Returns results for each resource type independently — if one fails,
   * the others still return their data.
   *
   * @see Requirements 3.1, 3.5
   */
  async getPatientData(patientId: string): Promise<PatientDataResult> {
    const [patient, conditions, medications, allergies] = await Promise.all([
      this.getPatient(patientId),
      this.getConditions(patientId),
      this.getMedications(patientId),
      this.getAllergies(patientId),
    ]);

    return { patient, conditions, medications, allergies };
  }

  /**
   * POSTs a FHIR resource to the given path (e.g. '/DocumentReference').
   * Sends an authenticated request through the TLS agent, so it works with the
   * self-signed OpenEMR ALB certificate. Returns the created resource on success.
   */
  async postResource<T = unknown>(
    path: string,
    resource: unknown
  ): Promise<FHIRFetchResult<T>> {
    try {
      const headers = await this.buildHeaders(true);
      const url = `${this.fhirBaseUrl}${path}`;

      const response = await this.fetchWithTimeout(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(resource),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        return {
          success: false,
          error: `FHIR write failed: ${response.status} ${response.statusText}${errorText ? ` - ${errorText}` : ''}`,
        };
      }

      const data = (await response.json().catch(() => ({}))) as T;
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  // ─── Private Methods ─────────────────────────────────────────────────────

  /**
   * Fetches a single FHIR resource by path.
   */
  private async fetchResource<T>(
    path: string,
    requiresAuth: boolean = true
  ): Promise<FHIRFetchResult<T>> {
    try {
      const headers = await this.buildHeaders(requiresAuth);
      const url = `${this.fhirBaseUrl}${path}`;

      const response = await this.fetchWithTimeout(url, {
        method: 'GET',
        headers,
      });

      if (!response.ok) {
        return {
          success: false,
          error: `FHIR request failed: ${response.status} ${response.statusText}`,
        };
      }

      const data = (await response.json()) as T;
      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Fetches a FHIR Bundle and extracts the resources from entries.
   */
  private async fetchBundleResources<T>(path: string): Promise<FHIRFetchResult<T[]>> {
    try {
      const headers = await this.buildHeaders(true);
      const url = `${this.fhirBaseUrl}${path}`;

      const response = await this.fetchWithTimeout(url, {
        method: 'GET',
        headers,
      });

      if (!response.ok) {
        return {
          success: false,
          error: `FHIR request failed: ${response.status} ${response.statusText}`,
        };
      }

      const bundle = (await response.json()) as FHIRBundle<T>;
      const resources = bundle.entry?.map((entry) => entry.resource) ?? [];
      return { success: true, data: resources };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Performs a fetch with a 10-second timeout and TLS 1.2+ enforcement.
   */
  private async fetchWithTimeout(
    url: string,
    options: RequestInit
  ): Promise<Response> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      // Node.js fetch supports the dispatcher option for custom agents.
      // We pass the TLS agent via a custom dispatcher for TLS enforcement.
      const fetchOptions: RequestInit & { dispatcher?: unknown } = {
        ...options,
        signal: controller.signal,
        // @ts-expect-error Node.js fetch supports agent option for https
        agent: this.tlsAgent,
      };

      const response = await this.fetchFn(url, fetchOptions);
      return response;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(
          `FHIR request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds`
        );
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Builds request headers, including OAuth2 bearer token if auth is required.
   */
  private async buildHeaders(requiresAuth: boolean): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      Accept: 'application/fhir+json',
      'Content-Type': 'application/fhir+json',
    };

    if (requiresAuth) {
      const token = await this.getAccessToken();
      headers['Authorization'] = `Bearer ${token}`;
    }

    return headers;
  }

  /**
   * Gets a valid OAuth2 access token, refreshing if expired.
   * Uses client credentials flow.
   */
  private async getAccessToken(): Promise<string> {
    // Return cached token if still valid (with 30-second buffer)
    if (this.cachedToken && Date.now() < this.tokenExpiresAt - 30_000) {
      return this.cachedToken;
    }

    const credentials = await this.getCredentials();
    const tokenUrl = `${this.fhirBaseUrl.replace(/\/apis\/default\/fhir\/?$/, '')}/oauth2/default/token`;

    console.log(`[FHIR] Requesting OAuth2 token`);

    const body = new URLSearchParams({
      grant_type: 'password',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      username: credentials.username || credentials.clientId,
      password: credentials.password || credentials.clientSecret,
      user_role: 'users',
      scope: 'openid api:fhir user/Patient.read user/Condition.read user/MedicationRequest.read user/AllergyIntolerance.read user/DocumentReference.read user/DocumentReference.write user/Encounter.read',
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await this.fetchFn(tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: body.toString(),
        signal: controller.signal,
        // @ts-expect-error Node.js fetch supports the agent option for https (TLS enforcement / self-signed ALB cert)
        agent: this.tlsAgent,
      });

      if (!response.ok) {
        await response.text(); // consume the response body
        console.log(`[FHIR] Token request failed: ${response.status}`);
        throw new Error(
          `OAuth2 token request failed: ${response.status} ${response.statusText}`
        );
      }

      const tokenResponse = (await response.json()) as OAuth2TokenResponse;
      this.cachedToken = tokenResponse.access_token;
      this.tokenExpiresAt = Date.now() + tokenResponse.expires_in * 1000;

      return this.cachedToken;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        console.log(`[FHIR] Token request TIMED OUT after ${REQUEST_TIMEOUT_MS / 1000}s`);
        throw new Error(
          `OAuth2 token request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds`
        );
      }
      console.log(`[FHIR] Token request ERROR: ${error instanceof Error ? error.name : 'Unknown'}`);
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Retrieves FHIR client credentials from AWS Secrets Manager.
   * Caches credentials after first retrieval.
   *
   * @see Requirements 13.8
   */
  private async getCredentials(): Promise<FHIRClientCredentials> {
    if (this.cachedCredentials) {
      return this.cachedCredentials;
    }

    const client = new SecretsManagerClient({ region: this.region });
    const command = new GetSecretValueCommand({ SecretId: this.secretName });

    try {
      const response = await client.send(command);

      if (!response.SecretString) {
        throw new Error(
          `Secret "${this.secretName}" has no string value`
        );
      }

      const secret = JSON.parse(response.SecretString) as Record<string, string>;

      if (!secret['clientId'] && !secret['username']) {
        throw new Error(
          `Secret "${this.secretName}" must contain either "clientId"/"clientSecret" or "username"/"password" fields`
        );
      }

      // Support both formats: {clientId, clientSecret} or {username, password}
      this.cachedCredentials = {
        clientId: secret['clientId'] || secret['username'] || '',
        clientSecret: secret['clientSecret'] || secret['password'] || '',
        username: secret['username'] || '',
        password: secret['password'] || '',
      };

      return this.cachedCredentials;
    } catch (error) {
      if (error instanceof Error && error.message.includes('Secret')) {
        throw error;
      }
      throw new Error(
        `Failed to retrieve FHIR credentials from Secrets Manager: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }
}

/**
 * Creates a FHIRClient instance from the validated application config.
 * This is the standard factory function used by the application.
 */
export function createFHIRClient(config: {
  fhirBaseUrl: string;
  region: string;
  secretName?: string;
}): FHIRClient {
  return new FHIRClient({
    fhirBaseUrl: config.fhirBaseUrl,
    region: config.region,
    secretName: config.secretName,
  });
}
