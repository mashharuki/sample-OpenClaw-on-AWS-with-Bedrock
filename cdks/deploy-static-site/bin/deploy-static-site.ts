#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { DeployStaticSiteStack } from '../lib/deploy-static-site-stack';

const app = new App({
  context: {
    'aws:cdk:enable-path-metadata': false,
  },
  treeMetadata: false,
});

new DeployStaticSiteStack(app, 'DeployStaticSiteStack', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
