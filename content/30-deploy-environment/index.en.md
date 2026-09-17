---
title: "3. Deploy the Environment"
weight: 30
---

# Deploy the Environment

In this module you will deploy the entire environment with a single command. The
deploy script provisions OpenEMR, the demo application, wires them together, and
loads synthetic patients.

{{% notice info %}}
**This step takes about 45–60 minutes**, most of which is unattended. Start it,
then read ahead while it runs. OpenEMR alone takes roughly 35 minutes to deploy.
{{% /notice %}}

## Run the deployment

From the root of the workshop repository, run:

```bash
./deploy.sh --connect-health-domain <your-connect-health-domain>
```

Replace `<your-connect-health-domain>` with the Amazon Connect Health domain name
for your account (created in the Prerequisites module, or provided by your
facilitator).

To deploy in **us-west-2** instead of the default us-east-1:

```bash
./deploy.sh --connect-health-domain <your-connect-health-domain> --region us-west-2
```

## What the script does

You do not need to run these steps yourself — the script handles them — but this
is what is happening while you wait:

1. **Preflight checks** – verifies your tools, AWS credentials, region, and
   Connect Health domain, and bootstraps CDK if needed.
2. **Certificate** – creates a self-signed certificate and imports it to ACM so
   the load balancers can serve HTTPS.
3. **OpenEMR stack (~35 min)** – deploys OpenEMR on ECS Fargate with Aurora
   Serverless v2, ElastiCache, and EFS.
4. **Demo App stack (~15 min)** – deploys the Next.js application into the same
   VPC and connects it to Connect Health.
5. **Networking** – wires up security groups so the app can reach the OpenEMR
   database and FHIR API.
6. **Synthetic data** – generates 100 patients with Synthea (including the demo
   patient **Margaret Smith**) and loads them into OpenEMR.
7. **API access** – registers the OAuth2 client used for write-back and restarts
   the app so it picks up the credentials.

## When deployment finishes

The script prints a summary that looks like this:

```
  Demo App URL:     https://<demo-alb>.elb.amazonaws.com
  OpenEMR URL:      https://<openemr-alb>.elb.amazonaws.com
  Region:           us-east-1
  Account:          <your-account-id>
  Certificate:      <arn> (self-signed)
```

**Copy both URLs** — you will use the **Demo App URL** for the hands-on modules
and the **OpenEMR URL** to inspect the chart.

{{% notice warning %}}
Because the certificate is **self-signed**, your browser will show a security
warning the first time you open each URL. This is expected in the workshop.
Click **Advanced → Proceed** (wording varies by browser) to continue.
{{% /notice %}}

## Troubleshooting

- **"Connect Health domain is required"** – you did not pass
  `--connect-health-domain`. Re-run with the flag and the domain name.
- **"Region must be us-east-1 or us-west-2"** – Connect Health is only available
  in these regions. Pick one.
- **CDK bundling fails** – make sure **Docker is running** before you start.
- **Java not found during data load** – Synthea needs Java 17+. Install it and
  re-run with `./deploy.sh --connect-health-domain <name> --skip-openemr`
  to resume without redeploying OpenEMR.

Once you have both URLs, continue to **Explore the EHR**.
