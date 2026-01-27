#!/usr/bin/env bash
# Restart all running world server ECS tasks and clean up DynamoDB worlds table

set -e

CLUSTER="drawvidverse-cluster"
REGION="us-east-2"

# Stop all running ECS tasks
echo "Stopping all running world server ECS tasks..."
TASKS=$(aws ecs list-tasks --cluster $CLUSTER --region $REGION --desired-status RUNNING --output text --query 'taskArns[]')
for TASK in $TASKS; do
  echo "Stopping $TASK"
  aws ecs stop-task --cluster $CLUSTER --task $TASK --region $REGION --reason "Deploy: force restart for new image"
done

echo "ECS tasks stop requested."

# Get the table name from CloudFormation stack output
STACK_NAME="DrawvidVerseMatchmakerStack"
TABLE_NAME=$(aws cloudformation describe-stacks \
  --stack-name $STACK_NAME \
  --region $REGION \
  --query "Stacks[0].Outputs[?OutputKey=='WorldsTableName'].OutputValue" \
  --output text)

echo "Using DynamoDB table: $TABLE_NAME"

# Clean up DynamoDB worlds table (delete all items)
echo "Cleaning up DynamoDB worlds table: $TABLE_NAME"

ITEMS=$(aws dynamodb scan --table-name $TABLE_NAME --region $REGION --output json | jq -c '.Items[]')
for ITEM in $ITEMS; do
  # Extract the primary key (assumes 'worldId' is the partition key)
  WORLD_ID=$(echo $ITEM | jq -r '.worldId.S')
  echo "Deleting worldId: $WORLD_ID"
  aws dynamodb delete-item --table-name $TABLE_NAME --region $REGION --key "{\"worldId\":{\"S\":\"$WORLD_ID\"}}"
done

echo "DynamoDB cleanup complete."
