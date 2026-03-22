import {
  Aws,
  CfnCondition,
  CfnOutput,
  CfnParameter,
  CfnResource,
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
  'global.anthropic.claude-opus-4-5-20251101-v1:0',
  'global.anthropic.claude-haiku-4-5-20251001-v1:0',
  'global.anthropic.claude-sonnet-4-20250514-v1:0',
  'us.deepseek.r1-v1:0',
  'us.meta.llama3-3-70b-instruct-v1:0',
];

const INSTANCE_TYPES = [
  't4g.small',
  't4g.medium',
  't4g.large',
  't4g.xlarge',
  'c7g.large',
  'c7g.xlarge',
  't3.small',
  't3.medium',
  't3.large',
  'c5.xlarge',
];

function nameTag(value: string): CfnTag[] {
  return [{ key: 'Name', value }];
}

export class ClawdbotBedrockAgentcoreStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.templateOptions.description = 'OpenClaw - Complete One-Click Deployment with AgentCore Runtime (Gateway + AgentCore + ECR)';

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
      type: 'AWS::EC2::KeyPair::KeyName',
      description: 'EC2 key pair for emergency SSH access',
    });

    const allowedSshCidr = new CfnParameter(this, 'AllowedSSHCIDR', {
      type: 'String',
      default: '0.0.0.0/0',
      description: 'CIDR for SSH access (recommend SSM Session Manager, set to 127.0.0.1/32 to disable SSH)',
    });

    const createVpcEndpoints = new CfnParameter(this, 'CreateVPCEndpoints', {
      type: 'String',
      default: 'true',
      description: 'Create VPC endpoints for private network access to Bedrock and SSM',
      allowedValues: ['true', 'false'],
    });

    const enableAgentCore = new CfnParameter(this, 'EnableAgentCore', {
      type: 'String',
      default: 'true',
      description: 'Enable AgentCore Runtime for serverless agent execution',
      allowedValues: ['true', 'false'],
    });

    const createEndpoints = new CfnCondition(this, 'CreateEndpoints', {
      expression: Fn.conditionEquals(createVpcEndpoints.valueAsString, 'true'),
    });

    const allowSsh = new CfnCondition(this, 'AllowSSH', {
      expression: Fn.conditionNot(Fn.conditionEquals(allowedSshCidr.valueAsString, '127.0.0.1/32')),
    });

    const useGraviton = new CfnCondition(this, 'UseGraviton', {
      expression: Fn.conditionOr(
        Fn.conditionEquals(Fn.select(0, Fn.split('.', instanceType.valueAsString)), 't4g'),
        Fn.conditionEquals(Fn.select(0, Fn.split('.', instanceType.valueAsString)), 'c7g'),
        Fn.conditionEquals(Fn.select(0, Fn.split('.', instanceType.valueAsString)), 'm7g'),
      ),
    });

    const agentCoreEnabled = new CfnCondition(this, 'AgentCoreEnabled', {
      expression: Fn.conditionEquals(enableAgentCore.valueAsString, 'true'),
    });

    const availabilityZone = Fn.select(0, Fn.getAzs(''));
    const waitHandle = new CfnWaitConditionHandle(this, 'OpenClawWaitHandle');

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
      availabilityZone,
      tags: nameTag(Fn.sub('${AWS::StackName}-public-subnet')),
    });

    const privateSubnet = new ec2.CfnSubnet(this, 'PrivateSubnet', {
      vpcId: vpc.ref,
      cidrBlock: '10.0.2.0/24',
      availabilityZone,
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
      groupDescription: 'OpenClaw instance security group',
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
      ['BedrockRuntimeVPCEndpoint', 'bedrock-runtime'],
      ['SSMVPCEndpoint', 'ssm'],
      ['SSMMessagesVPCEndpoint', 'ssmmessages'],
      ['EC2MessagesVPCEndpoint', 'ec2messages'],
    ] as const;

    for (const [logicalId, serviceSuffix] of endpointSpecs) {
      const endpoint = new ec2.CfnVPCEndpoint(this, logicalId, {
        vpcId: vpc.ref,
        serviceName: Fn.sub(`com.amazonaws.\${AWS::Region}.${serviceSuffix}`),
        vpcEndpointType: 'Interface',
        privateDnsEnabled: true,
        subnetIds: [privateSubnet.ref],
        securityGroupIds: [endpointSecurityGroup.attrGroupId],
      });
      endpoint.cfnOptions.condition = createEndpoints;
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

    new iam.CfnPolicy(this, 'AgentCoreAccessPolicy', {
      policyName: 'AgentCoreAccessPolicy',
      roles: [instanceRole.ref],
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: [
              'bedrock-agent-runtime:InvokeAgentRuntime',
              'bedrock-agentcore:GetRuntime',
              'bedrock-agentcore:GetRuntimeEndpoint',
            ],
            Resource: '*',
          },
        ],
      },
    }).cfnOptions.condition = agentCoreEnabled;

    new iam.CfnPolicy(this, 'ECRAccessPolicy', {
      policyName: 'ECRAccessPolicy',
      roles: [instanceRole.ref],
      policyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Action: [
              'ecr:GetAuthorizationToken',
              'ecr:BatchCheckLayerAvailability',
              'ecr:GetDownloadUrlForLayer',
              'ecr:BatchGetImage',
            ],
            Resource: Fn.sub('arn:aws:ecr:${AWS::Region}:${AWS::AccountId}:repository/openclaw-agentcore-agent'),
          },
        ],
      },
    }).cfnOptions.condition = agentCoreEnabled;

    const instanceProfile = new iam.CfnInstanceProfile(this, 'OpenClawInstanceProfile', {
      roles: [instanceRole.ref],
    });

    const agentCoreExecutionRole = new iam.CfnRole(this, 'AgentCoreExecutionRole', {
      roleName: Fn.sub('${AWS::StackName}-agentcore-execution-role'),
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Sid: 'AssumeRolePolicy',
            Effect: 'Allow',
            Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
            Action: 'sts:AssumeRole',
            Condition: {
              StringEquals: { 'aws:SourceAccount': Aws.ACCOUNT_ID },
              ArnLike: { 'aws:SourceArn': Fn.sub('arn:aws:bedrock-agentcore:${AWS::Region}:${AWS::AccountId}:*') },
            },
          },
        ],
      },
      managedPolicyArns: ['arn:aws:iam::aws:policy/BedrockAgentCoreFullAccess'],
      policies: [
        {
          policyName: 'AgentCoreExecutionPolicy',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Sid: 'ECRImageAccess',
                Effect: 'Allow',
                Action: ['ecr:BatchGetImage', 'ecr:GetDownloadUrlForLayer', 'ecr:BatchCheckLayerAvailability'],
                Resource: Fn.sub('arn:aws:ecr:${AWS::Region}:${AWS::AccountId}:repository/openclaw-agentcore-agent'),
              },
              {
                Sid: 'ECRTokenAccess',
                Effect: 'Allow',
                Action: ['ecr:GetAuthorizationToken'],
                Resource: '*',
              },
              {
                Sid: 'CloudWatchLogs',
                Effect: 'Allow',
                Action: [
                  'logs:DescribeLogStreams',
                  'logs:CreateLogGroup',
                  'logs:DescribeLogGroups',
                  'logs:CreateLogStream',
                  'logs:PutLogEvents',
                ],
                Resource: '*',
              },
              {
                Sid: 'BedrockModelInvocation',
                Effect: 'Allow',
                Action: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
                Resource: '*',
              },
            ],
          },
        },
      ],
      tags: nameTag(Fn.sub('${AWS::StackName}-agentcore-execution-role')),
    });
    agentCoreExecutionRole.cfnOptions.condition = agentCoreEnabled;

    const agentCoreRuntime = new CfnResource(this, 'AgentCoreRuntime', {
      type: 'AWS::BedrockAgentCore::Runtime',
      properties: {
        AgentRuntimeName: Fn.join('_', [Fn.join('_', Fn.split('-', Aws.STACK_NAME)), 'agentcore', 'runtime']),
        AgentRuntimeArtifact: {
          ContainerConfiguration: {
            ContainerUri: Fn.sub('${AWS::AccountId}.dkr.ecr.${AWS::Region}.amazonaws.com/openclaw-agentcore-agent:latest'),
          },
        },
        RoleArn: agentCoreExecutionRole.attrArn,
        NetworkConfiguration: {
          NetworkMode: 'PUBLIC',
        },
        Description: Fn.sub('OpenClaw AI assistant serverless runtime for ${AWS::StackName}'),
      },
    });
    agentCoreRuntime.cfnOptions.condition = agentCoreEnabled;
    agentCoreRuntime.addDependency(agentCoreExecutionRole);

    const userDataTemplate = readFileSync(join(__dirname, '..', 'userdata', 'openclaw-agentcore-bootstrap.sh'), 'utf8');

    const instance = new ec2.CfnInstance(this, 'OpenClawInstance', {
      imageId: Token.asString(
        Fn.conditionIf(
          useGraviton.logicalId,
          Fn.sub('{{resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id}}'),
          Fn.sub('{{resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id}}'),
        ),
      ),
      instanceType: instanceType.valueAsString,
      keyName: keyPairName.valueAsString,
      iamInstanceProfile: instanceProfile.ref,
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
            volumeSize: 30,
            volumeType: 'gp3',
            deleteOnTermination: true,
          },
        },
      ],
      userData: Fn.base64(Fn.sub(userDataTemplate)),
      tags: nameTag(Fn.sub('${AWS::StackName}-gateway')),
    });
    instance.addDependency(instanceProfile);
    instance.addDependency(publicRoute);
    instance.addDependency(subnetRouteTableAssociation);

    const waitCondition = new CfnWaitCondition(this, 'OpenClawWaitCondition', {
      handle: waitHandle.ref,
      timeout: '900',
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
      description: 'STEP 3: Get Gateway Token',
      value: Fn.sub(
        'aws ssm get-parameter --name "/openclaw/${AWS::StackName}/gateway-token" --region ${AWS::Region} --with-decryption --query \'Parameter.Value\' --output text',
      ),
    });

    new CfnOutput(this, 'Step4AccessURL', {
      description: 'STEP 4: Open in browser (replace <token> with value from Step 3)',
      value: 'http://localhost:18789/?token=<token>',
    });

    new CfnOutput(this, 'Step5StartChatting', {
      description: 'STEP 5: Start using OpenClaw!',
      value: 'Connect WhatsApp, Telegram, Discord. See README: https://github.com/Vivek0712/OpenClaw-on-AWS-with-Bedrock',
    });

    new CfnOutput(this, 'InstanceId', {
      description: 'EC2 Instance ID (for reference)',
      value: instance.ref,
    });

    new CfnOutput(this, 'BedrockModel', {
      description: 'Bedrock model in use',
      value: openClawModel.valueAsString,
    });

    new CfnOutput(this, 'AgentCoreRuntimeId', {
      condition: agentCoreEnabled,
      description: 'AgentCore Runtime ID (if enabled)',
      value: agentCoreRuntime.getAtt('AgentRuntimeId').toString(),
    });

    new CfnOutput(this, 'ECRRepositoryUri', {
      condition: agentCoreEnabled,
      description: 'ECR Repository URI for agent container (build and push container to this URI)',
      value: Fn.sub('${AWS::AccountId}.dkr.ecr.${AWS::Region}.amazonaws.com/openclaw-agentcore-agent:latest'),
    });

    new CfnOutput(this, 'MonthlyCost', {
      description: 'Estimated monthly cost (USD)',
      value: Fn.sub(
        [
          'EC2 (${InstanceType}): ~$30-40',
          'EBS (30GB): ~$2.40',
          'VPC Endpoints: ${EndpointCost}',
          'AgentCore Runtime: ${AgentCoreCost}',
          'Bedrock: Pay-per-use',
          'Total: ~${TotalCost}/month${AgentCoreSuffix}',
        ].join('\n'),
        {
          EndpointCost: Token.asString(Fn.conditionIf(createEndpoints.logicalId, '~$22 ($0.01/hour per endpoint)', '$0')),
          AgentCoreCost: Token.asString(Fn.conditionIf(agentCoreEnabled.logicalId, 'Pay-per-use (serverless)', 'N/A')),
          TotalCost: Token.asString(Fn.conditionIf(createEndpoints.logicalId, '$55-65', '$33-43')),
          AgentCoreSuffix: Token.asString(Fn.conditionIf(agentCoreEnabled.logicalId, ' + AgentCore usage', '')),
        },
      ),
    });
  }
}
