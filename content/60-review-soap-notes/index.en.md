---
title: "6. Review the SOAP Note"
weight: 60
---

# Review the SOAP Note

The AI has produced a draft clinical note. Now you do the most important part of
the workflow: **review it as the clinician** before it becomes part of the
patient's record.

## Read the SOAP note

When the encounter finishes, the demo app displays a structured **SOAP note**:

- **S – Subjective** – what the patient reported (symptoms, history, concerns).
- **O – Objective** – measurable findings and observations.
- **A – Assessment** – the clinical assessment or impression.
- **P – Plan** – next steps, orders, and follow-up.

The note is clearly labeled as AI-generated. Many implementations also show
**evidence mapping** that links statements in the note back to the parts of the
transcript they came from — use this to verify the draft against what was
actually said.

## Verify and edit

Treat the draft as a starting point, not a final answer:

1. Read each SOAP section against the transcript from the previous module.
2. Check that the assessment and plan are consistent with the conversation.
3. **Edit** anything that is inaccurate, incomplete, or unclear directly in the
   editable note interface.

{{% notice warning %}}
This is the **human-in-the-loop** control. AI-generated clinical documentation
is assistive only. The clinician is responsible for confirming the note is
accurate before it is saved. Never approve a note you have not reviewed.
{{% /notice %}}

## Approve and write back

When you are satisfied with the note:

1. Choose **Approve** (you will be asked to confirm).
2. The app writes the finalized note back to Margaret Smith's record in OpenEMR,
   and stores the output in S3.

## Confirm the write-back

Return to OpenEMR to see the result:

1. Open the **OpenEMR URL** again (or switch to the tab you left open).
2. Go to **Margaret Smith's** chart.
3. Locate the **new encounter / clinical note** that was just written back.

Compare this to the "before" state you noted in the *Explore the EHR* module. The
note you reviewed and approved is now part of the patient record — produced from
a spoken conversation, not manual typing.

## You did it

You have run a complete ambient clinical documentation workflow:

- Pulled patient context from an EHR over FHIR.
- Streamed a clinical conversation to Amazon Connect Health.
- Watched real-time transcription with speaker diarization.
- Reviewed, edited, and approved an AI-generated SOAP note.
- Wrote the finalized note back to the patient record.

One step remains: tearing down the environment so you stop incurring cost.
Continue to **Clean Up**.
