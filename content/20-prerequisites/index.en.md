---
title: "2. Prerequisites & Setup"
weight: 20
---

# Prerequisites & Setup

Before deploying, make sure your environment has everything the deployment
scripts need. If you are running in a **Workshop Studio provided account**, the
AWS account, credentials, and region are already set up for you — you only need
to confirm the tools below are available in your workshop terminal (Cloud9,
CloudShell, or your laptop).

## AWS account and region

- An AWS account with permission to create ECS, VPC, RDS/Aurora, S3, ACM, IAM,
  and Secrets Manager resources.
- Your region must be **us-east-1** or **us-west-2**. Amazon Connect Health is
  only available in these regions, and the deploy script enforces this.
- **Amazon Connect Health must be enabled** in the account and region, and you
  must have a Connect Health **domain name** ready. If you do not have one, create
  it in the AWS console before you deploy (you will pass its name to the deploy
  script).

{{% notice info %}}
In a Workshop Studio event, your facilitator will tell you whether Connect
Health is pre-enabled and provide the domain name to use. If so, skip the manual
creation step.
{{% /notice %}}

## Required tools

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

{{% notice note %}}
**Java** is required because the workshop generates synthetic patients with
Synthea, which runs on the JVM. **Docker** must be running because the CDK
bundles container assets during deployment.
{{% /notice %}}

## Verify your AWS credentials

Confirm your CLI can reach your account:

```bash
aws sts get-caller-identity
```

You should see your account ID, user/role ARN, and user ID returned as JSON.

## Get the workshop code

Clone the repository **with submodules** (it pulls in OpenEMR and Synthea):

```bash
git clone --recurse-submodules <workshop-repo-url> ambient-workshop
cd ambient-workshop
npm install
```

If you already cloned without submodules, initialize them now:

```bash
git submodule update --init --recursive
```

## Bootstrap CDK (first time only)

If this account and region have never been used with the AWS CDK, bootstrap it.
The deploy script does this automatically if needed, but you can run it ahead of
time:

```bash
cdk bootstrap
```

When every check above passes, continue to **Deploy the Environment**.
