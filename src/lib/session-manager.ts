/**
 * Session lifecycle state machine and manager for the Ambient Clinical Documentation Demo.
 *
 * Manages valid state transitions through the session lifecycle:
 * creating_domain → creating_subscription → creating_session → active → ending → ended
 *
 * The SessionManager class orchestrates the full lifecycle:
 * - Domain creation/reuse (matched by name)
 * - Subscription creation
 * - Session creation with patient context, channel definitions, SOAP template, and S3 output URI
 * - Session ending
 *
 * Any state can transition to 'error'.
 * Transitions only move forward through the defined stages.
 *
 * @see Requirements 4.1, 4.2, 4.3, 4.5, 4.6, 11.1
 */

import type { AmbientSession, SessionError } from '@/types';
import type { ValidatedConfig } from './config';

/** All valid session statuses in lifecycle order. */
export type SessionStatus = AmbientSession['status'];

/**
 * Ordered list of session lifecycle stages (excluding 'error').
 * The index represents the forward progression order.
 */
export const SESSION_LIFECYCLE_ORDER: readonly SessionStatus[] = [
  'creating_domain',
  'creating_subscription',
  'creating_session',
  'active',
  'ending',
  'ended',
] as const;

/**
 * Returns the valid next statuses that a given status can transition to.
 * Any status can transition to 'error'.
 * Forward transitions skip at most one step ahead in the lifecycle.
 */
export function getValidTransitions(currentStatus: SessionStatus): SessionStatus[] {
  if (currentStatus === 'error') {
    // Error is a terminal state — no transitions out
    return [];
  }

  if (currentStatus === 'ended') {
    // Ended is a terminal state — no transitions out (except error)
    return ['error'];
  }

  const currentIndex = SESSION_LIFECYCLE_ORDER.indexOf(currentStatus);
  if (currentIndex === -1) {
    return [];
  }

  // Can transition to the next stage in the lifecycle, or to error
  const nextStatus = SESSION_LIFECYCLE_ORDER[currentIndex + 1];
  return nextStatus ? [nextStatus, 'error'] : ['error'];
}

/**
 * Validates whether a transition from currentStatus to nextStatus is allowed.
 *
 * Rules:
 * - Transitions must move forward (higher index in SESSION_LIFECYCLE_ORDER)
 * - Any non-error state can transition to 'error'
 * - 'error' and 'ended' are terminal states (no outbound transitions, except ended→error)
 * - Only immediate next step transitions are valid (no skipping stages)
 */
export function isValidTransition(currentStatus: SessionStatus, nextStatus: SessionStatus): boolean {
  if (currentStatus === nextStatus) {
    return false;
  }

  const validNext = getValidTransitions(currentStatus);
  return validNext.includes(nextStatus);
}

/**
 * Attempts to transition a session to a new status.
 *
 * @param currentStatus - The current session status
 * @param nextStatus - The desired next status
 * @returns The new status if the transition is valid
 * @throws Error if the transition is invalid
 */
export function transitionSession(currentStatus: SessionStatus, nextStatus: SessionStatus): SessionStatus {
  if (!isValidTransition(currentStatus, nextStatus)) {
    throw new Error(
      `Invalid session transition: cannot move from '${currentStatus}' to '${nextStatus}'. ` +
      `Valid transitions from '${currentStatus}': [${getValidTransitions(currentStatus).join(', ')}]`
    );
  }
  return nextStatus;
}

/**
 * Returns the index of a status in the lifecycle order.
 * Returns -1 for 'error' (which is outside the normal lifecycle).
 */
export function getLifecycleIndex(status: SessionStatus): number {
  if (status === 'error') {
    return -1;
  }
  return SESSION_LIFECYCLE_ORDER.indexOf(status);
}

/**
 * Determines if moving from one status to another would be a backward transition.
 * A backward transition is one where the target has a lower lifecycle index than the source.
 */
export function isBackwardTransition(fromStatus: SessionStatus, toStatus: SessionStatus): boolean {
  if (fromStatus === 'error' || toStatus === 'error') {
    return false; // Error transitions are not considered backward
  }

  const fromIndex = getLifecycleIndex(fromStatus);
  const toIndex = getLifecycleIndex(toStatus);

  return toIndex < fromIndex;
}


// ─── Error Stage Identification ──────────────────────────────────────────────

/**
 * Maps a session lifecycle status to the corresponding error stage.
 * Used to identify which stage failed when a session transitions to error.
 *
 * @see Requirements 4.5
 */
export type ErrorStage = SessionError['stage'];

/**
 * Mapping from session lifecycle status to the error stage that should be reported
 * when a failure occurs during that status.
 */
