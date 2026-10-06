---
title: "4.5. Create Your Connect Health Domain"
weight: 45
---

# Create Your Amazon Connect Health Domain

The environment is deployed and the EHR is working, but one piece is
intentionally left for you to create: the **Amazon Connect Health domain**. This
is the resource that performs the ambient transcription and clinical-note
generation.

The application does **not** create the domain automatically. Instead it looks
for a domain **by name** every time you start a session. The deployment was
configured to use the name **`ambient-workshop`**, so you will create a domain
with exactly that name.

{{% notice warning %}}
The domain name must be **exactly `ambient-workshop`** (all lowercase). The app
matches the domain by name, so a different name — or a typo — means the app will
not find it and session creation fails with a `DOMAIN_NOT_FOUND` error.
{{% /notice %}}

## Why this is a manual step

In a real deployment, provisioning a Connect Health domain is a deliberate
administrative action — it enables a HIPAA-eligible service and starts the
associated subscription. Doing it by hand here mirrors that real-world setup and
lets you see exactly what the application depends on.

## Create the domain

Use **either** the console or the CLI.

### Option A — AWS Console

1. In the AWS console, go to **Amazon Connect Health**.
2. Confirm your region is **the same region your environment was deployed to**
   (`us-east-1` or `us-west-2`).
3. Choose **Domains → Create domain**.
4. For the domain **name**, enter exactly:
   ```
   ambient-workshop
   ```
5. Create the domain and wait until its status is **Active**.

### Option B — AWS CLI

Run this in a terminal with credentials for your workshop account (set
`--region` to match your deployment):

```bash
aws health-agent create-domain --name ambient-workshop --region us-east-1
```

Confirm it was created:

```bash
aws health-agent list-domains --region us-east-1
```

You should see a domain named `ambient-workshop` in the list.

{{% notice info %}}
**IAM note:** the Amazon Connect Health IAM actions use the service prefix
**`health-agent`** (for example `health-agent:CreateDomain`), even though the
service is called Amazon Connect Health. In a Workshop Studio provided account,
your participant role already has these permissions.
{{% /notice %}}

## No redeployment needed

Because the application looks the domain up **by name at runtime**, you do **not**
need to restart or redeploy anything. As soon as the `ambient-workshop` domain is
**Active**, the running app will find it the next time you start a session.

## Verify

You will confirm this works in the next module when you start a session. If you
want to sanity-check now, you can re-run the `list-domains` command above and
confirm the domain shows an **Active** status.

Continue to **Run Ambient Documentation**.
