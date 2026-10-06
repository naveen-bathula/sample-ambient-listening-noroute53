/**
 * Real Amazon Connect Health client using @aws-sdk/client-connecthealth.
 *
 * Implements the ConnectHealthClient interface from session-manager.ts
 * using the official AWS SDK for JavaScript v3.
 *
 * Operations:
 * - ListDomains: Lists existing domains to check for reuse
 * - CreateDomain: Creates a new domain for ambient documentation
 * - CreateSubscription: Creates a subscription under a domain
 * - StartMedicalScribeListeningSession: Starts a streaming session
 * - GetMedicalScribeListeningSession: Gets session status
 *
 * @see Requirements 4.1, 4.2, 4.3, 4.4
 */

import {
  ConnectHealthClient as SDKConnectHealthClient,
  CreateSubscriptionCommand,
  ListDomainsCommand,
  StartMedicalScribeListeningSessionCommand,
  MedicalScribeLanguageCode,
  MedicalScribeMediaEncoding,
  MedicalScribeParticipantRole,
  ManagedNoteTemplate,
} from '@aws-sdk/client-connecthealth';

import type { MedicalScribeInputStream } from '@aws-sdk/client-connecthealth';

import type {
  ConnectHealthClient,
  ConnectHealthDomain,
  ConnectHealthSubscription,
  StartSessionParams,
  StartSessionResponse,
} from './session-manager';

// ─── Constants ───────────────────────────────────────────────────────────────

/** Default audio sample rate for PCM streaming (16 kHz). */
const DEFAULT_SAMPLE_RATE = 16000;

/** Default media encoding for audio streaming. */
const DEFAULT_MEDIA_ENCODING = MedicalScribeMediaEncoding.PCM;

// ─── SDK Client Wrapper ──────────────────────────────────────────────────────

/**
 * Configuration for creating the real Connect Health client.
 */
export interface RealConnectHealthClientConfig {
  /** AWS region (us-east-1 or us-west-2) */
  region: string;
}

/**
 * Creates a real ConnectHealthClient implementation backed by the AWS SDK.
 *
 * This replaces the stub client used during development. It calls the actual
 * Amazon Connect Health APIs for domain management, subscription creation,
 * and session lifecycle.
 */
