import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ClawdbotBedrockAgentcoreStack } from '../lib/clawdbot-bedrock-agentcore-stack';

test('synthesizes the AgentCore stack resources', () => {
	const app = new App();
	const stack = new ClawdbotBedrockAgentcoreStack(app, 'TestStack');
	const template = Template.fromStack(stack);

	template.resourceCountIs('AWS::EC2::Instance', 1);
	template.resourceCountIs('AWS::IAM::Role', 2);
	template.resourceCountIs('AWS::EC2::VPCEndpoint', 4);
	template.resourceCountIs('AWS::BedrockAgentCore::Runtime', 1);

	template.hasResourceProperties('AWS::EC2::Instance', {
		KeyName: { Ref: 'KeyPairName' },
		IamInstanceProfile: { Ref: 'OpenClawInstanceProfile' },
	});

	template.hasOutput('AgentCoreRuntimeId', Match.objectLike({
		Description: 'AgentCore Runtime ID (if enabled)',
	}));
});
