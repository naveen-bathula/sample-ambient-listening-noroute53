---
title: "3. Access Your Environment"
weight: 30
---

# Access Your Environment

How you get a running environment depends on which path you are on (from the
previous module). Pick your path below.

- **Path A — Workshop Studio provided account:** the environment is deployed
  **for you** automatically when your account is provisioned. You do not run any
  deployment. Skip to [Path A](#path-a--workshop-studio-provided-account).
- **Path B — Bring your own account:** you run the deployment yourself with a
  single script. Go to [Path B](#path-b--bring-your-own-account).

---

## Path A — Workshop Studio provided account

When Workshop Studio provisioned your account, it launched a bootstrap process
(an AWS CodeBuild project) that deploys the entire environment — OpenEMR, the
demo application, and 100 synthetic patients — inside your account. This runs
**before you start** and takes roughly 45–60 minutes end to end.

By the time you reach this point, it is usually already finished. Confirm it is
complete before moving on.

### Confirm the environment is ready

1. In the AWS console, open **CodeBuild → Build projects**.
2. Open the project named like **`<stack>-ambient-deploy`** and check its latest
   build shows **Succeeded**.
3. Then open **CloudFormation → Stacks** and confirm you see both
   **`OpenemrEcsStack`** and **`DemoAppStack`** in `CREATE_COMPLETE`.

### Get your application URLs

Once both stacks are complete, grab the two URLs you will use:

```bash
# Demo App URL
aws cloudformation describe-stacks --stack-name DemoAppStack \
  --query 'Stacks[0].Outputs[?OutputKey==`ApplicationUrl`].OutputValue' --output text

# OpenEMR URL
aws cloudformation describe-stacks --stack-name DemoAppStack \
  --query 'Stacks[0].Outputs[?OutputKey==`OpenEmrWebConsoleUrl`].OutputValue' --output text
```

{{% notice info %}}
If the CodeBuild build is still running, wait for it to finish. You can watch its
progress in the CodeBuild console (the build log streams each deployment step).
If the build **failed**, tell your facilitator — they can restart it.
{{% /notice %}}

{{% notice note %}}
**Your Connect Health domain name is already decided.** The environment was
deployed expecting a domain named **`ambient-workshop`**. You will create a
domain with that exact name in a later module, and the app will pick it up
automatically — no redeployment required.
{{% /notice %}}

Once you have both URLs, skip ahead to **Explore the EHR**.

---

## Path B — Bring your own account

You will deploy the environment yourself. This is one command, but it takes
about 45–60 minutes (most of it unattended).

{{% notice warning %}}
Run this from a terminal where **`docker info` succeeds** and
`aws sts get-caller-identity` returns your intended account, in `us-east-1` or
`us-west-2`. The deploy builds container images, so Docker is required (AWS
CloudShell will not work — it has no Docker daemon).
{{% /notice %}}

From the root of the workshop repository you cloned in the Prerequisites module:

```bash
./deploy.sh --connect-health-domain ambient-workshop
```

Use the domain name **`ambient-workshop`** so it matches the rest of this
workshop. To deploy in us-west-2 instead of the default us-east-1:

```bash
./deploy.sh --connect-health-domain ambient-workshop --region us-west-2
```

### What the script does

You do not run these steps yourself — the script handles them — but this is what
happens while you wait:

1. **Preflight checks** – verifies tools, credentials, region, and bootstraps
   CDK if needed.
2. **Certificate** – creates a self-signed certificate and imports it to ACM.
3. **OpenEMR stack (~35 min)** – OpenEMR on ECS Fargate with Aurora Serverless
   v2, ElastiCache, and EFS.
4. **Demo App stack (~15 min)** – the Next.js app in the same VPC.
5. **Networking** – wires security groups so the app can reach the OpenEMR
   database and FHIR API.
6. **Synthetic data** – generates 100 patients with Synthea (including
   **Margaret Smith**) and loads them into OpenEMR.
7. **API access** – registers the OAuth2 client for write-back and restarts the
   app.

### When deployment finishes

The script prints a summary with the **Demo App URL** and **OpenEMR URL**. Copy
both — you will use them in the next modules.

{{% notice warning %}}
Because the certificate is **self-signed**, your browser shows a security
warning the first time you open each URL. Click **Advanced → Proceed** (wording
varies by browser).
{{% /notice %}}

### Troubleshooting (Path B)

- **"CDK bundling fails" / "Cannot connect to the Docker daemon"** – start Docker
  and confirm with `docker info`, then re-run.
- **"Unable to locate credentials" / AccessDenied** – confirm
  `aws sts get-caller-identity` returns the intended account with sufficient
  permissions.
- **"Region must be us-east-1 or us-west-2"** – Connect Health only runs in these
  regions.
- **Java not found during data load** – Synthea needs Java 17+. Install it and
  re-run with `./deploy.sh --connect-health-domain ambient-workshop --skip-openemr`.

---

Once you have both URLs (either path), continue to **Explore the EHR**.
