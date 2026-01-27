# GitHub Actions CI/CD Pipeline - Setup Complete ✅

Your automatic deployment pipeline is now ready!

## What You Got

### 1. Automated Workflow (`.github/workflows/deploy.yml`)
- **Triggers**: Automatically on push to `main`
- **Smart Detection**: Only deploys changed components
- **Parallel Execution**: Multiple components deploy simultaneously
- **Status Reporting**: Real-time logs and summaries

### 2. Setup Documentation (`GITHUB_ACTIONS_SETUP.md`)
- Step-by-step AWS IAM setup
- GitHub secrets configuration
- Testing instructions
- Troubleshooting guide

### 3. Updated README
- Quick links to deployment docs
- How GitHub Actions works
- What triggers each deployment

## How It Works

```
You push to main
        ↓
GitHub Actions detects changes
        ↓
For each changed component:
  - Frontend changes? → Build Vite + Deploy S3 + Invalidate CloudFront
  - Matchmaker changes? → Build TypeScript + Deploy CDK stack
  - World Server changes? → Build Docker + Push to ECR
        ↓
Status summary in Actions tab
```

## Your Action Items

### Step 1: Create AWS IAM User (5 minutes)

```bash
# Create user
aws iam create-user --user-name github-actions-deploy

# Create access key
aws iam create-access-key --user-name github-actions-deploy
```

Save the Access Key ID and Secret Access Key!

### Step 2: Create and Attach IAM Policy (5 minutes)

See [GITHUB_ACTIONS_SETUP.md](GITHUB_ACTIONS_SETUP.md#2-grant-required-permissions) for the exact policy JSON.

```bash
aws iam put-user-policy --user-name github-actions-deploy \
  --policy-name DrawvidVerseDeployPolicy \
  --policy-document file://github-actions-policy.json
```

### Step 3: Add GitHub Secrets (2 minutes)

1. Go to GitHub → Settings → Secrets and variables → Actions
2. Add two secrets:
   - `AWS_ACCESS_KEY_ID` = [Your Access Key ID from step 1]
   - `AWS_SECRET_ACCESS_KEY` = [Your Secret Access Key from step 1]

### Step 4: Test (2 minutes)

```bash
# Make a test change
echo "// test" >> cyberia/src/index.js

# Commit and push
git add -A
git commit -m "test: trigger deployment"
git push origin main

# Watch it in GitHub Actions tab
```

## Deployment Timing

| Component | Time | When It Deploys |
|-----------|------|-----------------|
| Frontend | 2 min | Change in `cyberia/` |
| Matchmaker | 4 min | Change in `packages/drawvid-matchmaker/` or `games/` |
| World Server | 2 min | Change in `packages/drawvid-worldserver/` or `games/` |

## What's Actually Deployed

### Frontend
- Path: `cyberia/`
- Destination: S3 bucket `cyberia-drawvid-frontend-593615615124`
- CDN: CloudFront distribution `E2CCOO5NN3Z8QV`
- URL: https://cyberia.drawvid.com

### Matchmaker
- Path: `packages/drawvid-matchmaker/` or `games/`
- Destination: CloudFormation stack `DrawvidVerseMatchmakerStack`
- Region: us-east-2
- Includes: API Gateway, Lambda, DynamoDB, ECS cluster

### World Server
- Path: `packages/drawvid-worldserver/` or `games/`
- Destination: ECR repository `drawvidverse-worldserver`
- Region: us-east-2
- Auto-pulled by ECS on task launch

## Production Endpoints

After first successful deployment:
- **Frontend**: https://cyberia.drawvid.com
- **Matchmaker**: wss://matchmaker.drawvid.com/prod
- **World Server**: wss://world.drawvid.com:443

## Monitoring

### Real-time
- GitHub Actions tab → Click workflow → Watch logs

### AWS
- CloudFormation → Stacks
- CloudFront → Invalidations
- ECR → Image push history
- Lambda → Recent invocations

### Example CloudWatch
```bash
# Watch Lambda logs
aws logs tail /aws/lambda/ --follow --region us-east-2

# Watch world server logs
aws logs tail /ecs/drawvidverse-worldserver --follow --region us-east-2
```

## Example Workflow: Deploying a Game Update

1. Make changes to `packages/drawvid-worldserver/src/world/`
2. Commit: `git commit -m "feat: add new game mechanic"`
3. Push: `git push origin main`
4. Workflow triggers automatically
5. World server image is built and pushed to ECR (~2 min)
6. Next time a player joins, ECS pulls the new image
7. Changes are live!

## If Something Goes Wrong

1. **Workflow won't trigger**: Ensure you pushed to `main` branch
2. **Deployment fails**: Check GitHub Actions logs for error details
3. **AWS credentials invalid**: Regenerate access key and update GitHub secrets
4. **Build errors**: Test locally first with `npm run build`

See full troubleshooting in [GITHUB_ACTIONS_SETUP.md](GITHUB_ACTIONS_SETUP.md#troubleshooting)

## Manual Override (Emergency)

If you need to deploy without GitHub Actions:

```bash
# Frontend
./tools/scripts/deploy-frontend.sh

# Matchmaker
./tools/scripts/deploy-matchmaker.sh

# World Server
./tools/scripts/build-worldserver.sh 593615615124.dkr.ecr.us-east-2.amazonaws.com/drawvidverse-worldserver
```

## Next Steps

- [ ] **Complete Step 1-4 above** to enable GitHub Actions
- [ ] Run a test deployment with a small change
- [ ] Monitor the first deployment in Actions tab
- [ ] Celebrate no more manual deployments! 🎉

## Files Created/Modified

- ✅ `.github/workflows/deploy.yml` - Automated workflow (215 lines)
- ✅ `GITHUB_ACTIONS_SETUP.md` - Comprehensive setup guide (236 lines)
- ✅ `README.md` - Updated with GitHub Actions info
- ✅ `DEPLOYMENT.md` - Existing deployment reference
- ✅ `tools/scripts/deploy-*.sh` - Leverage existing scripts

---

**Status**: Ready to deploy! Just need to complete steps 1-4 above to enable.
