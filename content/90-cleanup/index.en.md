---
title: "7. Clean Up"
weight: 90
---

# Clean Up

To stop incurring cost, tear down everything you deployed. This step is
important even in a Workshop Studio provided account, and essential if you
deployed in your own account.

{{% notice warning %}}
Skipping cleanup leaves ECS Fargate, Aurora, ElastiCache, and load balancers
running, which continue to bill at roughly **$0.50–0.65 per hour**. Always run
cleanup when you finish.
{{% /notice %}}

## Run the destroy script

From the root of the workshop repository, run:

```bash
./destroy.sh
```

If you deployed to us-west-2, match the region:

```bash
./destroy.sh --region us-west-2
```

## What the script removes

The destroy script tears everything down in the right order:

1. Removes the security-group rules that link the demo app to the OpenEMR
   database and load balancer (so nothing blocks deletion).
2. Empties the S3 buckets (a non-empty bucket would block stack deletion).
3. Destroys the **Demo App** and **OpenEMR** stacks in parallel.
4. Deletes the SSM parameters that bridged the two stacks.
5. Deletes the self-signed ACM certificate (only if it is no longer in use).

## Confirm cleanup succeeded

At the end, the script verifies both stacks are gone and prints:

```
  Destroy complete. All resources removed.
```

If it reports that a stack still exists, wait a few minutes and run
`./destroy.sh` again — CloudFormation deletion of Aurora and networking
resources can take time and occasionally needs a second pass.

## Verify in the console (optional)

For peace of mind, open **CloudFormation** in the AWS console for your region and
confirm that **DemoAppStack** and **OpenemrEcsStack** are no longer listed. You
can also check **ECS**, **RDS**, and **EC2 → Load Balancers** to confirm nothing
is still running.

## Wrap-up

Nice work. You deployed a full ambient clinical documentation stack, ran a
complete clinician workflow with Amazon Connect Health, reviewed and approved an
AI-generated SOAP note, wrote it back to an EHR, and cleaned everything up.

To go deeper, explore:

- The **demo application** source (`src/`) to see how audio is streamed to
  Connect Health and how the FHIR write-back works.
- The **CDK infrastructure** (`infrastructure/demo-app/`) to see how the app is
  provisioned with HIPAA-aligned guardrails (cdk-nag).
- The project **README** for the full architecture and security details.
