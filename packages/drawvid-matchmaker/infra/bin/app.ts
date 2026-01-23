#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { MatchmakerStack } from '../lib/matchmaker-stack';

const app = new cdk.App();

new MatchmakerStack(app, 'DrawvidVerseMatchmakerStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION || 'us-east-2',
  },
  description: 'Drawvidverse matchmaker - WebSocket lobby and ECS task launcher',
});

app.synth();
