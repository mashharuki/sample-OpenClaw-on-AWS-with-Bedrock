import { BootstraplessSynthesizer, CfnOutput, Fn, Stack, StackProps } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';

export class DeployStaticSiteStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, {
      ...props,
      analyticsReporting: false,
      synthesizer: props?.synthesizer ?? new BootstraplessSynthesizer(),
    });

    this.templateOptions.templateFormatVersion = '2010-09-09';
    this.templateOptions.description = 'OpenClaw Admin Console - S3 + CloudFront (OAC, no public S3)';

    const siteBucket = new s3.CfnBucket(this, 'SiteBucket', {
      bucketName: Fn.sub('openclaw-console-${AWS::AccountId}'),
      publicAccessBlockConfiguration: {
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
    });

    const oac = new cloudfront.CfnOriginAccessControl(this, 'OAC', {
      originAccessControlConfig: {
        name: Fn.sub('openclaw-console-oac-${AWS::AccountId}'),
        originAccessControlOriginType: 's3',
        signingBehavior: 'always',
        signingProtocol: 'sigv4',
      },
    });

    const distribution = new cloudfront.CfnDistribution(this, 'Distribution', {
      distributionConfig: {
        enabled: true,
        comment: 'OpenClaw Admin Console',
        defaultRootObject: 'index.html',
        origins: [
          {
            id: 'S3Origin',
            domainName: siteBucket.attrRegionalDomainName,
            originAccessControlId: oac.ref,
            s3OriginConfig: {
              originAccessIdentity: '',
            },
          },
        ],
        defaultCacheBehavior: {
          targetOriginId: 'S3Origin',
          viewerProtocolPolicy: 'redirect-to-https',
          allowedMethods: ['GET', 'HEAD'],
          cachedMethods: ['GET', 'HEAD'],
          compress: true,
          cachePolicyId: '658327ea-f89d-4fab-a63d-7e88639e58f6',
        },
        priceClass: 'PriceClass_100',
        httpVersion: 'http2and3',
      },
    });

    new s3.CfnBucketPolicy(this, 'BucketPolicy', {
      bucket: siteBucket.ref,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AllowCloudFrontOAC',
            Effect: 'Allow',
            Principal: {
              Service: 'cloudfront.amazonaws.com',
            },
            Action: 's3:GetObject',
            Resource: Fn.sub('${SiteBucket.Arn}/*', {
              SiteBucket: siteBucket.ref,
            }),
            Condition: {
              StringEquals: {
                'AWS:SourceArn': Fn.sub('arn:aws:cloudfront::${AWS::AccountId}:distribution/${Distribution}', {
                  Distribution: distribution.ref,
                }),
              },
            },
          },
        ],
      },
    });

    new CfnOutput(this, 'BucketName', {
      value: siteBucket.ref,
    });

    new CfnOutput(this, 'CloudFrontURL', {
      value: Fn.sub('https://${Distribution.DomainName}', {
        Distribution: distribution.attrDomainName,
      }),
    });

    new CfnOutput(this, 'DistributionId', {
      value: distribution.ref,
    });
  }
}
