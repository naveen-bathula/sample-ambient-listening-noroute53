#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════════
# Ambient Clinical Documentation Demo — Destroy All Resources
# ═══════════════════════════════════════════════════════════════════════════════
#
# Usage:
#   ./destroy.sh [--region REGION]
#
# Destroys all deployed resources to stop incurring costs.
# Cleans up the self-signed ACM certificate created during deployment.
# ═══════════════════════════════════════════════════════════════════════════════

REGION="us-east-1"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

while [[ $# -gt 0 ]]; do
  case $1 in
    --region) REGION="$2"; shift 2 ;;
    -h|--help)
      echo "Usage: ./destroy.sh [--region REGION]"
      exit 0
      ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

log()  { echo -e "${BLUE}[destroy]${NC} $1"; }
ok()   { echo -e "${GREEN}  ✓${NC} $1"; }
warn() { echo -e "${YELLOW}  ⚠${NC} $1"; }
fail() { echo -e "${RED}  ✗${NC} $1"; }

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  Destroying Ambient Clinical Documentation Demo"
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ─── Destroy Demo App Stack ──────────────────────────────────────────────────

log "Destroying Demo App stack..."
cd "$SCRIPT_DIR/infrastructure/demo-app"
npm ci --quiet 2>/dev/null || true

# Remove DB security group ingress rules referencing the Demo App ECS SG
# (prevents cross-SG dependency from blocking deletion)
DEMO_ECS_SG=$(aws cloudformation describe-stack-resources \
  --stack-name DemoAppStack \
  --region "$REGION" \
  --query 'StackResources[?LogicalResourceId==`EcsSecurityGroup44008BF1`].PhysicalResourceId' \
  --output text 2>/dev/null) || true
DB_SG=$(aws rds describe-db-clusters --region "$REGION" \
  --query 'DBClusters[?contains(DBClusterIdentifier,`openemr`)].VpcSecurityGroups[0].VpcSecurityGroupId' \
  --output text 2>/dev/null) || true
if [[ -n "$DEMO_ECS_SG" && "$DEMO_ECS_SG" != "None" && -n "$DB_SG" && "$DB_SG" != "None" ]]; then
  aws ec2 revoke-security-group-ingress \
    --group-id "$DB_SG" --protocol tcp --port 3306 \
    --source-group "$DEMO_ECS_SG" --region "$REGION" 2>/dev/null || true
fi

# Remove OpenEMR ALB SG ingress rule referencing the Demo App ECS SG
OPENEMR_ALB_SG=$(aws elbv2 describe-load-balancers --region "$REGION" \
  --query "LoadBalancers[?contains(LoadBalancerName,'Openem')].SecurityGroups[0]" \
  --output text 2>/dev/null) || true
if [[ -n "$DEMO_ECS_SG" && "$DEMO_ECS_SG" != "None" && -n "$OPENEMR_ALB_SG" && "$OPENEMR_ALB_SG" != "None" ]]; then
  aws ec2 revoke-security-group-ingress \
    --group-id "$OPENEMR_ALB_SG" --protocol tcp --port 443 \
    --source-group "$DEMO_ECS_SG" --region "$REGION" 2>/dev/null || true
fi

# Empty all S3 buckets (blocks deletion if not empty — ALB writes logs during teardown)
ACCESS_LOGS_BUCKET=$(aws cloudformation describe-stack-resources \
  --stack-name DemoAppStack \
  --region "$REGION" \
  --query 'StackResources[?LogicalResourceId==`AccessLogsBucket83982689`].PhysicalResourceId' \
  --output text 2>/dev/null) || true
OUTPUT_BUCKET=$(aws cloudformation describe-stack-resources \
  --stack-name DemoAppStack \
  --region "$REGION" \
  --query 'StackResources[?LogicalResourceId==`OutputBucket7114EB27`].PhysicalResourceId' \
  --output text 2>/dev/null) || true
if [[ -n "$ACCESS_LOGS_BUCKET" && "$ACCESS_LOGS_BUCKET" != "None" ]]; then
  aws s3 rm "s3://$ACCESS_LOGS_BUCKET" --recursive --region "$REGION" --quiet 2>/dev/null || true
