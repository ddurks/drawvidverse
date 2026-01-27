# GitHub Actions CI/CD Setup

This document explains how to set up GitHub Actions for automated deployment to production.

## What's Automated

The `.github/workflows/deploy.yml` workflow automatically deploys changes to production when you merge to `main`:

- **Matchmaker Backend** - Detects changes in `packages/drawvid-matchmaker/` or `games/`
- **World Server** - Detects changes in `packages/drawvid-worldserver/` or `games/`
- **Frontend** - Detects changes in `cyberia/`

Each component is deployed independently only when its files change.

## Setup Instructions

### 1. Create AWS IAM User for GitHub Actions

```bash
# Create user
aws iam create-user --user-name github-actions-deploy

# Create access key
aws iam create-access-key --user-name github-actions-deploy
# ⚠️  Save the Access Key ID and Secret Access Key!
```

### 2. Grant Required Permissions

Create a policy file (`github-actions-policy.json`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "cloudformation:*",
        "iam:*",
        "ec2:*",
        "ecs:*",
        "ecr:*",
        "logs:*",
        "dynamodb:*",
        "apigatewayv2:*",
        "elasticloadbalancingv2:*",
        "route53:*",
        "acm:*",
        "s3:*",
        "cloudfront:*",
        "secretsmanager:GetSecretValue"
      ],
      "Resource": "*"
    }
  ]
}
```

Attach the policy:

```bash
aws iam put-user-policy --user-name github-actions-deploy \
  --policy-name DrawvidVerseDeployPolicy \
  --policy-document file://github-actions-policy.json
```

### 3. Add GitHub Secrets

Go to your GitHub repository:
1. Settings → Secrets and variables → Actions
2. Click "New repository secret"
3. Add these secrets:

| Secret Name | Value |
|---|---|
| `AWS_ACCESS_KEY_ID` | From step 1 |
| `AWS_SECRET_ACCESS_KEY` | From step 1 |

### 4. Test the Pipeline

Make a test change and push to main:

```bash
# Make a small change to frontend (easiest to test)
echo "// test" >> cyberia/src/index.js

# Commit and push
git add -A
git commit -m "test: trigger deployment pipeline"
git push origin main
```

Then watch the workflow:
1. Go to GitHub repository → Actions
2. Click on the latest workflow run
3. Watch the logs in real-time

## How the Workflow Works

### 1. Change Detection

The workflow automatically detects which components changed:

```yaml
if [ "${{ github.event_name }}" == "pull_request" ]; then
  CHANGED_FILES=$(git diff --name-only ${{ github.event.pull_request.base.sha }} HEAD)
else
  CHANGED_FILES=$(git diff --name-only HEAD~1 HEAD)
fi
```

### 2. Conditional Deployment

Each deployment job only runs if its component changed:

```yaml
deploy-frontend:
  if: needs.detect-changes.outputs.frontend-changed == 'true'
```

### 3. Build & Deploy

Uses the existing deployment scripts:
- Matchmaker: `npx cdk deploy --all --require-approval never`
- World Server: `./tools/scripts/build-worldserver.sh`
- Frontend: `./tools/scripts/deploy-frontend.sh`

## Deployment Paths

### Matchmaker Changes
- Triggers: Changes in `packages/drawvid-matchmaker/` or `games/`
- Action: Runs `npm run build` → `cdk deploy`
- Time: ~3-5 minutes

### World Server Changes
- Triggers: Changes in `packages/drawvid-worldserver/` or `games/`
- Action: Builds Docker image → Pushes to ECR
- Time: ~2 minutes
- Note: ECS will use the new image on next task launch

### Frontend Changes
- Triggers: Changes in `cyberia/`
- Action: Builds Vite app → Syncs to S3 → Invalidates CloudFront
- Time: ~2 minutes

## Monitoring Deployments

### Real-time Logs
- Go to Actions tab → Click workflow run → Expand job logs

### CloudWatch Logs
Monitor specific services:

```bash
# Matchmaker Lambda
aws logs tail /aws/lambda/ --follow --region us-east-2

# World Server Logs
aws logs tail /ecs/drawvidverse-worldserver --follow --region us-east-2
```

### CloudFront Cache
Check invalidation status:

```bash
# List recent invalidations
aws cloudfront list-invalidations --distribution-id E2CCOO5NN3Z8QV

# Get specific invalidation status
aws cloudfront get-invalidation --distribution-id E2CCOO5NN3Z8QV --id <INVALIDATION_ID>
```

## Troubleshooting

### Workflow doesn't trigger
- Ensure you pushed to `main` branch
- Check repository settings → Actions → Workflow permissions
- Verify secrets are set in Settings → Secrets and variables

### Deployment fails
1. Check the GitHub Actions logs for error messages
2. Common issues:
   - AWS credentials expired → Generate new access key
   - Missing permissions → Update IAM policy
   - Build errors → Check local build: `npm run build`

### Partial deployments
- Only changed components deploy
- To force all deployments: Modify all component files or manually run `./tools/scripts/deploy-*.sh`

## Manual Override

To bypass GitHub Actions and deploy manually:

```bash
# Frontend
./tools/scripts/deploy-frontend.sh

# Matchmaker
./tools/scripts/deploy-matchmaker.sh

# World Server
./tools/scripts/build-worldserver.sh 593615615124.dkr.ecr.us-east-2.amazonaws.com/drawvidverse-worldserver
```

## Production Endpoints

After successful deployment:
- **Frontend**: https://cyberia.drawvid.com
- **Matchmaker**: wss://matchmaker.drawvid.com/prod
- **World Server**: wss://world.drawvid.com:443

## Security Notes

⚠️ **Important:**
- AWS credentials are sensitive - never commit them
- Only share `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` with GitHub
- Use IAM role with minimal required permissions
- Rotate keys regularly
- Monitor AWS CloudTrail for unexpected deployments

## Disabling Auto-deployment

To disable automatic deployments:

1. Disable the workflow in GitHub:
   - Actions → Deploy to Production → Click ... → Disable workflow
2. Or edit `.github/workflows/deploy.yml` and comment out the `on` trigger

## Next Steps

1. ✅ Create GitHub Actions secrets with AWS credentials
2. ✅ Test with a small frontend change
3. ✅ Monitor CloudWatch logs during deployment
4. ✅ Celebrate automated deployments! 🚀
