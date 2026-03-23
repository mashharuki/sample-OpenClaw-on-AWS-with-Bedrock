import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ClawdbotBedrockAgentcoreMultitenancyStack } from '../lib/clawdbot-bedrock-agentcore-multitenancy-stack';

test('multitenancy infrastructure resources are synthesized', () => {
	const app = new App();
	const stack = new ClawdbotBedrockAgentcoreMultitenancyStack(app, 'MyTestStack');
	const template = Template.fromStack(stack);

	template.resourceCountIs('AWS::EC2::VPC', 1);
	template.resourceCountIs('AWS::ECR::Repository', 1);
	template.resourceCountIs('AWS::S3::Bucket', 1);
	template.resourceCountIs('AWS::EC2::Instance', 1);
	template.hasResourceProperties('AWS::SSM::Parameter', {
		Name: {
			'Fn::Sub': '/openclaw/${AWS::StackName}/auth-agent/system-prompt',
		},
	});
	template.hasOutput('MultitenancyEcrRepositoryUri', {});
});
