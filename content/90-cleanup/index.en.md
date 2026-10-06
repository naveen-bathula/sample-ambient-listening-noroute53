---
title: "7. Clean Up"
weight: 90
---

# Clean Up

How you clean up depends on your account path, but **everyone** should delete the
Amazon Connect Health domain they created.

- **Path A — Workshop Studio provided account:** when the event ends, Workshop
  Studio reclaims the account and all its resources automatically. You do not
  need to run the destroy script. Still, if you created the Connect Health domain
  and your event runs long, delete it (below) to avoid any domain-related cost.
- **Path B — Bring your own account:** you must tear everything down yourself —
  both the deployed stacks (destroy script) **and** the Connect Health domain.

{{% notice warning %}}
In your own account, skipping cleanup leaves ECS Fargate, Aurora, ElastiCache,
and load balancers running, which continue to bill at roughly **$0.50–0.65 per
hour**. Always run cleanup when you finish.
{{% /notice %}}

## Delete the Connect Health domain (both paths)

The `ambient-workshop` domain is not part of the CloudFormation stacks, so the
destroy script does not remove it. Delete it explicitly. Subscriptions must be
deactivated first.

```bash
REGION=us-east-1   # match your deployment region

# Find the domain ID
DID=$(aws health-agent list-domains --region "$REGION" \
  --query "domains[?name=='ambient-workshop'].domainId" --output text)

# Deactivate any subscriptions under it
for SUB in $(aws health-agent list-subscriptions --domain-id "$DID" --region "$REGION" \
    --query 'subscriptions[].subscriptionId' --output text); do
  aws health-agent deactivate-subscription --domain-id "$DID" --subscription-id "$SUB" --region "$REGION"
done

# Delete the domain
aws health-agent delete-domain --domain-id "$DID" --region "$REGION"
```

You can also delete the domain from the **Amazon Connect Health** console under
**Domains**.

## Run the destroy script (Path B only)

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