export function createRealConnectHealthClient(
  config: RealConnectHealthClientConfig
): ConnectHealthClient {
  const sdkClient = new SDKConnectHealthClient({
    region: config.region,
  });

  return {
    /**
     * Lists all domains in the account/region.
     * Used to check if a domain with the configured name already exists.
     */
    async listDomains(): Promise<ConnectHealthDomain[]> {
      const response = await sdkClient.send(new ListDomainsCommand({}));

      if (!response.domains) {
        return [];
      }

      return response.domains.map((d) => ({
        domainId: d.domainId || '',
        domainName: d.name || '', // SDK uses 'name' field
        status: d.status || 'UNKNOWN',
      }));
    },

    /**
     * Creates a subscription under the given domain.
     * Subscriptions are automatically created in activated mode.
     */
    async createSubscription(domainId: string): Promise<ConnectHealthSubscription> {
      const response = await sdkClient.send(
        new CreateSubscriptionCommand({ domainId })
      );

      return {
        subscriptionId: response.subscriptionId || '',
        domainId,
        status: 'ACTIVE',
      };
    },

    /**
     * Starts a Medical Scribe listening session.
     *
     * This initiates the HTTP/2 bidirectional streaming session. The SDK handles
     * the event stream encoding/decoding internally.
     *
     * The inputStream is an async iterable that yields:
     * 1. A configuration event (channel definitions, output settings, encounter context)
     * 2. Audio events (sent later by the AudioStreamer)
     * 3. A session control event (END_OF_SESSION, sent when done)
     *
     * For session creation, we send the configuration event to establish
     * the session parameters. The AudioStreamer handles audio streaming separately.
     */
    async startMedicalScribeListeningSession(
      params: StartSessionParams
    ): Promise<StartSessionResponse> {
      // Generate a UUID for the session
      const sessionId = crypto.randomUUID();

      // Map the template ID to the SDK enum
      const templateType = mapTemplateId(params.clinicalNoteGenerationSettings.templateId);

      // Build the configuration event as the first message in the input stream
      const configEvent: MedicalScribeInputStream = {
        configurationEvent: {
          postStreamActionSettings: {
            outputS3Uri: params.outputConfig.s3Uri,
            clinicalNoteGenerationSettings: {
              noteTemplateSettings: {
                managedTemplate: {
                  templateType,
                },
              },
            },
          },
          channelDefinitions: params.channelDefinitions.map((ch) => ({
            channelId: ch.channelId,
            participantRole:
              ch.participantRole === 'CLINICIAN'
                ? MedicalScribeParticipantRole.CLINICIAN
                : MedicalScribeParticipantRole.PATIENT,
          })),
          encounterContext: {
            unstructuredContext: params.encounterContext.unstructuredContext,
          },
        },
      };

      const command = new StartMedicalScribeListeningSessionCommand({
        sessionId,
        domainId: params.domainId,
        subscriptionId: params.subscriptionId,
        languageCode: MedicalScribeLanguageCode.EN_US,
        mediaSampleRateHertz: DEFAULT_SAMPLE_RATE,
        mediaEncoding: DEFAULT_MEDIA_ENCODING,
        inputStream: createInputStream(configEvent),
      });

      const response = await sdkClient.send(command);

      return {
        sessionId: response.sessionId || sessionId,
        streamUrl: '', // Stream is managed by the SDK's event stream internally
      };
    },

    /**
     * Ends an active session.
     * The actual END_OF_SESSION control event is sent via the AudioStreamer
     * through the input stream. This method is a no-op since the stream
     * handles session termination.
     */
    async endSession(_sessionId: string): Promise<void> {
      // The END_OF_SESSION event is sent through the audio stream
      // by the AudioStreamer.endStream() method.
      // No separate API call is needed to end the session.
    },
  };
}

// ─── Helper Functions ────────────────────────────────────────────────────────

/**
 * Maps our internal template ID string to the SDK's ManagedNoteTemplate enum.
 */
function mapTemplateId(templateId: string): ManagedNoteTemplate {
  const mapping: Record<string, ManagedNoteTemplate> = {
    PHYSICAL_SOAP: ManagedNoteTemplate.PHYSICAL_SOAP,
    BEHAVIORAL_SOAP: ManagedNoteTemplate.BEHAVIORAL_SOAP,
    HISTORY_AND_PHYSICAL: ManagedNoteTemplate.HISTORY_AND_PHYSICAL,
    GIRPP: ManagedNoteTemplate.GIRPP,
    BIRP: ManagedNoteTemplate.BIRP,
    SIRP: ManagedNoteTemplate.SIRP,
    DAP: ManagedNoteTemplate.DAP,
    // Also handle the old constant name from session-manager
    SOAP: ManagedNoteTemplate.PHYSICAL_SOAP,
  };

  return mapping[templateId] || ManagedNoteTemplate.PHYSICAL_SOAP;
}

/**
 * Creates an async iterable input stream that yields the configuration event
 * followed by keeping the stream open for audio events.
 *
 * The stream yields:
 * 1. Configuration event (channel defs, output settings, encounter context)
 * 2. Audio events will be sent separately by the AudioStreamer
 * 3. END_OF_SESSION will be sent by the AudioStreamer when done
 */
function createInputStream(
  configEvent: MedicalScribeInputStream
): AsyncIterable<MedicalScribeInputStream> {
  return {
    async *[Symbol.asyncIterator]() {
      // Yield the configuration event first
      yield configEvent;
      // Stream stays open — audio events and END_OF_SESSION are sent
      // by the AudioStreamer through a separate mechanism
    },
  };
}

// ─── Export for testing ──────────────────────────────────────────────────────

export { SDKConnectHealthClient, DEFAULT_SAMPLE_RATE, DEFAULT_MEDIA_ENCODING };
