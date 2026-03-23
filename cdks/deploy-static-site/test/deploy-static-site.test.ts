import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { DeployStaticSiteStack } from '../lib/deploy-static-site-stack';

test('static site infrastructure resources are synthesized', () => {
  const app = new App();
  const stack = new DeployStaticSiteStack(app, 'MyTestStack');
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::S3::Bucket', 1);
  template.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
  template.resourceCountIs('AWS::CloudFront::Distribution', 1);
  template.resourceCountIs('AWS::S3::BucketPolicy', 1);

  template.hasResourceProperties('AWS::S3::Bucket', {
    BucketName: {
      'Fn::Sub': 'openclaw-console-${AWS::AccountId}',
    },
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    },
  });

  template.hasResourceProperties('AWS::CloudFront::Distribution', {
    DistributionConfig: Match.objectLike({
      Comment: 'OpenClaw Admin Console',
      DefaultRootObject: 'index.html',
      PriceClass: 'PriceClass_100',
      HttpVersion: 'http2and3',
    }),
  });

  template.hasOutput('CloudFrontURL', {});
  template.hasOutput('DistributionId', {});
});
