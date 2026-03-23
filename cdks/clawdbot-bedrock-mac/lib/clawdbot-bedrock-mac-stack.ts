import {
    Aws,
    BootstraplessSynthesizer,
    CfnCondition,
    CfnMapping,
    CfnOutput,
    CfnParameter,
    CfnTag,
    CfnWaitCondition,
    CfnWaitConditionHandle,
    Fn,
    Stack,
    StackProps,
    Token,
} from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const BEDROCK_MODELS = [
  'global.amazon.nova-2-lite-v1:0',
  'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'us.amazon.nova-pro-v1:0',
  'global.anthropic.claude-opus-4-6-v1',
  'global.anthropic.claude-opus-4-5-20251101-v1:0',
  'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  'global.anthropic.claude-sonnet-4-20250514-v1:0',
  'us.deepseek.r1-v1:0',
  'us.meta.llama3-3-70b-instruct-v1:0',
  'moonshotai.kimi-k2.5',
];

const MAC_INSTANCE_TYPES = ['mac1.metal', 'mac2.metal', 'mac2-m2.metal', 'mac2-m2pro.metal'];

const MANTLE_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-2',
  'ap-southeast-3',
  'ap-south-1',
  'ap-northeast-1',
  'eu-central-1',
  'eu-west-1',
  'eu-west-2',
  'eu-south-1',
  'eu-north-1',
  'sa-east-1',
];

function nameTag(value: string): CfnTag[] {
  return [{ key: 'Name', value }];
}

function regionConditionId(region: string): string {
  return `Is${region
    .split('-')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join('')}`;
}

export class ClawdbotBedrockMacStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, {
      ...props,
      analyticsReporting: false,
      synthesizer: props?.synthesizer ?? new BootstraplessSynthesizer(),
    });

    this.templateOptions.templateFormatVersion = '2010-09-09';
    this.templateOptions.description = 'OpenClaw - AWS Native Deployment on Mac Instances (Bedrock + SSM + VPC Endpoints)';
    this.templateOptions.metadata = {
      'cfn-lint': {
        config: {
          ignore_checks: ['E6101'],
        },
      },
      'AWS::CloudFormation::Interface': {
        ParameterGroups: [
          {
            Label: { default: 'Basic Configuration' },
            Parameters: ['OpenClawModel', 'MacInstanceType', 'MacAvailabilityZone', 'KeyPairName'],
          },
          {
            Label: { default: 'Network Configuration' },
            Parameters: ['CreateVPCEndpoints', 'AllowedSSHCIDR'],
          },
        ],
        ParameterLabels: {
          MacAvailabilityZone: {
            default: 'Mac Availability Zone (check supported AZs first)',
          },
        },
      },
    };

    const openClawModel = new CfnParameter(this, 'OpenClawModel', {
      type: 'String',
      default: 'global.amazon.nova-2-lite-v1:0',
      description: 'Bedrock model ID - Nova 2 Lite offers best price-performance for everyday tasks',
      allowedValues: BEDROCK_MODELS,
    });

    const macInstanceType = new CfnParameter(this, 'MacInstanceType', {
      type: 'String',
      default: 'mac2.metal',
      description: 'Mac instance type - Apple Silicon (mac2) recommended for best performance',
      allowedValues: MAC_INSTANCE_TYPES,
    });

    const macAvailabilityZone = new CfnParameter(this, 'MacAvailabilityZone', {
      type: 'AWS::EC2::AvailabilityZone::Name',
      description: 'Availability Zone for Mac Dedicated Host (Mac instances only available in specific AZs, check AWS console)',
    });

    const macAmiId = new CfnParameter(this, 'MacAmiId', {
      type: 'String',
      default: 'auto',
      description: "macOS AMI ID - 'auto' uses region-specific AMI from Mappings, or specify custom AMI ID",
    });

    const keyPairName = new CfnParameter(this, 'KeyPairName', {
      type: 'String',
      default: 'none',
      description: "EC2 key pair for emergency SSH access (optional - set to 'none' to skip)",
    });

    const allowedSshCidr = new CfnParameter(this, 'AllowedSSHCIDR', {
      type: 'String',
      default: '',
      description:
        'CIDR for SSH access (optional - leave empty for no inbound rules. SSM Session Manager is used for access. If SSH is needed, set to your IP/32 - find your IP at checkip.amazonaws.com)',
    });

    const createVpcEndpoints = new CfnParameter(this, 'CreateVPCEndpoints', {
      type: 'String',
      default: 'true',
      description: 'Create VPC endpoints for private network access to Bedrock and SSM',
      allowedValues: ['true', 'false'],
    });

    const createEndpoints = new CfnCondition(this, 'CreateEndpoints', {
      expression: Fn.conditionEquals(createVpcEndpoints.valueAsString, 'true'),
    });

    const hasKeyPair = new CfnCondition(this, 'HasKeyPair', {
      expression: Fn.conditionNot(Fn.conditionEquals(keyPairName.valueAsString, 'none')),
    });

    const allowSsh = new CfnCondition(this, 'AllowSSH', {
      expression: Fn.conditionAnd(
        Fn.conditionNot(Fn.conditionEquals(allowedSshCidr.valueAsString, '')),
        Fn.conditionNot(Fn.conditionEquals(keyPairName.valueAsString, 'none')),
      ),
    });

    const regionConditions = MANTLE_REGIONS.map(
      (region) => new CfnCondition(this, regionConditionId(region), {
        expression: Fn.conditionEquals(Aws.REGION, region),
      }),
    );

    const isMantleSupportedRegion = new CfnCondition(this, 'IsMantleSupportedRegion', {
      expression: Fn.conditionOr(Fn.conditionOr(...regionConditions.slice(0, 6)), Fn.conditionOr(...regionConditions.slice(6))),
    });

    const createMantleEndpoint = new CfnCondition(this, 'CreateMantleEndpoint', {
      expression: Fn.conditionAnd(createEndpoints, isMantleSupportedRegion),
    });

    const useAppleSilicon = new CfnCondition(this, 'UseAppleSilicon', {
      expression: Fn.conditionOr(
        Fn.conditionEquals(macInstanceType.valueAsString, 'mac2.metal'),
        Fn.conditionEquals(macInstanceType.valueAsString, 'mac2-m2.metal'),
        Fn.conditionEquals(macInstanceType.valueAsString, 'mac2-m2pro.metal'),
      ),
    });

    const useCustomAmi = new CfnCondition(this, 'UseCustomAmi', {
      expression: Fn.conditionNot(Fn.conditionEquals(macAmiId.valueAsString, 'auto')),
    });

    const macAmiMap = new CfnMapping(this, 'MacAMIMap', {
      mapping: {
        'us-east-1': {
          ARM64: 'ami-0420d6d86c005f1a6',
          x86: 'ami-007ae6b9518910424',
        },
        'us-east-2': {
          ARM64: 'ami-0c3778f70773e4e07',
          x86: 'ami-04b891889e8b23d1d',
        },
        'us-west-2': {
          ARM64: 'ami-0b819b7d6ae776d4e',
          x86: 'ami-041e81610d6df2fcd',
        },
        'eu-west-1': {
          ARM64: 'ami-063bab20ad71743f0',
          x86: 'ami-0f3a6a8ca5f03c8cb',
        },
        'eu-central-1': {
          ARM64: 'ami-0dc7194f5dead7614',
          x86: 'ami-0d827239b6896853e',
        },
        'ap-southeast-1': {
          ARM64: 'ami-08b109887921984aa',
          x86: 'ami-0fcb40a10e9f9b91c',
        },
        'ap-southeast-2': {
          ARM64: 'ami-058d03e0176f2725a',
          x86: 'ami-07020a94c8d2684e2',
        },
      },
    });

    const waitHandle = new CfnWaitConditionHandle(this, 'OpenClawWaitHandle');

    const macDedicatedHost = new ec2.CfnHost(this, 'MacDedicatedHost', {
      autoPlacement: 'on',
      availabilityZone: macAvailabilityZone.valueAsString,
      instanceType: macInstanceType.valueAsString,
    });

    const vpc = new ec2.CfnVPC(this, 'OpenClawVPC', {
      cidrBlock: '10.0.0.0/16',
      enableDnsHostnames: true,
      enableDnsSupport: true,
      tags: nameTag(Fn.sub('${AWS::StackName}-vpc')),
    });

    const internetGateway = new ec2.CfnInternetGateway(this, 'OpenClawInternetGateway');

    const attachGateway = new ec2.CfnVPCGatewayAttachment(this, 'AttachGateway', {
      vpcId: vpc.ref,
      internetGatewayId: internetGateway.ref,
    });

    const publicSubnet = new ec2.CfnSubnet(this, 'PublicSubnet', {
      vpcId: vpc.ref,
      cidrBlock: '10.0.1.0/24',
      mapPublicIpOnLaunch: true,
      availabilityZone: macAvailabilityZone.valueAsString,
      tags: nameTag(Fn.sub('${AWS::StackName}-public-subnet')),
    });

    const privateSubnet = new ec2.CfnSubnet(this, 'PrivateSubnet', {
      vpcId: vpc.ref,
      cidrBlock: '10.0.2.0/24',
      availabilityZone: macAvailabilityZone.valueAsString,
      tags: nameTag(Fn.sub('${AWS::StackName}-private-subnet')),
    });

    const publicRouteTable = new ec2.CfnRouteTable(this, 'PublicRouteTable', {
      vpcId: vpc.ref,
    });

    const publicRoute = new ec2.CfnRoute(this, 'PublicRoute', {
      routeTableId: publicRouteTable.ref,
      destinationCidrBlock: '0.0.0.0/0',
      gatewayId: internetGateway.ref,
    });
    publicRoute.addDependency(attachGateway);

    const subnetRouteTableAssociation = new ec2.CfnSubnetRouteTableAssociation(this, 'SubnetRouteTableAssociation', {
      subnetId: publicSubnet.ref,
      routeTableId: publicRouteTable.ref,
    });

    const securityGroup = new ec2.CfnSecurityGroup(this, 'OpenClawSecurityGroup', {
      groupDescription: 'OpenClaw Mac instance security group',
      vpcId: vpc.ref,
      securityGroupEgress: [{ ipProtocol: '-1', cidrIp: '0.0.0.0/0' }],
      tags: nameTag(Fn.sub('${AWS::StackName}-sg')),
    });

    const sshIngress = new ec2.CfnSecurityGroupIngress(this, 'OpenClawSshIngress', {
      groupId: securityGroup.attrGroupId,
      ipProtocol: 'tcp',
      fromPort: 22,
      toPort: 22,
      cidrIp: allowedSshCidr.valueAsString,
      description: 'SSH access (fallback)',
    });
    sshIngress.cfnOptions.condition = allowSsh;

    const vncIngress = new ec2.CfnSecurityGroupIngress(this, 'OpenClawVncIngress', {
      groupId: securityGroup.attrGroupId,
      ipProtocol: 'tcp',
      fromPort: 5900,
      toPort: 5900,
      cidrIp: allowedSshCidr.valueAsString,
      description: 'VNC access for Mac GUI',
    });
    vncIngress.cfnOptions.condition = allowSsh;

    const endpointSecurityGroup = new ec2.CfnSecurityGroup(this, 'VPCEndpointSecurityGroup', {
      groupDescription: 'Security group for VPC endpoints',
      vpcId: vpc.ref,
      securityGroupIngress: [
        {
          ipProtocol: 'tcp',
          fromPort: 443,
          toPort: 443,
          sourceSecurityGroupId: securityGroup.attrGroupId,
        },
      ],
      tags: nameTag(Fn.sub('${AWS::StackName}-vpce-sg')),
    });
    endpointSecurityGroup.cfnOptions.condition = createEndpoints;

    const endpointSpecs = [
      ['BedrockRuntimeVPCEndpoint', 'bedrock-runtime', createEndpoints],
      ['BedrockMantleVPCEndpoint', 'bedrock-mantle', createMantleEndpoint],
      ['SSMVPCEndpoint', 'ssm', createEndpoints],
      ['SSMMessagesVPCEndpoint', 'ssmmessages', createEndpoints],
      ['EC2MessagesVPCEndpoint', 'ec2messages', createEndpoints],
    ] as const;

    for (const [logicalId, serviceSuffix, condition] of endpointSpecs) {
      const endpoint = new ec2.CfnVPCEndpoint(this, logicalId, {
        vpcId: vpc.ref,
        serviceName: Fn.sub(`com.amazonaws.\${AWS::Region}.${serviceSuffix}`),
        vpcEndpointType: 'Interface',
        privateDnsEnabled: true,
        subnetIds: [privateSubnet.ref],
        securityGroupIds: [endpointSecurityGroup.attrGroupId],
      });
      endpoint.cfnOptions.condition = condition;
    }

    const instanceRole = new iam.CfnRole(this, 'OpenClawInstanceRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'ec2.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      },
      managedPolicyArns: [
        'arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore',
        'arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy',
      ],
      policies: [
        {
          policyName: 'BedrockAccessPolicy',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: [
                  'bedrock:InvokeModel',
                  'bedrock:InvokeModelWithResponseStream',
                  'bedrock:ListFoundationModels',
                  'bedrock:GetFoundationModel',
                ],
                Resource: '*',
              },
            ],
          },
        },
        {
          policyName: 'SSMParameterPolicy',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['ssm:PutParameter', 'ssm:GetParameter'],
                Resource: Fn.sub('arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/openclaw/${AWS::StackName}/*'),
              },
            ],
          },
        },
      ],
      tags: nameTag(Fn.sub('${AWS::StackName}-instance-role')),
    });

    const instanceProfile = new iam.CfnInstanceProfile(this, 'OpenClawInstanceProfile', {
      roles: [instanceRole.ref],
    });

    const userDataTemplate = readFileSync(join(__dirname, '..', 'userdata', 'openclaw-mac-bootstrap.sh'), 'utf8');

    const imageId = Token.asString(
      Fn.conditionIf(
        useCustomAmi.logicalId,
        macAmiId.valueAsString,
        Fn.conditionIf(
          useAppleSilicon.logicalId,
          macAmiMap.findInMap(Aws.REGION, 'ARM64'),
          macAmiMap.findInMap(Aws.REGION, 'x86'),
        ),
      ),
    );

    const instance = new ec2.CfnInstance(this, 'OpenClawInstance', {
      imageId,
      instanceType: macInstanceType.valueAsString,
      keyName: Token.asString(Fn.conditionIf(hasKeyPair.logicalId, keyPairName.valueAsString, Aws.NO_VALUE)),
      iamInstanceProfile: instanceProfile.ref,
      tenancy: 'host',
      hostId: macDedicatedHost.ref,
      networkInterfaces: [
        {
          associatePublicIpAddress: true,
          deviceIndex: '0',
          groupSet: [securityGroup.attrGroupId],
          subnetId: publicSubnet.ref,
        },
      ],
      blockDeviceMappings: [
        {
          deviceName: '/dev/sda1',
          ebs: {
            volumeSize: 100,
            volumeType: 'gp3',
            deleteOnTermination: true,
          },
        },
      ],
      userData: Fn.base64(Fn.sub(userDataTemplate)),
      tags: [
        { key: 'Name', value: Fn.sub('${AWS::StackName}-mac-instance') },
        { key: 'MacInstanceType', value: macInstanceType.valueAsString },
      ],
    });
    instance.addDependency(macDedicatedHost);
    instance.addDependency(instanceProfile);
    instance.addDependency(publicRoute);
    instance.addDependency(subnetRouteTableAssociation);

    const waitCondition = new CfnWaitCondition(this, 'OpenClawWaitCondition', {
      handle: waitHandle.ref,
      timeout: '1800',
      count: 1,
    });
    waitCondition.addDependency(instance);

    new CfnOutput(this, 'Step1InstallSSMPlugin', {
      description: 'STEP 1: Install SSM Session Manager Plugin on your local computer',
      value: 'https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html',
    });

    new CfnOutput(this, 'Step2PortForwarding', {
      description: 'STEP 2: Run this command on LOCAL computer (keep terminal open)',
      value: Fn.sub(
        'aws ssm start-session --target ${OpenClawInstance} --region ${AWS::Region} --document-name AWS-StartPortForwardingSession --parameters \'{"portNumber":["18789"],"localPortNumber":["18789"]}\'',
      ),
    });

    new CfnOutput(this, 'Step3GetToken', {
      description: 'STEP 3: Get your access token',
      value: Fn.sub(
        'aws ssm get-parameter --name /openclaw/${AWS::StackName}/gateway-token --with-decryption --query Parameter.Value --output text --region ${AWS::Region}',
      ),
    });

    new CfnOutput(this, 'Step4StartChatting', {
      description: 'STEP 4: Start using OpenClaw!',
      value: 'Connect WhatsApp, Telegram, Discord. See README: https://github.com/aws-samples/sample-OpenClaw-on-AWS-with-Bedrock',
    });

    new CfnOutput(this, 'InstanceId', {
      description: 'EC2 Mac Instance ID (for reference)',
      value: instance.ref,
    });

    const macInstanceTypeOutput = new CfnOutput(this, 'MacInstanceTypeOutput', {
      description: 'Mac instance type in use',
      value: macInstanceType.valueAsString,
    });
    macInstanceTypeOutput.overrideLogicalId('MacInstanceType');

    new CfnOutput(this, 'DedicatedHostId', {
      description: 'Mac Dedicated Host ID',
      value: macDedicatedHost.ref,
    });

    new CfnOutput(this, 'BedrockModel', {
      description: 'Bedrock model in use',
      value: openClawModel.valueAsString,
    });

    new CfnOutput(this, 'MonthlyCost', {
      description: 'Estimated monthly cost (USD) - Mac instances require 24-hour minimum allocation',
      value: Fn.sub(
        [
          'Mac Dedicated Host (${MacInstanceType}): ~$650-1100/month (24hr minimum)',
          'EBS (100GB): ~$8',
          'VPC Endpoints: ${EndpointCost}',
          'Bedrock: Pay-per-use',
          'Total: ~${TotalCost}/month',
          'Note: Mac instances have 24-hour minimum allocation period',
        ].join('\n'),
        {
          EndpointCost: Token.asString(Fn.conditionIf(createEndpoints.logicalId, '~$29 ($0.01/hour x 5 endpoints)', '$0')),
          TotalCost: Token.asString(Fn.conditionIf(createEndpoints.logicalId, '$687-1137', '$658-1108')),
        },
      ),
    });

    new CfnOutput(this, 'ImportantNotes', {
      description: 'Important notes about Mac instances',
      value: [
        '1. Mac instances require a Dedicated Host with 24-hour minimum allocation',
        '2. mac1.metal = Intel x86_64, mac2.metal = Apple M1, mac2-m2.metal = Apple M2, mac2-m2pro.metal = Apple M2 Pro',
        '3. Apple Silicon (mac2*) instances offer better performance for most workloads',
        '4. Deleting the stack will release the Dedicated Host after the 24-hour minimum period',
      ].join('\n'),
    });
  }
}
