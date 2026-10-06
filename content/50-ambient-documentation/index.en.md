---
title: "5. Run Ambient Documentation"
weight: 50
---

# Run Ambient Documentation

This is the core of the workshop. You will act as the clinician: select a
patient, stream a clinical conversation to Amazon Connect Health, and watch a
real-time transcript build with speaker labels.

{{% notice info %}}
This module uses the **`ambient-workshop`** Connect Health domain you created in
the previous module. If you skipped that step, starting a session will fail with
`DOMAIN_NOT_FOUND` — go back and create the domain first.
{{% /notice %}}

## Open the demo application

1. Open the **Demo App URL** from the deployment summary in your browser.
2. Accept the self-signed certificate warning (**Advanced → Proceed**).
3. You should land on the clinician interface with a list of patients.

## Select your patient

1. From the patient list, select **Margaret Smith** — the same patient whose
   chart you viewed in OpenEMR.
2. Confirm the patient context loads: her demographics and relevant history are
   pulled live from the OpenEMR FHIR API.

Selecting the patient sets the clinical context that Connect Health uses when it
drafts the note.

## Start the encounter

You have two ways to provide the clinical conversation audio:

### Option A — Use the sample encounter (recommended)

The workshop includes a pre-recorded sample conversation for Margaret Smith:
`demo-example-files/margaret_smith_encounter.wav`. Use the app's **upload / play
sample** control to stream this recording. This gives everyone a consistent,
predictable result.

### Option B — Live microphone

If your environment allows microphone access, start a **live capture** and speak
a short mock clinician–patient conversation. Grant the browser microphone
permission when prompted.

{{% notice tip %}}
For a repeatable workshop result, use **Option A**. Use live microphone only if
you want to experiment after you have seen the standard flow.
{{% /notice %}}

## Watch the live transcript

Once audio is streaming, watch the interface:

- The **transcript** appears in near real time as audio flows to Connect Health
  over HTTP/2.
- Each line is labeled by **speaker** (speaker diarization) — you can see which
  turns belong to the clinician versus the patient.
- The transcript scrolls as the conversation progresses.

Let the full encounter play through to the end. When streaming completes,
Connect Health finalizes the transcript and generates the structured clinical
note.

## What just happened

Behind the scenes, your browser streamed audio through the load balancer to the
demo backend, which relayed it to Amazon Connect Health. Connect Health
transcribed the speech, separated the speakers, and produced a **SOAP note**
draft — all without anyone typing.

That draft is **not** final. In the next module you will review it, which is the
required human-in-the-loop step before anything reaches the patient record.

Continue to **Review the SOAP Note**.