fi
if [[ -n "$OUTPUT_BUCKET" && "$OUTPUT_BUCKET" != "None" ]]; then
  aws s3 rm "s3://$OUTPUT_BUCKET" --recursive --region "$REGION" --quiet 2>/dev/null || true
fi

# ─── Destroy both stacks in parallel ─────────────────────────────────────────

log "Destroying both stacks in parallel..."

# Start Demo App CDK destroy in background
(
  cd "$SCRIPT_DIR/infrastructure/demo-app"
  cdk destroy --force --region "$REGION" \
    --context "allowedCidr=0.0.0.0/32" \
    --context "openemrStackName=OpenEmrStack" \
    --context "certificateArn=arn:aws:acm:us-east-1:000000000000:certificate/dummy" \
    >/dev/null 2>&1
  # If CDK destroy failed (S3 race — ALB writes logs during teardown), empty and retry
  if aws cloudformation describe-stacks --stack-name DemoAppStack --region "$REGION" --query 'Stacks[0].StackStatus' --output text 2>/dev/null | grep -q "FAILED"; then
    # Re-discover and empty all buckets in the stack
    for LID in AccessLogsBucket83982689 OutputBucket7114EB27; do
      BKT=$(aws cloudformation describe-stack-resources --stack-name DemoAppStack --region "$REGION" \
        --query "StackResources[?LogicalResourceId==\`$LID\`].PhysicalResourceId" --output text 2>/dev/null)
      if [[ -n "$BKT" && "$BKT" != "None" ]]; then
        aws s3 rm "s3://$BKT" --recursive --region "$REGION" --quiet 2>/dev/null || true
      fi
    done
    aws cloudformation delete-stack --stack-name DemoAppStack --region "$REGION" 2>/dev/null || true
    aws cloudformation wait stack-delete-complete --stack-name DemoAppStack --region "$REGION" 2>/dev/null || true
  fi
) &
DEMO_PID=$!

# Start OpenEMR CDK destroy in background
(
  cd "$SCRIPT_DIR/submodules/openemr"
  if [[ ! -d ".venv" ]]; then
    python3 -m venv .venv
  fi
  source .venv/bin/activate
  pip install -r requirements.txt --quiet 2>/dev/null || true
  cdk destroy --force \
    --context "certificate_arn=arn:aws:acm:us-east-1:000000000000:certificate/dummy-for-destroy" \
    --context "security_group_ip_range_ipv4=127.0.0.1/32" \
    --context "activate_openemr_apis=true" \
    --context "rds_deletion_protection=false" \
    --region "$REGION" >/dev/null 2>&1
  # If CDK destroy failed, empty S3 buckets and retry via CloudFormation API
  if aws cloudformation describe-stacks --stack-name OpenemrEcsStack --region "$REGION" --query 'Stacks[0].StackStatus' --output text 2>/dev/null | grep -qv "does not exist"; then
    # Empty any versioned S3 buckets blocking deletion
    for BKT in $(aws s3 ls 2>/dev/null | awk '{print $3}' | grep "openemrecsstack"); do
      aws s3 rm "s3://$BKT" --recursive --region "$REGION" --quiet 2>/dev/null || true
      # Delete object versions too (versioned buckets)
      aws s3api list-object-versions --bucket "$BKT" --region "$REGION" \
        --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' --output json 2>/dev/null | \
        aws s3api delete-objects --bucket "$BKT" --delete file:///dev/stdin --region "$REGION" 2>/dev/null || true
      aws s3api list-object-versions --bucket "$BKT" --region "$REGION" \
        --query '{Objects: DeleteMarkers[].{Key:Key,VersionId:VersionId}}' --output json 2>/dev/null | \
        aws s3api delete-objects --bucket "$BKT" --delete file:///dev/stdin --region "$REGION" 2>/dev/null || true
    done
    aws cloudformation delete-stack --stack-name OpenemrEcsStack --region "$REGION" 2>/dev/null || true
    aws cloudformation wait stack-delete-complete --stack-name OpenemrEcsStack --region "$REGION" 2>/dev/null || true
  fi
  deactivate 2>/dev/null || true
) &
OPENEMR_PID=$!

