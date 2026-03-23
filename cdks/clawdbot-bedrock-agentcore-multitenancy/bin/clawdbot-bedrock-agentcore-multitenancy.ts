#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { ClawdbotBedrockAgentcoreMultitenancyStack } from '../lib/clawdbot-bedrock-agentcore-multitenancy-stack';

const app = new App({
  context: {
    'aws:cdk:enable-path-metadata': false,
  },
  treeMetadata: false,
});

new ClawdbotBedrockAgentcoreMultitenancyStack(app, 'ClawdbotBedrockAgentcoreMultitenancyStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
