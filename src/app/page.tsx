'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { SessionProvider, useSession } from '@/lib/session-context';
import { PatientSelector, Patient } from '@/components/PatientSelector';
import { PatientContextPanel } from '@/components/PatientContextPanel';
import { SessionControls, AudioSource } from '@/components/SessionControls';
import { AudioIndicator } from '@/components/AudioIndicator';
import { TranscriptView } from '@/components/TranscriptView';
import { ClinicalNotePanel } from '@/components/ClinicalNotePanel';
import { AfterVisitSummaryPanel } from '@/components/AfterVisitSummaryPanel';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import type { EvidenceMapping } from '@/types';

// ─── Tab Types ───────────────────────────────────────────────────────────────

type OutputTab = 'clinical-note' | 'after-visit-summary';

// ─── Main Page Content (inside SessionProvider) ──────────────────────────────

function AmbientDocumentationContent() {
  const { state, addTranscript, setError, endSession, reset } = useSession();
  const [selectedPatient, setSelectedPatient] = useState<Patient | null>(null);
  const [patientContext, setPatientContext] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<OutputTab>('clinical-note');
  const [highlightedSegmentId, setHighlightedSegmentId] = useState<string | null>(null);
  const [audioSource, setAudioSource] = useState<AudioSource>('microphone');
  const [wavFile, setWavFile] = useState<File | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);

  const session = state.session;
  const isSessionActive = session?.status === 'active';

  // When session becomes active, start streaming audio and listening for transcripts
  useEffect(() => {
    if (isSessionActive && session && !isStreaming) {
      console.log('[Ambient] Session active, starting audio streaming...');

      // Start audio streaming based on source
      if (audioSource === 'wav' && wavFile) {
        streamWavFile(wavFile, session.sessionId);
      } else if (audioSource === 'microphone') {
        startMicrophoneStreaming(session.sessionId);
      }

      // Cleanup
      return () => {
        stopMicrophoneStreaming();
      };
    }
    return undefined;
  }, [isSessionActive]);

  /**
   * Streams a WAV file to the audio-stream endpoint.
   * Parses the WAV header to find the PCM data offset and sample rate,
   * then streams chunks at real-time rate with required session headers.
   */
  async function streamWavFile(file: File, sessionId: string) {
    setIsStreaming(true);
    console.log('[Ambient] Starting WAV file streaming');
    try {
      const arrayBuffer = await file.arrayBuffer();
      const view = new DataView(arrayBuffer);

      // Parse WAV header to find data chunk offset and audio properties
      let pcmStart = 44; // default fallback
      let sampleRate = 16000;
      let numChannels = 2;
      let bitDepth = 16;

      // Verify RIFF/WAVE header
      if (arrayBuffer.byteLength >= 44) {
        const riff = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
        const wave = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));

        if (riff === 'RIFF' && wave === 'WAVE') {
          // Find fmt and data chunks
          let offset = 12;
          while (offset < arrayBuffer.byteLength - 8) {
            const chunkId = String.fromCharCode(
              view.getUint8(offset), view.getUint8(offset + 1),
              view.getUint8(offset + 2), view.getUint8(offset + 3)
            );
            const chunkSize = view.getUint32(offset + 4, true);

            if (chunkId === 'fmt ') {
              numChannels = view.getUint16(offset + 10, true);
              sampleRate = view.getUint32(offset + 12, true);
              bitDepth = view.getUint16(offset + 22, true);
            } else if (chunkId === 'data') {
              pcmStart = offset + 8;
              break;
            }
            offset += 8 + chunkSize;
          }
        }
      }

      console.log(`[Ambient] WAV: ${sampleRate}Hz, ${numChannels}ch, ${bitDepth}-bit, data@${pcmStart}`);

      const buffer = new Uint8Array(arrayBuffer);
      const bytesPerSecond = sampleRate * (bitDepth / 8) * numChannels;
      const CHUNK_INTERVAL_MS = 100;
      const CHUNK_SIZE = Math.floor((bytesPerSecond * CHUNK_INTERVAL_MS) / 1000);
      let isFirstChunk = true;

      for (let offset = pcmStart; offset < buffer.length; offset += CHUNK_SIZE) {
        const chunk = buffer.slice(offset, Math.min(offset + CHUNK_SIZE, buffer.length));

        const headers: Record<string, string> = {
          'Content-Type': 'application/octet-stream',
          'x-action': 'chunk',
        };

        // First chunk must include domain/subscription IDs and sample rate
        if (isFirstChunk) {
          headers['x-domain-id'] = session?.domainId || '';
          headers['x-subscription-id'] = session?.subscriptionId || '';
          headers['x-sample-rate'] = String(sampleRate);
          isFirstChunk = false;
        }

        const resp = await fetch(`/api/sessions/${sessionId}/audio-stream`, {
          method: 'POST',
          headers,
          body: chunk,
          credentials: 'include',
        });

        if (!resp.ok) {
          const errData = await resp.json().catch(() => ({}));
          console.error('[Ambient] Audio stream error:', resp.status, errData);
          throw new Error(errData.message || `Audio stream failed: ${resp.status}`);
        }

        // Parse response for transcripts
        const data = await resp.json();
        if (data.transcripts && data.transcripts.length > 0) {
          for (const t of data.transcripts) {
            addTranscript(t);
          }
        }

        // Stream at real-time rate
        await new Promise(resolve => setTimeout(resolve, CHUNK_INTERVAL_MS));
      }

      // Signal end of audio
      await fetch(`/api/sessions/${sessionId}/audio-stream`, {
        method: 'POST',
        headers: { 'x-action': 'end' },
        credentials: 'include',
      });

      console.log('[Ambient] WAV file streaming complete, auto-ending session...');

      // Auto-end the session since the file is done — no need for manual "End Session" click
      await endSession();
    } catch (err) {
      console.error('[Ambient] WAV streaming error:', err);
      setError(err instanceof Error ? err.message : 'Failed to stream WAV file');
    } finally {
      setIsStreaming(false);
    }
  }

  /**
   * Starts capturing microphone audio and streaming to the audio-stream endpoint.
   */
  async function startMicrophoneStreaming(_sessionId: string) {
    setIsStreaming(true);
    console.log('[Ambient] Starting microphone streaming');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      mediaStreamRef.current = stream;

      // Connect to WebSocket server via ALB (/ws path routes to port 3001)
      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${window.location.host}/ws`;

      const ws = new WebSocket(wsUrl);
      (window as any).__ambientWs = ws;

      ws.onerror = (err) => {
        console.error('[Ambient] WebSocket error:', err);
      };

      ws.onclose = () => {
        console.log('[Ambient] WebSocket closed');
      };

      // Use default AudioContext
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      const actualSampleRate = audioContext.sampleRate;

      const source = audioContext.createMediaStreamSource(stream);
      const processor = audioContext.createScriptProcessor(4096, 1, 1);
      processorRef.current = processor;

      ws.onopen = () => {
        ws.send(JSON.stringify({
          type: 'start',
          sessionId: session?.sessionId,
          domainId: session?.domainId,
          subscriptionId: session?.subscriptionId,
          sampleRate: 16000, // Downsample to 16kHz to match WAV file format
        }));
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'transcript' && msg.content && !msg.isPartial) {
            addTranscript({
              id: msg.id,
              content: msg.content,
              speaker: 'CLINICIAN',
              channelId: 0,
              startTime: msg.startTime || 0,
              endTime: msg.endTime || 0,
              isPartial: false,
            });
          }
        } catch { /* ignore */ }
      };

      // Downsample from native rate (48kHz) to 16kHz before sending
      const downsampleRatio = Math.round(actualSampleRate / 16000);

      processor.onaudioprocess = (e) => {
        if (ws.readyState !== WebSocket.OPEN) return;

        const inputData = e.inputBuffer.getChannelData(0);
        // Downsample and convert Float32 to Int16 PCM
        const outputLength = Math.floor(inputData.length / downsampleRatio);
        const pcm16 = new Int16Array(outputLength);
        for (let i = 0; i < outputLength; i++) {
          const s = Math.max(-1, Math.min(1, inputData[i * downsampleRatio] ?? 0));
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        ws.send(pcm16.buffer);
      };

      source.connect(processor);
      processor.connect(audioContext.destination);
    } catch (err) {
      setIsStreaming(false);
      setError(err instanceof Error ? err.message : 'Failed to access microphone');
    }
  }

  /**
   * Stops microphone streaming and signals end of audio to the server.
   */
  function stopMicrophoneStreaming() {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }
    setIsStreaming(false);

    // Send end signal via WebSocket and close
    const ws = (window as any).__ambientWs as WebSocket | undefined;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'end' }));
      setTimeout(() => ws.close(), 1000);
    }
  }

  const handleAudioSourceChange = useCallback((source: AudioSource, file?: File) => {
    setAudioSource(source);
    if (file) setWavFile(file);
  }, []);

  const handleNewSession = useCallback(() => {
    reset();
    setSelectedPatient(null);
    setPatientContext(null);
    setHighlightedSegmentId(null);
    setIsStreaming(false);
  }, [reset]);

  const handlePatientSelect = useCallback((patient: Patient) => {
    setSelectedPatient(patient);
    setPatientContext(null);
    setHighlightedSegmentId(null);
  }, []);

  const handleContextReady = useCallback((context: string) => {
    setPatientContext(context);
  }, []);

  const handleContextError = useCallback(() => {
    setPatientContext(null);
  }, []);

  const handleEvidenceClick = useCallback((evidence: EvidenceMapping) => {
    if (evidence.sourceType === 'transcript' && evidence.transcriptReference) {
      // Find the segment that matches the time range
      const matchingSegment = state.transcriptSegments.find(
        (seg) =>
          seg.startTime >= (evidence.transcriptReference?.startTime ?? 0) &&
          seg.startTime <= (evidence.transcriptReference?.endTime ?? 0)
      );
      if (matchingSegment) {
        setHighlightedSegmentId(matchingSegment.id);
      }
    }
  }, [state.transcriptSegments]);

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex-shrink-0 border-b border-gray-200 bg-white px-6 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-gray-900">
              Ambient Clinical Documentation
            </h1>
            <p className="text-sm text-gray-500">
              Amazon Connect Health + OpenEMR Demo
            </p>
          </div>
          <div className="flex items-center gap-4">
            {(isSessionActive || isStreaming) && (
              <AudioIndicator isActive={true} source={audioSource} />
            )}
            <a
              href="/api/auth/logout"
              className="text-sm font-medium text-gray-500 hover:text-gray-900"
            >
              Sign out
            </a>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left Panel — Patient Selection */}
        <aside className="flex w-72 flex-shrink-0 flex-col border-r border-gray-200 bg-gray-50">
          <div className="flex-shrink-0 border-b border-gray-200 p-4">
            <h2 className="mb-3 text-sm font-semibold text-gray-700 uppercase tracking-wide">
              Patient
            </h2>
            <PatientSelector
              onSelect={handlePatientSelect}
              selectedPatientId={selectedPatient?.id}
            />
          </div>
        </aside>

        {/* Center Panel — Patient Context, Session Controls & Transcript */}
        <main className="flex flex-1 flex-col overflow-hidden">
          {/* Patient Context (top, larger, always scrollable) */}
          <div className="flex-shrink-0 border-b border-gray-200 bg-gray-50 p-4 h-64 overflow-y-scroll">
            <PatientContextPanel
              patientId={selectedPatient?.id ?? null}
              onContextReady={handleContextReady}
              onContextError={handleContextError}
            />
          </div>

          {/* Session Controls */}
          <div className="flex-shrink-0 border-b border-gray-200 p-4">
            <SessionControls
              patientId={selectedPatient?.id ?? null}
              patientContext={patientContext}
              onAudioSourceChange={handleAudioSourceChange}
            />
          </div>

          {/* Transcript View */}
          <div className="flex-1 overflow-y-auto bg-white">
            <TranscriptView
              segments={state.transcriptSegments}
              highlightedSegmentId={highlightedSegmentId}
            />
          </div>
        </main>

        {/* Right Panel — Clinical Note / After-Visit Summary (Tabbed) */}
        <aside className="flex w-96 flex-shrink-0 flex-col border-l border-gray-200 bg-white">
          {/* Tab Navigation */}
          <div className="flex-shrink-0 border-b border-gray-200" role="tablist" aria-label="Output panels">
            <div className="flex">
              <button
                role="tab"
                aria-selected={activeTab === 'clinical-note'}
                aria-controls="panel-clinical-note"
                id="tab-clinical-note"
                onClick={() => setActiveTab('clinical-note')}
                className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                  activeTab === 'clinical-note'
                    ? 'border-b-2 border-blue-600 text-blue-600'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                Clinical Note
              </button>
              <button
                role="tab"
                aria-selected={activeTab === 'after-visit-summary'}
                aria-controls="panel-after-visit-summary"
                id="tab-after-visit-summary"
                onClick={() => setActiveTab('after-visit-summary')}
                className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${
                  activeTab === 'after-visit-summary'
                    ? 'border-b-2 border-blue-600 text-blue-600'
                    : 'text-gray-500 hover:text-gray-700'
                }`}
              >
                After-Visit Summary
              </button>
            </div>
          </div>

          {/* Tab Panels */}
          <div className="flex-1 overflow-y-auto">
            <div
              id="panel-clinical-note"
              role="tabpanel"
              aria-labelledby="tab-clinical-note"
              hidden={activeTab !== 'clinical-note'}
              className="h-full"
            >
              <ClinicalNotePanel
                clinicalNote={state.clinicalNote}
                isLoading={session?.status === 'ending'}
                onEvidenceClick={handleEvidenceClick}
                patientId={selectedPatient?.id ?? null}
                patientName={selectedPatient?.name ?? null}
                sessionEnded={session?.status === 'ended'}
                onNewSession={handleNewSession}
              />
            </div>
            <div
              id="panel-after-visit-summary"
              role="tabpanel"
              aria-labelledby="tab-after-visit-summary"
              hidden={activeTab !== 'after-visit-summary'}
              className="h-full"
            >
              <AfterVisitSummaryPanel
                content={state.afterVisitSummary}
                isLoading={session?.status === 'ending'}
                error={undefined}
              />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

// ─── Page Component ──────────────────────────────────────────────────────────

export default function Home() {
  return (
    <SessionProvider>
      <ErrorBoundary>
        <AmbientDocumentationContent />
      </ErrorBoundary>
    </SessionProvider>
  );
}