const STATUS_TO_ERROR_STAGE: Record<string, ErrorStage> = {
  creating_domain: 'domain',
  creating_subscription: 'subscription',
  creating_session: 'session',
  active: 'streaming',
  ending: 'streaming',
  ended: 'output_retrieval',
};

/**
 * Suggested corrective actions for each error stage.
 */
const SUGGESTED_ACTIONS: Record<ErrorStage, string> = {
  domain: 'Verify your AWS credentials have connecthealth:CreateDomain and connecthealth:GetDomain permissions, and check that the configured region (us-east-1 or us-west-2) is correct.',
  subscription: 'Verify your AWS credentials have connecthealth:CreateSubscription permission and that the domain was created successfully.',
  session: 'Verify the patient context is within the 10KB limit, check that the domain and subscription are active, and ensure your region supports Amazon Connect Health.',
  streaming: 'Check your network connection and ensure the HTTP/2 stream has not timed out. You may need to restart the session.',
  output_retrieval: 'Verify the S3 output bucket exists and your IAM role has s3:GetObject and s3:ListBucket permissions on the bucket.',
};

/**
 * Creates a SessionError for a failure that occurred during a specific lifecycle stage.
 *
 * For any failure occurring during domain creation, subscription creation, or session creation,
 * the error SHALL correctly identify the failure stage and include a non-empty corrective
 * action suggestion.
 *
 * @param failureStatus - The session status at the time of failure
 * @param errorMessage - The error message describing what went wrong
 * @returns A SessionError with the correct stage identification and suggested action
 *
 * @see Requirements 4.5
 */
export function createSessionError(failureStatus: SessionStatus, errorMessage: string): SessionError {
  const stage = STATUS_TO_ERROR_STAGE[failureStatus] || 'session';
  const suggestedAction = SUGGESTED_ACTIONS[stage];

  return {
    stage,
    message: errorMessage,
    suggestedAction,
  };
}

/**
 * Identifies the error stage from a session lifecycle status.
 *
 * @param status - The session status at the time of failure
 * @returns The error stage corresponding to the given status
 */
export function identifyErrorStage(status: SessionStatus): ErrorStage {
  return STATUS_TO_ERROR_STAGE[status] || 'session';
}

/**
 * Returns the suggested corrective action for a given error stage.
 *
 * @param stage - The error stage
 * @returns A non-empty string with corrective action suggestions
 */
export function getSuggestedAction(stage: ErrorStage): string {
  return SUGGESTED_ACTIONS[stage];
}


// ─── Connect Health Client Interface ─────────────────────────────────────────

/**
 * Represents a domain resource from Amazon Connect Health.
 */
export interface ConnectHealthDomain {
  domainId: string;
  domainName: string;
  status: string;
}

/**
 * Represents a subscription resource from Amazon Connect Health.
 */
export interface ConnectHealthSubscription {
  subscriptionId: string;
  domainId: string;
  status: string;
}

/**
 * Channel definition for the ambient session.
 * CLINICIAN is channel 0, PATIENT is channel 1.
 *
 * @see Requirements 4.3
 */
export interface ChannelDefinition {
  channelId: number;
  participantRole: 'CLINICIAN' | 'PATIENT';
}

/**
 * Parameters for starting a medical scribe listening session.
 */
export interface StartSessionParams {
  domainId: string;
  subscriptionId: string;
  encounterContext: {
    unstructuredContext: string;
  };
  channelDefinitions: ChannelDefinition[];
  outputConfig: {
    s3Uri: string;
  };
  postStreamAnalyticsSettings: {
    contentIdentificationType: 'PHI_IDENTIFICATION';
  };
  clinicalNoteGenerationSettings: {
    templateId: string;
  };
  languageCode: string;
}

/**
 * Response from starting a medical scribe listening session.
 */
export interface StartSessionResponse {
  sessionId: string;
  streamUrl: string;
}

/**
 * Interface for the Amazon Connect Health API client.
 * This abstraction allows for testing with mock implementations.
 */
export interface ConnectHealthClient {
  listDomains(): Promise<ConnectHealthDomain[]>;
  createDomain(domainName: string): Promise<ConnectHealthDomain>;
  createSubscription(domainId: string): Promise<ConnectHealthSubscription>;
  startMedicalScribeListeningSession(params: StartSessionParams): Promise<StartSessionResponse>;
  endSession(sessionId: string): Promise<void>;
}

// ─── Session Manager Configuration ──────────────────────────────────────────

/**
 * Configuration required by the SessionManager.
 */
