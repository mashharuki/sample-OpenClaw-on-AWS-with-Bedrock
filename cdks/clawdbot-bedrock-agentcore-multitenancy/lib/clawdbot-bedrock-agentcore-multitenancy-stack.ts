import {
  Aws,
  BootstraplessSynthesizer,
  CfnCondition,
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
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
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

function exportOutput(scope: Construct, id: string, description: string, value: string): void {
  new CfnOutput(scope, id, {
    description,
    value,
  });
}

export class ClawdbotBedrockAgentcoreMultitenancyStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, {
      ...props,
      analyticsReporting: false,
      synthesizer: props?.synthesizer ?? new BootstraplessSynthesizer(),
    });

    this.templateOptions.templateFormatVersion = '2010-09-09';
    this.templateOptions.description =
      'OpenClaw Multi-Tenant Platform - Infrastructure (EC2 Gateway + ECR + SSM + CloudWatch). AgentCore Runtime is created separately after pushing the container image.';
    this.templateOptions.metadata = {
      'AWS::CloudFormation::Interface': {
        ParameterGroups: [
          {
            Label: { default: 'Basic Configuration' },
            Parameters: ['OpenClawModel', 'InstanceType', 'KeyPairName'],
          },
          {
            Label: { default: 'Network Configuration' },
            Parameters: ['CreateVPCEndpoints', 'AllowedSSHCIDR'],
          },
          {
            Label: { default: 'Multi-Tenancy Configuration' },
            Parameters: ['MaxConcurrentTenants', 'BedrockModelId', 'EnableAgentCoreMemory', 'AuthAgentChannelType'],
          },
        ],
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
      default: '',
      description: 'EC2 key pair for emergency SSH access (leave empty for SSM-only access)',
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

    const maxConcurrentTenants = new CfnParameter(this, 'MaxConcurrentTenants', {
      type: 'Number',
      default: 50,
      description: 'Maximum number of concurrent tenants supported by the platform',
      minValue: 1,
      maxValue: 1000,
    });

    const bedrockModelId = new CfnParameter(this, 'BedrockModelId', {
      type: 'String',
      default: 'global.amazon.nova-2-lite-v1:0',
      description: 'Bedrock model ID used by the Agent Container inside AgentCore Runtime',
    });

    const enableAgentCoreMemory = new CfnParameter(this, 'EnableAgentCoreMemory', {
      type: 'String',
      default: 'false',
      description: 'Enable AgentCore Memory cloud persistence layer (optional, adds cost). Configure in agent-container/memory.py.',
      allowedValues: ['true', 'false'],
    });

    const authAgentChannelType = new CfnParameter(this, 'AuthAgentChannelType', {
      type: 'String',
      default: 'whatsapp',
      description: 'Messaging channel used by Authorization_Agent to notify Human_Approver',
      allowedValues: ['whatsapp', 'telegram'],
    });

    const createEndpoints = new CfnCondition(this, 'CreateEndpoints', {
      expression: Fn.conditionEquals(createVpcEndpoints.valueAsString, 'true'),
    });

    const allowSsh = new CfnCondition(this, 'AllowSSH', {
      expression: Fn.conditionNot(Fn.conditionEquals(allowedSshCidr.valueAsString, '127.0.0.1/32')),
    });

    const hasKeyPair = new CfnCondition(this, 'HasKeyPair', {
      expression: Fn.conditionNot(Fn.conditionEquals(keyPairName.valueAsString, '')),
    });

    const useGraviton = new CfnCondition(this, 'UseGraviton', {
      expression: Fn.conditionOr(
        Fn.conditionEquals(Fn.select(0, Fn.split('.', instanceType.valueAsString)), 't4g'),
        Fn.conditionEquals(Fn.select(0, Fn.split('.', instanceType.valueAsString)), 'c7g'),
        Fn.conditionEquals(Fn.select(0, Fn.split('.', instanceType.valueAsString)), 'm7g'),
      ),
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

    for (const [logicalId, serviceSuffix] of [
      ['BedrockRuntimeVPCEndpoint', 'bedrock-runtime'],
      ['SSMVPCEndpoint', 'ssm'],
      ['SSMMessagesVPCEndpoint', 'ssmmessages'],
      ['EC2MessagesVPCEndpoint', 'ec2messages'],
    ] as const) {
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

    const tenantWorkspaceBucket = new s3.CfnBucket(this, 'TenantWorkspaceBucket', {
      bucketName: Fn.sub('openclaw-tenants-${AWS::AccountId}'),
      publicAccessBlockConfiguration: {
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      },
      versioningConfiguration: {
        status: 'Enabled',
      },
      lifecycleConfiguration: {
        rules: [
          {
            id: 'CleanupOldVersions',
            status: 'Enabled',
            noncurrentVersionExpiration: {
              noncurrentDays: 30,
            },
          },
        ],
      },
      tags: [
        { key: 'Project', value: 'openclaw' },
        { key: 'Feature', value: 'multitenancy' },
      ],
    });

    const ecrRepository = new ecr.CfnRepository(this, 'MultitenancyEcrRepository', {
      repositoryName: Fn.sub('${AWS::StackName}-multitenancy-agent'),
      imageScanningConfiguration: { scanOnPush: true },
      imageTagMutability: 'MUTABLE',
      lifecyclePolicy: {
        lifecyclePolicyText: JSON.stringify(
          {
            rules: [
              {
                rulePriority: 1,
                description: 'Keep last 10 images',
                selection: {
                  tagStatus: 'any',
                  countType: 'imageCountMoreThan',
                  countNumber: 10,
                },
                action: { type: 'expire' },
              },
            ],
          },
          null,
          2,
        ),
      },
      tags: [
        { key: 'Project', value: 'openclaw' },
        { key: 'Feature', value: 'multitenancy' },
        { key: 'Name', value: Fn.sub('${AWS::StackName}-multitenancy-agent') },
      ],
    });

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
        {
          policyName: 'AgentCoreAccessPolicy',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:GetAgentRuntime'],
                Resource: '*',
              },
            ],
          },
        },
        {
          policyName: 'ECRAccessPolicy',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Sid: 'ECRToken',
                Effect: 'Allow',
                Action: ['ecr:GetAuthorizationToken'],
                Resource: '*',
              },
              {
                Sid: 'ECRPullPush',
                Effect: 'Allow',
                Action: [
                  'ecr:BatchCheckLayerAvailability',
                  'ecr:GetDownloadUrlForLayer',
                  'ecr:BatchGetImage',
                  'ecr:PutImage',
                  'ecr:InitiateLayerUpload',
                  'ecr:UploadLayerPart',
                  'ecr:CompleteLayerUpload',
                ],
                Resource: [ecrRepository.attrArn],
              },
            ],
          },
        },
        {
          policyName: 'S3WorkspacePolicy',
          policyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Action: ['s3:GetObject', 's3:PutObject', 's3:ListBucket'],
                Resource: [tenantWorkspaceBucket.attrArn, Fn.sub('${TenantWorkspaceBucket.Arn}/*')],
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

    const agentContainerExecutionRole = new iam.CfnRole(this, 'AgentContainerExecutionRole', {
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
              StringEquals: {
                'aws:SourceAccount': Aws.ACCOUNT_ID,
              },
              ArnLike: {
                'aws:SourceArn': Fn.sub('arn:aws:bedrock-agentcore:${AWS::Region}:${AWS::AccountId}:*'),
              },
            },
          },
        ],
      },
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
                Resource: [ecrRepository.attrArn],
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
              {
                Sid: 'SSMParameterAccess',
                Effect: 'Allow',
                Action: ['ssm:GetParameter', 'ssm:PutParameter'],
                Resource: Fn.sub('arn:aws:ssm:${AWS::Region}:${AWS::AccountId}:parameter/openclaw/${AWS::StackName}/*'),
              },
              {
                Sid: 'BedrockAgentCoreRuntimeInvoke',
                Effect: 'Allow',
                Action: ['bedrock-agentcore:InvokeAgentRuntime'],
                Resource: '*',
              },
              {
                Sid: 'CloudWatchMetrics',
                Effect: 'Allow',
                Action: ['cloudwatch:PutMetricData'],
                Resource: '*',
                Condition: {
                  StringEquals: {
                    'cloudwatch:namespace': 'OpenClaw/AgentContainer',
                  },
                },
              },
              {
                Sid: 'S3WorkspaceAccess',
                Effect: 'Allow',
                Action: ['s3:GetObject', 's3:PutObject', 's3:ListBucket', 's3:DeleteObject'],
                Resource: [tenantWorkspaceBucket.attrArn, Fn.sub('${TenantWorkspaceBucket.Arn}/*')],
              },
            ],
          },
        },
      ],
      tags: [
        { key: 'Name', value: Fn.sub('${AWS::StackName}-agentcore-execution-role') },
        { key: 'Project', value: 'openclaw' },
        { key: 'Feature', value: 'multitenancy' },
      ],
    });

    new ssm.CfnParameter(this, 'AuthAgentSystemPromptParam', {
      name: Fn.sub('/openclaw/${AWS::StackName}/auth-agent/system-prompt'),
      type: 'String',
      value: [
        'You are a specialized permission approval AI assistant named Authorization Agent.',
        'Your sole responsibility is to handle permission requests from other AI Agents',
        'and assist human administrators in making informed approval decisions.',
        '',
        'Core principle: NEVER auto-approve any request. Always wait for explicit human reply.',
        '',
        'When you receive a Permission_Request:',
        '1. Parse: extract tenant_id, resource, reason, duration_type',
        '2. Assess risk: low (web_search, read-only), medium (file_write, code_execution), high (shell, persistent)',
        '3. Format approval notification with applicant, resource, reason, risk level, options',
        '4. Start 30-minute timer and wait for Human_Approver reply',
        '',
        'On approval (temporary): issue Approval_Token via AgentCore Identity (max 24 hours)',
        'On approval (persistent): update Cedar Policy in SSM for tenant',
        'On rejection: notify Agent Container with reason',
        'On timeout (30 min): auto-reject and notify Agent Container',
        '',
        'For /pending approvals: list all pending requests with wait time and remaining timeout.',
        '',
        'Log ALL decisions to CloudWatch Logs.',
      ].join('\n'),
      description: 'Authorization_Agent system prompt - update directly in SSM without redeployment',
      tags: {
        Project: 'openclaw',
        Feature: 'multitenancy',
      },
    });

    new ssm.CfnParameter(this, 'TenantDefaultPermissionsParam', {
      name: Fn.sub('/openclaw/${AWS::StackName}/tenants/default/permissions'),
      type: 'String',
      value: '{"profile":"basic","tools":["web_search"],"data_permissions":{}}',
      description: 'Default tenant permission profile (basic) - used when no tenant-specific profile exists',
      tags: {
        Project: 'openclaw',
        Feature: 'multitenancy',
      },
    });

    const agentLogsGroup = new logs.CfnLogGroup(this, 'AgentLogsGroup', {
      logGroupName: Fn.sub('/openclaw/${AWS::StackName}/agents'),
      retentionInDays: 30,
      tags: [
        { key: 'Project', value: 'openclaw' },
        { key: 'Feature', value: 'multitenancy' },
      ],
    });

    const userDataTemplate = readFileSync(
      join(__dirname, '..', 'userdata', 'openclaw-agentcore-multitenancy-bootstrap.sh'),
      'utf8',
    );

    const instance = new ec2.CfnInstance(this, 'OpenClawInstance', {
      imageId: Token.asString(
        Fn.conditionIf(
          useGraviton.logicalId,
          Fn.sub('{{resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id}}'),
          Fn.sub('{{resolve:ssm:/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id}}'),
        ),
      ),
      instanceType: instanceType.valueAsString,
      keyName: Token.asString(Fn.conditionIf(hasKeyPair.logicalId, keyPairName.valueAsString, Aws.NO_VALUE)),
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

    exportOutput(
      this,
      'MultitenancyEcrRepositoryUri',
      'ECR Repository URI for multi-tenancy agent container (build and push your Agent Container image here)',
      ecrRepository.attrRepositoryUri,
    );

    exportOutput(
      this,
      'AgentContainerExecutionRoleArn',
      "ARN of the IAM role the Agent Container runs as inside AgentCore Runtime — pass this to 'aws bedrock-agentcore create-agent-runtime --role-arn'",
      agentContainerExecutionRole.attrArn,
    );

    exportOutput(
      this,
      'TenantWorkspaceBucketName',
      'S3 bucket for tenant workspaces (SOUL.md, MEMORY.md, skills, etc.)',
      tenantWorkspaceBucket.ref,
    );

    exportOutput(
      this,
      'GatewayEndpoint',
      'EC2 Gateway public endpoint (openclaw gateway on port 18789)',
      Fn.sub('http://${OpenClawInstance.PublicDnsName}:18789'),
    );

    exportOutput(
      this,
      'AuthAgentSystemPromptPath',
      'SSM path for Authorization_Agent system prompt (update without redeployment)',
      Fn.sub('/openclaw/${AWS::StackName}/auth-agent/system-prompt'),
    );

    exportOutput(
      this,
      'TenantDefaultPermissionsPath',
      'SSM path for default tenant permissions (basic profile)',
      Fn.sub('/openclaw/${AWS::StackName}/tenants/default/permissions'),
    );

    exportOutput(
      this,
      'AgentLogsGroupName',
      'CloudWatch Log Group for agent invocations (use tenant_{tenant_id} stream prefix)',
      agentLogsGroup.ref,
    );

    new CfnOutput(this, 'MonthlyCost', {
      description: 'Estimated monthly cost (USD)',
      value: Fn.sub(
        [
          'EC2 (${InstanceType}): ~$30-40',
          'EBS (30GB): ~$2.40',
          'VPC Endpoints: ${EndpointCost}',
          'ECR (multitenancy): ~$0.10/GB/month storage',
          'CloudWatch Logs: Pay-per-use',
          'AgentCore Runtime: Pay-per-invocation (created separately)',
          'Bedrock: Pay-per-use',
          'Total: ~${TotalCost}/month + usage',
        ].join('\n'),
        {
          EndpointCost: Token.asString(Fn.conditionIf(createEndpoints.logicalId, '~$22 ($0.01/hour per endpoint)', '$0')),
          TotalCost: Token.asString(Fn.conditionIf(createEndpoints.logicalId, '$55-65', '$33-43')),
        },
      ),
    });

    void openClawModel;
    void maxConcurrentTenants;
    void bedrockModelId;
    void enableAgentCoreMemory;
    void authAgentChannelType;
  }
}
