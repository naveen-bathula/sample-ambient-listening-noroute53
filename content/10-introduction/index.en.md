---
title: "1. Introduction"
weight: 10
---

# Introduction

## What is ambient clinical documentation?

Clinicians spend a large share of their day typing notes instead of talking to
patients. **Ambient clinical documentation** flips that around: a service
listens to the natural conversation between clinician and patient, transcribes
it, identifies who said what, and drafts a structured clinical note
automatically. The clinician reviews and approves the note rather than writing
it from scratch.

In this workshop, that capability is provided by **Amazon Connect Health Ambient
Listening**, a fully managed AWS service. You send it audio; it returns a live
transcript with speaker labels and a structured **SOAP note**
(Subjective, Objective, Assessment, Plan).

## The application you will run

The demo is a full-stack web application composed of three deployment units:

| Component | Technology | Role |
|-----------|-----------|------|
| **OpenEMR** | Python CDK on ECS Fargate | The EHR / source of patient records (FHIR R4 API) |
| **Demo application** | Next.js 14 / Node.js on ECS Fargate | Streams audio to Connect Health, serves the UI |
| **Frontend UI** | React 18 / Tailwind CSS | The clinician-facing screen you interact with |

## How data flows

When you run the demo, this is what happens end to end:

1. Your **browser** loads the demo app over HTTPS through an Application Load Balancer.
2. The app pulls the selected **patient's context** from the OpenEMR **FHIR API**.
3. Audio is streamed over **HTTP/2** to **Amazon Connect Health**.
4. Connect Health returns a **live transcript** with speaker diarization and,
   at the end, a structured **SOAP note**.
5. The note is stored in **Amazon S3** and, after your review, **written back**
   to the patient record in OpenEMR.

![Architecture](/static/images/architecture.png)

## Responsible AI in this workshop

This application generates clinical documentation with AI, so it follows a few
principles you will see enforced in the UI:

- **Human-in-the-loop.** Every AI-generated note requires clinician review and
  explicit approval before it is written to the record.
- **Assistive, not autonomous.** The transcript and SOAP note are drafts. The
  clinician stays fully responsible for the content.
- **Transparency.** AI-generated content is clearly labeled in the interface.
- **Content safety.** Connect Health includes built-in safety controls managed
  by AWS; the summarization step uses Amazon Bedrock Guardrails.

Keep these in mind as you work through the hands-on modules — the review step is
not a formality, it is the core of the workflow.

In the next module you will confirm your environment is ready to deploy.
