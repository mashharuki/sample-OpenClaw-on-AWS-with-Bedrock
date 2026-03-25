#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { ClawdbotBedrockStack } from '../lib/clawdbot-bedrock-stack';

const app = new App({
  context: {
    'aws:cdk:enable-path-metadata': false,
  },
  treeMetadata: false,
});

new ClawdbotBedrockStack(app, 'ClawdbotBedrockStack', {});
