# Ambient Clinical Documentation Demo

> **Disclaimer**: This sample is provided for demonstration and educational purposes only and is not intended for production use without additional security review and testing. The code has not undergone a formal AppSec review. Before deploying in a production environment, conduct a thorough security assessment, enable all recommended guardrails, and ensure compliance with your organization's security requirements.

A full-stack web application demonstrating end-to-end ambient clinical documentation using [Amazon Connect Health](https://aws.amazon.com/connect/health/) integrated with [OpenEMR](https://www.open-emr.org/) on AWS ECS.

Workshop participants experience the complete workflow: retrieving patient data from an EHR, streaming a clinical conversation via HTTP/2 to Amazon Connect Health, viewing real-time transcription with speaker diarization, and reviewing structured SOAP clinical notes with evidence mapping — all written back to the patient record.

## Architecture Overview

The system is composed of three deployment units:

| Component | Technology | Purpose |
|-----------|-----------|---------|
| **OpenEMR Infrastructure Stack** | Python CDK (Git submodule) | Deploys OpenEMR on ECS Fargate with Aurora Serverless v2, ElastiCache, and EFS |
| **Demo Application** | Next.js 14 / Node.js on ECS Fargate | Backend API routes, HTTP/2 streaming to Connect Health, FHIR API interactions |
| **Frontend UI** | React 18 / Tailwind CSS | Clinician-facing interface for patient selection, audio capture, transcript, and note review |

**Data flow**: Browser → ALB (HTTPS) → Backend → OpenEMR FHIR API (patient context) + Amazon Connect Health (HTTP/2 audio streaming) → S3 (clinical note output) → FHIR write-back

See the [Design Document](.kiro/specs/ambient-clinical-documentation-demo/design.md) for the full architecture diagram (Mermaid) and detailed component descriptions.

## Quick Start

```bash
# Clone with submodules
git clone --recurse-submodules https://github.com/<org>/amazon-connect-health-ambient.git
cd amazon-connect-health-ambient
npm install  # All dependencies use exact version pins in package.json

# Deploy to AWS (uses the ALB DNS name with a self-signed certificate — no Route53 required)
./deploy.sh --connect-health-domain <name>

# Tear down when done
./destroy.sh --region us-east-1
```

> **Note:** This deployment is reached via the **ALB DNS name with a self-signed
> certificate** (no Route 53 / custom domain). Authentication is handled inside the
> application (Cognito OIDC), and the Amazon Connect Health domain is created
> manually. See the **[Workshop Guide](docs/WORKSHOP.md)** for the full flow.

For step-by-step manual deployment, see the **[Workshop Guide](docs/WORKSHOP.md)**.

## Git Submodules

### OpenEMR on ECS (`submodules/openemr/`)

| Property | Value |
|----------|-------|
| Repository | [aws-samples/host-openemr-on-aws-fargate](https://github.com/aws-samples/host-openemr-on-aws-fargate) |
| Pinned Tag | **v4.1.1** |
| Technology | Python CDK |
| Purpose | Deploys OpenEMR on ECS Fargate with Aurora Serverless v2, ElastiCache, EFS, and ALB |

### Synthea (`submodules/synthea/`)

| Property | Value |
|----------|-------|
| Repository | [synthetichealth/synthea](https://github.com/synthetichealth/synthea) |
| Technology | Java |
| Purpose | Generates realistic synthetic patient data (FHIR R4 bundles) for the demo |

```bash
# If already cloned without submodules
git submodule update --init --recursive
```

## Technology Stack

| Layer | Technologies |
|-------|-------------|
| Frontend | React 18, Next.js 14 (App Router), Tailwind CSS, Web Audio API |
| Backend | Node.js 20 LTS, Next.js API Routes, WebSocket (`ws`) |
| AWS Services | Amazon Connect Health, ECS Fargate, ALB, S3, Secrets Manager, Aurora Serverless v2, ElastiCache, EFS, WAF, KMS |
| Infrastructure | AWS CDK (TypeScript for demo app, Python for OpenEMR), cdk-nag (HIPAA Security) |
| Testing | Jest, fast-check (property-based testing), MSW, Testing Library |
| Data | OpenEMR FHIR R4 API, OpenEMR Standard API (write-back), built-in synthetic patient generator |

## Prerequisites

- Node.js 20 LTS
- **Java 17+** (required for Synthea synthetic patient data generation)
- Python 3.9+ (for OpenEMR CDK stack)
- AWS CDK CLI 2.150+ (`npm install -g aws-cdk@2.150.0`)
- AWS CLI 2.15+ configured with appropriate credentials
- Docker (for CDK asset bundling)
- `openssl` (for self-signed certificate generation)
- AWS account with **us-east-1** or **us-west-2** region access
- **No Route 53 / custom domain required** — the app is served from the ALB DNS name with a self-signed certificate (browsers show a certificate warning; click **Advanced → Proceed**)
- **Amazon Connect Health environment** — You must have Amazon Connect Health enabled in your AWS account before deployment. Contact your AWS account team or request access through the AWS console. The service must be available in your target region (us-east-1 or us-west-2). The demo does **not** auto-create the Connect Health domain; you create it manually and point the app at it (see the [Workshop Guide](docs/WORKSHOP.md)).

## Deploy

Deploy the entire demo with a single command. No Route 53 hosted zone or custom
domain is required — the app is served from the ALB DNS name with a self-signed
certificate.

```bash
./deploy.sh --connect-health-domain <name>
```

The script will:
1. Validate prerequisites (tools, credentials, Docker, openssl)
2. Generate a self-signed certificate and import it to ACM
3. Deploy the OpenEMR stack (~35 min)
4. Deploy the Demo App stack (~15 min)
5. Configure database access between stacks
6. Load synthetic patients with clinical notes (including the Margaret Smith demo patient)
7. Register and enable the OAuth2 API client for EHR write-back

Options:
- `--region REGION` — Deploy to us-west-2 instead of us-east-1
- `--skip-openemr` — Skip OpenEMR if already deployed
- `--skip-data-load` — Skip synthetic data loading

After deploying, create the Amazon Connect Health domain and point the app at it —
see the **[Workshop Guide](docs/WORKSHOP.md)** (section 4). Log in with the demo
clinician credentials stored in Secrets Manager (`DemoAppStack/clinician-credentials`).

## Destroy

Remove all resources and stop incurring costs:

```bash
./destroy.sh --region us-east-1
```

This destroys both CDK stacks. Also delete any Amazon Connect Health domain you
created manually (see the [Workshop Guide](docs/WORKSHOP.md), section 7).

## Security & Compliance

This demo follows HIPAA security best practices:

- **Network isolation**: All compute runs in private subnets; no 0.0.0.0/0 inbound rules
- **Encryption in transit**: TLS 1.2+ on all connections (HTTPS, HTTP/2, internal)
- **Encryption at rest**: KMS encryption on S3, Aurora, EFS, and ElastiCache
- **Secrets management**: All credentials stored in AWS Secrets Manager (never in env vars or source)
- **Least privilege IAM**: No wildcard resource permissions
- **Compliance validation**: cdk-nag with HIPAA Security rule pack — deployment fails on unresolved findings
- **S3 hardening**: Block all public access, SSL-only bucket policy, SSE-KMS

> **Important**: This demo uses **synthetic patient data only** (Synthea-generated). A Business Associate Agreement (BAA) with AWS is required for production use with real PHI.

## Responsible AI

This application uses AI services to generate clinical documentation:

- **Amazon Connect Health Ambient Listening** — a fully managed AWS service that transcribes clinical conversations and generates structured SOAP notes. Safety and content controls are built into the service and managed by AWS. No separate guardrails configuration is required or supported for this service.
- **Amazon Bedrock (Nova Lite)** — used for clinical note summarization. Bedrock Guardrails are configured via environment variables (`BEDROCK_GUARDRAIL_ID`, `BEDROCK_GUARDRAIL_VERSION`) for content filtering and output validation.

The following principles apply:

- **Human-in-the-loop**: All AI-generated clinical notes require clinician review and approval before being written to the patient record. The UI provides an editable interface and confirmation dialog to enforce this workflow. Clinicians must verify all AI-generated content against the original transcript and patient context.
- **Assistive, not deterministic**: AI-generated SOAP notes, transcriptions, and summaries are assistive tools. The clinician maintains full clinical responsibility for all documentation and patient care decisions.
- **No autonomous medical decisions**: AI outputs from this system should not be used as the sole basis for medical diagnoses, treatment plans, or clinical decisions.
- **Content filtering**: Amazon Bedrock Guardrails are enabled for clinical note summarization (see `BEDROCK_GUARDRAIL_ID` env var). Amazon Connect Health Ambient Listening includes built-in content safety managed by AWS.
- **Output validation**: AI-generated clinical summaries are validated for non-empty content before display. The clinician review step serves as the final validation gate — summaries that are incomplete or inaccurate should be edited or regenerated.
- **Bias and fairness**: Clinical AI systems may reflect biases present in training data. Regularly evaluate outputs for fairness across patient demographics and clinical contexts.
- **Transparency**: Patients and clinicians should be informed when AI-assisted documentation is in use. AI-generated content is clearly labeled in the UI.
- **Data privacy**: Patient context sent to AI services is limited to what is clinically necessary. All data handling follows HIPAA requirements with encryption in transit and at rest.

## License

This project is licensed under the MIT-0 License. See the [LICENSE](LICENSE) file for details.
