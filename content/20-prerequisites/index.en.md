---
title: "2. Prerequisites & Setup"
weight: 20
---

# Prerequisites & Setup

This workshop can be run two ways. Your path determines what you need to set up.

## Choose your path

| Path | Who it is for | How the environment is deployed |
|------|---------------|---------------------------------|
| **A — Workshop Studio provided account** | Attendees at an instructor-led event using accounts handed out by Workshop Studio. | **Automatically, for you.** When your account is provisioned, a bootstrap process deploys the whole environment. You do not run any deployment or install any tools. |
| **B — Bring your own account** | Self-paced learners, or events where you use your own AWS account. | **You run it yourself** with a single script, so you need a few local tools. |

The hands-on part of the workshop (explore the EHR → create a Connect Health
domain → run ambient documentation → review the note) is **identical** for both
paths. Only how you get a running environment differs.

---

## Path A — Workshop Studio provided account

There is almost nothing to set up — the environment deploys itself.

1. Open the event's **Get started** page and choose **Open AWS Console**. This
   signs you in to the temporary account provisioned for you.
2. Note the **region** your facilitator specifies (`us-east-1` or `us-west-2`).
   Everything in this workshop happens in that one region.
3. That is it. The deployment runs in the background (an AWS CodeBuild project
   that stands up OpenEMR, the demo app, and synthetic data). You will confirm it
   has finished in the next module.

{{% notice info %}}
You do **not** need Docker, the AWS CDK, Node, Java, or a local clone of the
repository on Path A. Those are only needed to *run* the deployment, which
Workshop Studio does for you. A browser and the AWS console are enough.
{{% /notice %}}

{{% notice warning %}}
The provisioned account is **temporary** and is reclaimed when the event ends.
Do not store anything you want to keep.
{{% /notice %}}

Skip ahead to the **AWS credentials** check below, then go to
**Access Your Environment**.

---

## Path B — Bring your own account

You will run the deployment yourself, so you need an account, credentials, and a
few tools.

### Account and region

- An AWS account where you have permission to create ECS, VPC, RDS/Aurora,
  ElastiCache, EFS, S3, ACM, Lambda, Cognito, IAM, Secrets Manager, and KMS
  resources (effectively administrator-level for this deployment).
- Credentials configured locally so that `aws sts get-caller-identity` works.
- A region of **us-east-1** or **us-west-2** — Amazon Connect Health is only
  available in these two regions, and the deploy script enforces this.

{{% notice info %}}
Running in your own account incurs AWS charges (roughly **$0.50–0.65/hour**
while the environment is live). Complete the **Clean Up** module when you finish.
{{% /notice %}}

### Required tools (Path B only)

Confirm each of these is installed. Run the version check next to each one.

| Tool | Minimum version | Check |
|------|-----------------|-------|
| AWS CLI | 2.15+ | `aws --version` |
| Node.js | 20 LTS | `node --version` |
| npm | 10+ | `npm --version` |
| Python | 3.9+ | `python3 --version` |
| AWS CDK CLI | 2.150+ | `cdk --version` |
| Java | 17+ | `java -version` |
| Docker | running | `docker info` |
| openssl | any | `openssl version` |

If the CDK CLI is missing, install the pinned version:

```bash
npm install -g aws-cdk@2.150.0
```

{{% notice warning %}}
**Docker must be running at deploy time, and AWS CloudShell does not provide a
Docker daemon.** Run the deployment from a machine where `docker info` succeeds —
your laptop, an EC2 instance, or an AWS Cloud9 environment with Docker. **Java**
is required because the workshop generates synthetic patients with Synthea.
{{% /notice %}}

### Get the workshop code (Path B only)

Clone the repository **with submodules** (it pulls in OpenEMR and Synthea):

```bash
git clone --recurse-submodules \
  https://github.com/aws-samples/sample-ambient-listening-demo.git ambient-workshop
cd ambient-workshop
npm install
```

If you already cloned without submodules, initialize them now:

```bash
git submodule update --init --recursive
```

---

## Verify your AWS credentials (both paths)

Confirm your CLI can reach your account:

```bash
aws sts get-caller-identity
```

You should see your account ID, user/role ARN, and user ID returned as JSON.

When this passes, continue to **Access Your Environment**.
