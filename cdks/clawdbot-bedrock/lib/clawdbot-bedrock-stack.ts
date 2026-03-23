import {
  App,
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
  RemovalPolicy,
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

const INSTANCE_TYPES = [
  't4g.small',
  't4g.medium',
  't4g.large',
  't4g.xlarge',
  'c6g.large',
  'c6g.xlarge',
  'c7g.large',
  'c7g.xlarge',
  't3.small',
  't3.medium',
  't3.large',
  'c5.xlarge',
];

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

export class ClawdbotBedrockStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, {
      ...props,
      analyticsReporting: false,
      synthesizer: props?.synthesizer ?? new BootstraplessSynthesizer(),
    });

    this.templateOptions.templateFormatVersion = '2010-09-09';
    this.templateOptions.description = 'OpenClaw - AWS Native Deployment (Bedrock + SSM + VPC Endpoints)';
    this.templateOptions.metadata = {
      'cfn-lint': {
        config: {
          ignore_checks: ['E6101'],
        },
      },
    };

    const openClawModel = new CfnParameter(this, 'OpenClawModel', {
      type: 'String',
      default: 'global.amazon.nova-2-lite-v1:0',
      description: 'Bedrock model ID - Nova 2 Lite offers best price-performance for everyday tasks',
      allowedValues: BEDROCK_MODELS,
    });

    const instanceType = new CfnParameter(this, 'InstanceType', {
      type: 'String',
      default: 'c7g.large',
      description: 'Graviton (ARM) recommended for 20-40% better price-performance. x86 also supported.',
      allowedValues: INSTANCE_TYPES,
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

    const enableSandbox = new CfnParameter(this, 'EnableSandbox', {
      type: 'String',
      default: 'true',
      description: 'Install Docker for sandboxed execution (recommended for group chats)',
    });

    const enableDataProtection = new CfnParameter(this, 'EnableDataProtection', {
      type: 'String',
      default: 'false',
      description: 'Retain data volume when stack is deleted (protects against accidental data loss)',
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
      expression: Fn.conditionOr(
        Fn.conditionOr(...regionConditions.slice(0, 6)),
        Fn.conditionOr(...regionConditions.slice(6)),
      ),
    });

    const createMantleEndpoint = new CfnCondition(this, 'CreateMantleEndpoint', {
      expression: Fn.conditionAnd(createEndpoints, isMantleSupportedRegion),
    });

    const protectData = new CfnCondition(this, 'ProtectData', {
      expression: Fn.conditionEquals(enableDataProtection.valueAsString, 'true'),
    });

    const deleteData = new CfnCondition(this, 'DeleteData', {
      expression: Fn.conditionNot(Fn.conditionEquals(enableDataProtection.valueAsString, 'true')),
    });

    new CfnCondition(this, 'EnableDocker', {
      expression: Fn.conditionEquals(enableSandbox.valueAsString, 'true'),
    });

    const architectureMap = new CfnMapping(this, 'ArchitectureMap', {
      mapping: {
        't3.small': { Arch: 'amd64' },
        't3.medium': { Arch: 'amd64' },
        't3.large': { Arch: 'amd64' },
        't3.xlarge': { Arch: 'amd64' },
        'c5.xlarge': { Arch: 'amd64' },
        't4g.small': { Arch: 'arm64' },
        't4g.medium': { Arch: 'arm64' },
        't4g.large': { Arch: 'arm64' },
        't4g.xlarge': { Arch: 'arm64' },
        'c6g.large': { Arch: 'arm64' },
        'c6g.xlarge': { Arch: 'arm64' },
        'c7g.large': { Arch: 'arm64' },
        'c7g.xlarge': { Arch: 'arm64' },
      },
    });

    const availabilityZone = Fn.select(0, Fn.getAzs(''));
    const architecture = architectureMap.findInMap(instanceType.valueAsString, 'Arch');

    const openClawWaitHandle = new CfnWaitConditionHandle(this, 'OpenClawWaitHandle');

    const openClawVpc = new ec2.CfnVPC(this, 'OpenClawVPC', {
      cidrBlock: '10.0.0.0/16',
      enableDnsHostnames: true,
      enableDnsSupport: true,
      tags: nameTag(Fn.sub('${AWS::StackName}-vpc')),
    });

    const openClawInternetGateway = new ec2.CfnInternetGateway(this, 'OpenClawInternetGateway');

    const attachGateway = new ec2.CfnVPCGatewayAttachment(this, 'AttachGateway', {
      vpcId: openClawVpc.ref,
      internetGatewayId: openClawInternetGateway.ref,
    });

    const publicSubnet = new ec2.CfnSubnet(this, 'PublicSubnet', {
      vpcId: openClawVpc.ref,
      cidrBlock: '10.0.1.0/24',
      mapPublicIpOnLaunch: true,
      availabilityZone,
      tags: nameTag(Fn.sub('${AWS::StackName}-public-subnet')),
    });

    const privateSubnet = new ec2.CfnSubnet(this, 'PrivateSubnet', {
      vpcId: openClawVpc.ref,
      cidrBlock: '10.0.2.0/24',
      availabilityZone,
      tags: nameTag(Fn.sub('${AWS::StackName}-private-subnet')),
    });

    const publicRouteTable = new ec2.CfnRouteTable(this, 'PublicRouteTable', {
      vpcId: openClawVpc.ref,
    });

    const publicRoute = new ec2.CfnRoute(this, 'PublicRoute', {
      routeTableId: publicRouteTable.ref,
      destinationCidrBlock: '0.0.0.0/0',
      gatewayId: openClawInternetGateway.ref,
    });
    publicRoute.addDependency(attachGateway);

    const subnetRouteTableAssociation = new ec2.CfnSubnetRouteTableAssociation(this, 'SubnetRouteTableAssociation', {
      subnetId: publicSubnet.ref,
      routeTableId: publicRouteTable.ref,
    });

    const openClawSecurityGroup = new ec2.CfnSecurityGroup(this, 'OpenClawSecurityGroup', {
      groupDescription: 'OpenClaw instance security group',
      vpcId: openClawVpc.ref,
      securityGroupEgress: [{ ipProtocol: '-1', cidrIp: '0.0.0.0/0' }],
      tags: nameTag(Fn.sub('${AWS::StackName}-sg')),
    });

    const sshIngress = new ec2.CfnSecurityGroupIngress(this, 'OpenClawSshIngress', {
      groupId: openClawSecurityGroup.attrGroupId,
      ipProtocol: 'tcp',
      fromPort: 22,
      toPort: 22,
      cidrIp: allowedSshCidr.valueAsString,
      description: 'SSH access (fallback)',
    });
    sshIngress.cfnOptions.condition = allowSsh;

    const vpcEndpointSecurityGroup = new ec2.CfnSecurityGroup(this, 'VPCEndpointSecurityGroup', {
      groupDescription: 'Security group for VPC endpoints',
      vpcId: openClawVpc.ref,
      securityGroupIngress: [
        {
          ipProtocol: 'tcp',
          fromPort: 443,
          toPort: 443,
          sourceSecurityGroupId: openClawSecurityGroup.attrGroupId,
        },
      ],
      tags: nameTag(Fn.sub('${AWS::StackName}-vpce-sg')),
    });
    vpcEndpointSecurityGroup.cfnOptions.condition = createEndpoints;

    const bedrockRuntimeVpcEndpoint = new ec2.CfnVPCEndpoint(this, 'BedrockRuntimeVPCEndpoint', {
      vpcId: openClawVpc.ref,
      serviceName: Fn.sub('com.amazonaws.${AWS::Region}.bedrock-runtime'),
      vpcEndpointType: 'Interface',
      privateDnsEnabled: true,
      subnetIds: [privateSubnet.ref],
      securityGroupIds: [vpcEndpointSecurityGroup.attrGroupId],
    });
    bedrockRuntimeVpcEndpoint.cfnOptions.condition = createEndpoints;

    const bedrockMantleVpcEndpoint = new ec2.CfnVPCEndpoint(this, 'BedrockMantleVPCEndpoint', {
      vpcId: openClawVpc.ref,
      serviceName: Fn.sub('com.amazonaws.${AWS::Region}.bedrock-mantle'),
      vpcEndpointType: 'Interface',
      privateDnsEnabled: true,
      subnetIds: [privateSubnet.ref],
      securityGroupIds: [vpcEndpointSecurityGroup.attrGroupId],
    });
    bedrockMantleVpcEndpoint.cfnOptions.condition = createMantleEndpoint;

    const ssmVpcEndpoint = new ec2.CfnVPCEndpoint(this, 'SSMVPCEndpoint', {
      vpcId: openClawVpc.ref,
      serviceName: Fn.sub('com.amazonaws.${AWS::Region}.ssm'),
      vpcEndpointType: 'Interface',
      privateDnsEnabled: true,
      subnetIds: [privateSubnet.ref],
      securityGroupIds: [vpcEndpointSecurityGroup.attrGroupId],
    });
    ssmVpcEndpoint.cfnOptions.condition = createEndpoints;

    const ssmMessagesVpcEndpoint = new ec2.CfnVPCEndpoint(this, 'SSMMessagesVPCEndpoint', {
      vpcId: openClawVpc.ref,
      serviceName: Fn.sub('com.amazonaws.${AWS::Region}.ssmmessages'),
      vpcEndpointType: 'Interface',
      privateDnsEnabled: true,
      subnetIds: [privateSubnet.ref],
      securityGroupIds: [vpcEndpointSecurityGroup.attrGroupId],
    });
    ssmMessagesVpcEndpoint.cfnOptions.condition = createEndpoints;

    const ec2MessagesVpcEndpoint = new ec2.CfnVPCEndpoint(this, 'EC2MessagesVPCEndpoint', {
      vpcId: openClawVpc.ref,
      serviceName: Fn.sub('com.amazonaws.${AWS::Region}.ec2messages'),
      vpcEndpointType: 'Interface',
      privateDnsEnabled: true,
      subnetIds: [privateSubnet.ref],
      securityGroupIds: [vpcEndpointSecurityGroup.attrGroupId],
    });
    ec2MessagesVpcEndpoint.cfnOptions.condition = createEndpoints;

    const openClawInstanceRole = new iam.CfnRole(this, 'OpenClawInstanceRole', {
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

    const openClawInstanceProfile = new iam.CfnInstanceProfile(this, 'OpenClawInstanceProfile', {
      roles: [openClawInstanceRole.ref],
    });

    const retainedDataVolume = new ec2.CfnVolume(this, 'OpenClawDataVolumeRetained', {
      availabilityZone,
      size: 30,
      volumeType: 'gp3',
      encrypted: true,
      tags: nameTag(Fn.sub('${AWS::StackName}-data')),
    });
    retainedDataVolume.cfnOptions.condition = protectData;
    retainedDataVolume.applyRemovalPolicy(RemovalPolicy.RETAIN, { applyToUpdateReplacePolicy: true });

    const ephemeralDataVolume = new ec2.CfnVolume(this, 'OpenClawDataVolumeNotRetained', {
      availabilityZone,
      size: 30,
      volumeType: 'gp3',
      encrypted: true,
      tags: nameTag(Fn.sub('${AWS::StackName}-data')),
    });
    ephemeralDataVolume.cfnOptions.condition = deleteData;

    const userDataTemplate = readFileSync(join(__dirname, '..', 'userdata', 'openclaw-bootstrap.sh'), 'utf8');

    const openClawInstance = new ec2.CfnInstance(this, 'OpenClawInstance', {
      imageId: Fn.sub('{{resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/${Arch}/hvm/ebs-gp3/ami-id}}', {
        Arch: architecture,
      }),
      instanceType: instanceType.valueAsString,
      keyName: Token.asString(Fn.conditionIf(hasKeyPair.logicalId, keyPairName.valueAsString, Aws.NO_VALUE)),
      iamInstanceProfile: openClawInstanceProfile.ref,
      volumes: [
        {
          device: '/dev/sdf',
          volumeId: Token.asString(Fn.conditionIf(protectData.logicalId, retainedDataVolume.ref, ephemeralDataVolume.ref)),
        },
      ],
      networkInterfaces: [
        {
          associatePublicIpAddress: true,
          deviceIndex: '0',
          groupSet: [openClawSecurityGroup.attrGroupId],
          subnetId: publicSubnet.ref,
        },
      ],
      blockDeviceMappings: [
        {
          deviceName: '/dev/sda1',
          ebs: {
            volumeSize: 30,
            volumeType: 'gp3',
            deleteOnTermination: true,
          },
        },
      ],
      userData: Fn.base64(Fn.sub(userDataTemplate)),
      tags: nameTag(Fn.sub('${AWS::StackName}-instance')),
    });
    openClawInstance.addDependency(openClawInstanceProfile);
    openClawInstance.addDependency(publicRoute);
    openClawInstance.addDependency(subnetRouteTableAssociation);

    const openClawWaitCondition = new CfnWaitCondition(this, 'OpenClawWaitCondition', {
      handle: openClawWaitHandle.ref,
      timeout: '900',
      count: 1,
    });
    openClawWaitCondition.addDependency(openClawInstance);

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
      description: 'EC2 Instance ID (for reference)',
      value: openClawInstance.ref,
    });

    new CfnOutput(this, 'BedrockModel', {
      description: 'Bedrock model in use',
      value: openClawModel.valueAsString,
    });

    new CfnOutput(this, 'MonthlyCost', {
      description: 'Estimated monthly cost (USD)',
      value: Fn.sub(
        [
          'EC2 (${InstanceType}): ~$20-40 (Graviton instances 20% cheaper)',
          'EBS (30GB): ~$2.40',
          'VPC Endpoints: ${EndpointCost}',
          'Bedrock: Pay-per-use',
          'Total: ~${TotalCost}/month',
          'Note: Graviton (ARM64) instances offer better price-performance ratio',
        ].join('\n'),
        {
          EndpointCost: Token.asString(
            Fn.conditionIf(createEndpoints.logicalId, '~$29 ($0.01/hour x 5 endpoints)', '$0'),
          ),
          TotalCost: Token.asString(Fn.conditionIf(createEndpoints.logicalId, '$45-65', '$23-43')),
        },
      ),
    });

    new CfnOutput(this, 'InstanceArchitecture', {
      description: 'Instance architecture',
      value: architecture,
    });

    new CfnOutput(this, 'DataVolumeIdRetained', {
      condition: protectData,
      description: 'Data volume ID (retained on stack delete)',
      value: retainedDataVolume.ref,
    });

    new CfnOutput(this, 'DataVolumeIdNotRetained', {
      condition: deleteData,
      description: 'Data volume ID (deleted with stack)',
      value: ephemeralDataVolume.ref,
    });
  }
}

void App;