export interface SessionManagerConfig {
  region: string;
  s3OutputBucket: string;
  domainName: string;
}

/**
 * Listener for session state changes.
 */
export type SessionStateListener = (session: AmbientSession) => void;

// ─── Default Channel Definitions ─────────────────────────────────────────────

/**
 * Default channel definitions for the ambient session.
 * CLINICIAN is assigned to channel 0, PATIENT to channel 1.
 *
 * @see Requirements 4.3
 */
export const DEFAULT_CHANNEL_DEFINITIONS: ChannelDefinition[] = [
  { channelId: 0, participantRole: 'CLINICIAN' },
  { channelId: 1, participantRole: 'PATIENT' },
];

/**
 * The clinical note template used for SOAP note generation.
 */
export const CLINICAL_NOTE_TEMPLATE_ID = 'PHYSICAL_SOAP';

/**
 * The S3 output path prefix for health agent listening sessions.
 */
export const OUTPUT_S3_PATH_PREFIX = 'health-agent-listening-session/';

/**
 * The language code for the ambient session (US English only).
 *
 * @see Requirements 11.1
 */
export const SESSION_LANGUAGE_CODE = 'en-US';

// ─── Session Manager Class ───────────────────────────────────────────────────

/**
 * Manages the full Amazon Connect Health session lifecycle.
 *
 * Orchestrates:
 * 1. Domain creation or reuse (matched by name)
 * 2. Subscription creation under the domain
 * 3. Session creation with patient context, channel definitions, SOAP template, and S3 output URI
 * 4. Session ending
 *
 * Emits state changes via registered listeners so the UI can track lifecycle stage.
 *
 * @see Requirements 4.1, 4.2, 4.3, 4.5, 4.6, 11.1
 */
export class SessionManager {
  private readonly config: SessionManagerConfig;
  private readonly client: ConnectHealthClient;
  private readonly listeners: SessionStateListener[] = [];
  private sessions: Map<string, AmbientSession> = new Map();

  constructor(config: SessionManagerConfig, client: ConnectHealthClient) {
    this.config = config;
    this.client = client;
  }

  /**
   * Creates a SessionManager from a ValidatedConfig and a ConnectHealthClient.
   */
  static fromConfig(config: ValidatedConfig, client: ConnectHealthClient): SessionManager {
    return new SessionManager(
      {
        region: config.aws.region,
        s3OutputBucket: config.aws.s3OutputBucket,
        domainName: config.connectHealth.domainName,
      },
      client
    );
  }

  /**
   * Registers a listener that will be called on every session state change.
   */
  onStateChange(listener: SessionStateListener): void {
    this.listeners.push(listener);
  }

  /**
   * Removes a previously registered state change listener.
   */
  removeStateChangeListener(listener: SessionStateListener): void {
    const index = this.listeners.indexOf(listener);
    if (index !== -1) {
      this.listeners.splice(index, 1);
    }
  }

  /**
   * Returns the current session state for a given session ID.
   */
  getSession(sessionId: string): AmbientSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Starts a new ambient session, orchestrating the full lifecycle:
   * 1. Create or reuse domain (matched by name)
   * 2. Create subscription
   * 3. Create session with patient context
   *
   * @param patientId - The patient identifier
   * @param patientContext - The formatted patient context string (max 10KB)
   * @returns The created AmbientSession in 'active' state
   * @throws Error if any lifecycle stage fails (session will be in 'error' state)
   *
   * @see Requirements 4.1, 4.2, 4.3, 4.5, 4.6, 11.1
   */
  async startSession(patientId: string, patientContext: string): Promise<AmbientSession> {
    const outputS3Uri = `s3://${this.config.s3OutputBucket}/${OUTPUT_S3_PATH_PREFIX}`;

    // Initialize session in creating_domain state
    const session: AmbientSession = {
      sessionId: '', // Will be set after session creation
      domainId: '',
      subscriptionId: '',
      status: 'creating_domain',
      patientId,
      patientContext,
      outputS3Uri,
      startedAt: new Date(),
    };

    // Use a temporary key until we have a real session ID
    const tempKey = `pending-${Date.now()}`;
    this.sessions.set(tempKey, session);
    this.notifyListeners(session);

    try {
      // Step 1: Create or reuse domain
      const domain = await this.getOrCreateDomain();
      session.domainId = domain.domainId;

      // Transition to creating_subscription
      session.status = transitionSession(session.status, 'creating_subscription');
      this.notifyListeners(session);

      // Step 2: Create subscription
      const subscription = await this.createSubscription(domain.domainId);
      session.subscriptionId = subscription.subscriptionId;

      // Transition to creating_session
      session.status = transitionSession(session.status, 'creating_session');
      this.notifyListeners(session);

      // Step 3: Create session with patient context
      const startResponse = await this.createSession(
        domain.domainId,
        subscription.subscriptionId,
        patientContext,
        outputS3Uri
      );
      session.sessionId = startResponse.sessionId;

      // Move from temp key to real session ID
      this.sessions.delete(tempKey);
      this.sessions.set(session.sessionId, session);

      // Transition to active
      session.status = transitionSession(session.status, 'active');
      this.notifyListeners(session);

      return session;
    } catch (error) {
      // Transition to error state with proper stage identification
      const errorMessage = error instanceof Error ? error.message : String(error);
      session.error = createSessionError(session.status, errorMessage);
      session.status = 'error';
      this.notifyListeners(session);

      // Clean up temp key if session ID was never set
      if (!session.sessionId) {
        this.sessions.delete(tempKey);
      }

      throw error;
    }
  }