# Wait for both to complete
log "Waiting for DemoAppStack (pid $DEMO_PID) and OpenemrEcsStack (pid $OPENEMR_PID)..."
wait $DEMO_PID && ok "Demo App stack destroyed" || warn "Demo App stack destroy may have had issues"
wait $OPENEMR_PID && ok "OpenEMR stack destroyed" || warn "OpenEMR stack destroy may have had issues"

cd "$SCRIPT_DIR"

# ─── Clean Up SSM Parameters ────────────────────────────────────────────────

log "Cleaning up SSM parameters..."
for PARAM in "/OpenEmrStack/FhirApiBaseUrl" "/OpenEmrStack/CredentialsSecretArn" "/OpenEmrStack/DatabaseSecretArn" "/OpenEmrStack/WebConsoleUrl" "/OpenEmrStack/KmsKeyArn"; do
  aws ssm delete-parameter --name "$PARAM" --region "$REGION" 2>/dev/null || true
done
ok "SSM parameters cleaned up"

# ─── Clean Up Self-Signed ACM Certificate ────────────────────────────────────

log "Cleaning up self-signed ACM certificates..."
SELF_SIGNED_CERTS=$(aws acm list-certificates --region "$REGION" \
  --includes keyTypes=RSA_2048 \
  --query "CertificateSummaryList[?DomainName=='*.elb.amazonaws.com' && Type=='IMPORTED'].CertificateArn" \
  --output text 2>/dev/null) || true

if [[ -n "$SELF_SIGNED_CERTS" && "$SELF_SIGNED_CERTS" != "None" ]]; then
  for CERT in $SELF_SIGNED_CERTS; do
    # Check if cert is still in use
    IN_USE=$(aws acm describe-certificate \
      --certificate-arn "$CERT" \
      --region "$REGION" \
      --query 'Certificate.InUseBy' \
      --output text 2>/dev/null) || true
    if [[ -z "$IN_USE" || "$IN_USE" == "None" ]]; then
      aws acm delete-certificate --certificate-arn "$CERT" --region "$REGION" 2>/dev/null || true
      ok "Deleted self-signed certificate: $CERT"
    else
      warn "Certificate still in use, skipping: $CERT"
    fi
  done
else
  ok "No self-signed certificates found to clean up"
fi

# ─── Verify ─────────────────────────────────────────────────────────────────

echo ""
log "Verifying cleanup..."

DEMO_STATUS=$(aws cloudformation describe-stacks --stack-name DemoAppStack --region "$REGION" --query 'Stacks[0].StackStatus' --output text 2>&1) || DEMO_STATUS="DELETED"
OPENEMR_STATUS=$(aws cloudformation describe-stacks --stack-name OpenemrEcsStack --region "$REGION" --query 'Stacks[0].StackStatus' --output text 2>&1) || OPENEMR_STATUS="DELETED"

if [[ "$DEMO_STATUS" == *"does not exist"* || "$DEMO_STATUS" == "DELETED" || "$DEMO_STATUS" == "DELETE_COMPLETE" ]]; then
  ok "DemoAppStack: deleted"
else
  fail "DemoAppStack status: $DEMO_STATUS"
  DESTROY_FAILED=true
fi

if [[ "$OPENEMR_STATUS" == *"does not exist"* || "$OPENEMR_STATUS" == "DELETED" || "$OPENEMR_STATUS" == "DELETE_COMPLETE" ]]; then
  ok "OpenEmrStack: deleted"
else
  fail "OpenEmrStack status: $OPENEMR_STATUS"
  DESTROY_FAILED=true
fi

echo ""
if [[ "${DESTROY_FAILED:-false}" == "true" ]]; then
  echo "═══════════════════════════════════════════════════════════════"
  echo "  Destroy INCOMPLETE. Some stacks remain — check above."
  echo "═══════════════════════════════════════════════════════════════"
  exit 1
fi
echo "═══════════════════════════════════════════════════════════════"
echo "  Destroy complete. All resources removed."
echo "═══════════════════════════════════════════════════════════════"
echo ""
