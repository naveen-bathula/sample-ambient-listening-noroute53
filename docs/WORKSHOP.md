# Workshop Guide — Ambient Clinical Documentation Demo

This guide walks through deploying and running the demo, and highlights the
workshop-specific steps: creating the Amazon Connect Health domain manually and
wiring it into the running application.

> **Disclaimer:** This sample is for demonstration and educational purposes only.
> It uses a **self-signed TLS certificate** and other demo-grade shortcuts. Do not
> use it for production or with real PHI without a full security review.

---

## 1. Architecture at a glance

Two CloudFormation stacks are deployed:

| Stack | What it is |
|-------|-----------|
| **OpenEmrStack** | OpenEMR on ECS Fargate + Aurora (the EHR + FHIR API). |
| **DemoAppStack** | The Next.js demo app on ECS Fargate, fronted by an Application Load Balancer (ALB). |

Request flow:

```
Browser → ALB (HTTPS, self-signed cert) → Next.js app (ECS)
                                              ├── Cognito hosted UI (login)
                                              ├── OpenEMR FHIR API (patient data, note write-back)
                                              └── Amazon Connect Health (ambient scribe → clinical note)
```

### Key design points for this deployment

- **No Route 53 / no custom domain.** The app is reached directly via the **ALB
  DNS name** with a **self-signed certificate**. Browsers show a certificate
  warning — click **Advanced → Proceed** to continue.
- **Authentication runs in the application, not on the ALB.** The Next.js app
  performs the Cognito OAuth 2.0 authorization-code flow itself (login, callback,
  logout, and route protection via middleware). This is required because the ALB's
  built-in Cognito action needs a shared parent domain / real certificate to carry
  its session cookie across the ALB↔Cognito redirect, which a raw ALB DNS name with
  a self-signed cert cannot provide.
- **The app talks to OpenEMR over the self-signed ALB cert.** Server-side calls set
  `OPENEMR_ALLOW_SELF_SIGNED_TLS=true` and use an undici dispatcher so TLS 1.2+ is
  still enforced while accepting the self-signed certificate.
- **The Amazon Connect Health domain is NOT auto-created.** You create it manually
  and point the app at it (see section 4). If the app is started without a valid
  domain, session creation fails with a clear `DOMAIN_NOT_FOUND` message.

---

## 2. Prerequisites

- AWS account and credentials configured (`aws sts get-caller-identity` works).
- Region **us-east-1** or **us-west-2** (Amazon Connect Health supported regions).
- Node.js 20+, npm 10+, Python 3.9+, AWS CDK CLI 2.150+.
- Docker (for building the container image).
- `openssl` (for generating the self-signed certificate).

Clone with submodules and install:

```bash
git clone --recurse-submodules <repo-url>
cd sample-ambient-listening-demo
npm install
```

---

## 3. Deploy

The deploy script provisions everything: a self-signed certificate (imported to
ACM), the OpenEMR stack, the demo app stack, and synthetic patient data.

```bash
./deploy.sh --connect-health-domain <name> [--region us-east-1] [--skip-openemr] [--skip-data-load]
```

- `--connect-health-domain <name>` — the name the app will look for. **The domain
  itself does not need to exist yet** (see section 4); this just tells the app which
  domain name to use.
- `--region` — defaults to `us-east-1`.
- `--skip-openemr` — skip the OpenEMR stack if it is already deployed.
- `--skip-data-load` — skip loading synthetic patients.

When it finishes, the script prints the app URL, for example:

```
Demo App URL:  https://DemoAp-DemoA-xxxxxxxx-1234567890.us-east-1.elb.amazonaws.com
OpenEMR URL:   https://Openem-LoadB-xxxxxxxx-1234567890.us-east-1.elb.amazonaws.com
```

You can always retrieve the app URL later:

```bash
aws cloudformation describe-stacks --stack-name DemoAppStack \
  --query 'Stacks[0].Outputs[?OutputKey==`ApplicationUrl`].OutputValue' --output text
```

---

## 4. Create the Amazon Connect Health domain (workshop step)

The application **intentionally does not create** the Connect Health domain. This
lets you demonstrate the setup step and control which domain is used.

### 4a. Create the domain

Create it in the AWS console (Amazon Connect Health → Domains → Create), or via CLI:

```bash
aws connecthealth create-domain --name "my-workshop-domain" --region us-east-1
```

Note the domain **name** you chose (the app matches on name, not ID).

### 4b. Point the app at the domain

The app reads the domain name from the `CONNECT_HEALTH_DOMAIN_NAME` environment
variable on the Demo App ECS task. Update it using **one** of the following.

**Option A — Redeploy via CDK (persistent, recommended).**
Re-run the deploy with the new name; the task definition is updated and a new task
rolls out:

```bash
./deploy.sh --connect-health-domain "my-workshop-domain" --skip-openemr --skip-data-load
```