  /**
   * Ends an active session by sending the END_OF_SESSION control event.
   *
   * @param sessionId - The session ID to end
   * @returns The updated AmbientSession in 'ended' state
   * @throws Error if the session is not found or not in a valid state to end
   *
   * @see Requirements 4.4
   */
  async endSession(sessionId: string): Promise<AmbientSession> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    if (session.status !== 'active') {
      throw new Error(
        `Cannot end session in '${session.status}' state. Session must be 'active' to end.`
      );
    }

    try {
      // Transition to ending
      session.status = transitionSession(session.status, 'ending');
      this.notifyListeners(session);

      // Send END_OF_SESSION control event
      await this.client.endSession(sessionId);

      // Transition to ended
      session.status = transitionSession(session.status, 'ended');
      session.endedAt = new Date();
      this.notifyListeners(session);

      return session;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      session.error = createSessionError(session.status, errorMessage);
      session.status = 'error';
      this.notifyListeners(session);
      throw error;
    }
  }

  // ─── Private Methods ─────────────────────────────────────────────────────────

  /**
   * Gets an existing domain by name or creates a new one.
   * Implements domain reuse by matching on domain name.
   *
   * @see Requirements 4.1
   */
  private async getOrCreateDomain(): Promise<ConnectHealthDomain> {
    // List existing domains and check for a match by name.
    const domains = await this.client.listDomains();
    const existingDomain = domains.find(
      (d) => d.domainName === this.config.domainName
    );

    if (existingDomain) {
      return existingDomain;
    }

    // The domain must be created out-of-band (e.g. via the AWS console during a
    // workshop) and referenced by name through CONNECT_HEALTH_DOMAIN_NAME. We do
    // NOT create it here; fail with a clear, actionable message instead.
    throw new Error(
      `Amazon Connect Health domain "${this.config.domainName}" was not found. ` +
        `Create it manually and set CONNECT_HEALTH_DOMAIN_NAME on the Demo App ECS task.`
    );
  }

  /**
   * Creates a subscription under the given domain.
   *
   * @see Requirements 4.1
   */
  private async createSubscription(domainId: string): Promise<ConnectHealthSubscription> {
    return this.client.createSubscription(domainId);
  }

  /**
   * Creates a medical scribe listening session with the full configuration:
   * - Patient context in encounterContext.unstructuredContext
   * - Channel definitions (CLINICIAN=0, PATIENT=1)
   * - Output S3 URI
   * - PHI identification for post-stream analytics
   * - PHYSICAL_SOAP template for clinical note generation
   * - en-US language code
   *
   * @see Requirements 4.2, 4.3, 11.1
   */
  private async createSession(
    domainId: string,
    subscriptionId: string,
    patientContext: string,
    outputS3Uri: string
  ): Promise<StartSessionResponse> {
    return this.client.startMedicalScribeListeningSession({
      domainId,
      subscriptionId,
      encounterContext: {
        unstructuredContext: patientContext,
      },
      channelDefinitions: DEFAULT_CHANNEL_DEFINITIONS,
      outputConfig: {
        s3Uri: outputS3Uri,
      },
      postStreamAnalyticsSettings: {
        contentIdentificationType: 'PHI_IDENTIFICATION',
      },
      clinicalNoteGenerationSettings: {
        templateId: CLINICAL_NOTE_TEMPLATE_ID,
      },
      languageCode: SESSION_LANGUAGE_CODE,
    });
  }

  /**
   * Notifies all registered listeners of a session state change.
   */
  private notifyListeners(session: AmbientSession): void {
    for (const listener of this.listeners) {
      listener(session);
    }
  }
}
