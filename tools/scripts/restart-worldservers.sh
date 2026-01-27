#!/usr/bin/env bash
# Restart all running world server ECS tasks and clean up DynamoDB worlds table

set -e

CLUSTER="drawvidverse-cluster"
REGION="us-east-2"

# Stop all running ECS tasks
echo "Stopping all running world server ECS tasks..."

STACK_NAME="DrawvidVerseMatchmakerStack"

# Get the target group ARN from CloudFormation stack output
TARGET_GROUP_ARN=$(aws cloudformation describe-stacks \
  --stack-name $STACK_NAME \
  --region $REGION \
  --query "Stacks[0].Outputs[?OutputKey=='WorldServerTargetGroupArn'].OutputValue" \
  --output text)

if [ -z "$TARGET_GROUP_ARN" ]; then
  echo "WARNING: Target group ARN not found in CloudFormation outputs. Skipping NLB deregistration."
  TARGET_GROUP_ARN=""
fi

TASKS=$(aws ecs list-tasks --cluster $CLUSTER --region $REGION --desired-status RUNNING --output text --query 'taskArns[]')
for TASK in $TASKS; do
  echo "Stopping $TASK"
  aws ecs stop-task --cluster $CLUSTER --task $TASK --region $REGION --reason "Deploy: force restart for new image"
  
  # Extract task ID and deregister from target group
  TASK_ID=$(echo $TASK | awk -F/ '{print $NF}')
  if [ -n "$TARGET_GROUP_ARN" ]; then
    echo "Deregistering task from NLB target group: $TASK_ID"
    aws elbv2 deregister-targets \
      --target-group-arn $TARGET_GROUP_ARN \
      --targets Id=$TASK_ID \
      --region $REGION || echo "Failed to deregister $TASK_ID (may not be registered)"
  fi
done

echo "ECS tasks stop requested and deregistered from NLB."

STACK_NAME="DrawvidVerseMatchmakerStack"
TABLE_NAME=$(aws cloudformation describe-stacks \
  --stack-name $STACK_NAME \
  --region $REGION \
  --query "Stacks[0].Outputs[?OutputKey=='WorldsTableName'].OutputValue" \
  --output text)

if [ -z "$TABLE_NAME" ]; then
  echo "ERROR: DynamoDB table name not found in CloudFormation outputs."
  echo "Check that your stack outputs WorldsTableName and that the stack name/region are correct."
  exit 1
fi

echo "Using DynamoDB table: $TABLE_NAME"

# Clean up DynamoDB worlds table (delete all items)
echo "Cleaning up DynamoDB worlds table: $TABLE_NAME"

ITEMS=$(aws dynamodb scan --table-name $TABLE_NAME --region $REGION --output json | jq -c '.Items[]')
for ITEM in $ITEMS; do
  # Extract partition key (pk) and sort key (sk) from the item
  PK=$(echo $ITEM | jq -r '.pk.S')
  SK=$(echo $ITEM | jq -r '.sk.S')
  
  if [ -z "$PK" ] || [ -z "$SK" ] || [ "$PK" == "null" ] || [ "$SK" == "null" ]; then
    echo "Skipping item with invalid keys: pk=$PK, sk=$SK"
    continue
  fi
  
  echo "Deleting item: pk=$PK, sk=$SK"
  aws dynamodb delete-item --table-name $TABLE_NAME --region $REGION --key "{\"pk\":{\"S\":\"$PK\"},\"sk\":{\"S\":\"$SK\"}}"
done

echo "DynamoDB cleanup complete."