**Option B — Update the ECS task directly (fast, good for a live demo).**
Register a new task-definition revision with the updated value and roll the
service. Note: a later `cdk deploy` / `./deploy.sh` will overwrite this back to the
value passed on the command line.

```bash
REGION=us-east-1
CLUSTER=$(aws ecs list-clusters --region $REGION \
  --query 'clusterArns[?contains(@,`DemoApp`)]' --output text | awk -F/ '{print $NF}')
SERVICE=$(aws ecs list-services --cluster "$CLUSTER" --region $REGION \
  --query 'serviceArns[0]' --output text | awk -F/ '{print $NF}')
TASKDEF=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --region $REGION \
  --query 'services[0].taskDefinition' --output text)

# Export the current task def, change CONNECT_HEALTH_DOMAIN_NAME, register a new revision.
aws ecs describe-task-definition --task-definition "$TASKDEF" --region $REGION \
  --query 'taskDefinition' --output json > /tmp/taskdef.json

# Edit /tmp/taskdef.json: set the CONNECT_HEALTH_DOMAIN_NAME env value to your domain
# name, and remove read-only fields (taskDefinitionArn, revision, status,
# requiresAttributes, compatibilities, registeredAt, registeredBy).

NEW_TASKDEF_ARN=$(aws ecs register-task-definition --region $REGION \
  --cli-input-json file:///tmp/taskdef.json \
  --query 'taskDefinition.taskDefinitionArn' --output text)

aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" \
  --task-definition "$NEW_TASKDEF_ARN" --region $REGION >/dev/null
```

### 4c. Verify

Log in to the app and start a session for a patient. If the domain name does not
match an existing domain, the app returns a clear error instead of creating one:

```json
{ "code": "DOMAIN_NOT_FOUND",
  "message": "Amazon Connect Health domain \"...\" was not found ...
              Create the domain manually ... and set the CONNECT_HEALTH_DOMAIN_NAME
              environment variable on the Demo App ECS task to its name." }
```

---

## 5. Log in and run the demo

1. Open the **Demo App URL** in a browser.
2. Accept the self-signed certificate warning (**Advanced → Proceed**).
3. You are redirected to the Cognito hosted UI. Sign in with the demo clinician:
   - Username: `clinician@demo.local`
   - Password: stored in Secrets Manager. Retrieve it with:
     ```bash
     aws secretsmanager get-secret-value \
       --secret-id DemoAppStack/clinician-credentials \
       --query SecretString --output text
     ```
4. Select a patient (e.g. **Margaret Smith**).
5. Start a session — use the microphone, or upload the sample encounter audio at
   `demo-example-files/margaret_smith_encounter.wav`.
6. Watch the live transcript, then end the session. After a short delay the
   **clinical note** and **after-visit summary** populate on the right.
7. Review/edit the note and submit it to the EHR (write-back to OpenEMR).

> "No clinical note available" is the normal empty state **before** you run a
> session. It only populates after a session completes and Connect Health returns
> the generated note.

### OpenEMR console (optional)

To browse the EHR directly, open the **OpenEMR URL** (self-signed cert warning
applies) and log in:

```bash
aws secretsmanager get-secret-value \
  --secret-id DemoAppStack/openemr-admin-credentials \
  --query SecretString --output text
```

---

## 6. Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| Browser cert warning | Expected — the ALB uses a self-signed certificate. Click **Advanced → Proceed**. |
| Login loops or fails | Start from the **app root URL** (not a saved Cognito URL). Authentication is handled by the app, so the app root triggers the correct flow. |
| "Error loading patients" | The app could not reach the OpenEMR FHIR API. Confirm `OPENEMR_ALLOW_SELF_SIGNED_TLS=true` is set on the task and that OpenEMR is healthy. Check ECS logs at `/ecs/DemoAppStack/demo-app`. |
| Session start → `DOMAIN_NOT_FOUND` | No Connect Health domain matches `CONNECT_HEALTH_DOMAIN_NAME`. Create the domain (section 4) and update the env var. |
| "No clinical note available" after a session | Verify the Connect Health domain is `ACTIVE` and the region supports Connect Health. Check ECS logs for session/transcript errors. |

View application logs:

```bash
aws logs tail /ecs/DemoAppStack/demo-app --follow --region us-east-1
```

---

## 7. Tear down

```bash
./destroy.sh --region us-east-1
```

Also delete any Connect Health domain you created manually (deactivate its
subscriptions first):

```bash
DID=<domain-id>
for SUB in $(aws connecthealth list-subscriptions --domain-id "$DID" \
    --query 'subscriptions[].subscriptionId' --output text); do
  aws connecthealth deactivate-subscription --domain-id "$DID" --subscription-id "$SUB"
done
aws connecthealth delete-domain --domain-id "$DID"
```
