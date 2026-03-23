import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ClawdbotBedrockMacStack } from '../lib/clawdbot-bedrock-mac-stack';

test('mac infrastructure resources are synthesized', () => {
	const app = new App();
	const stack = new ClawdbotBedrockMacStack(app, 'MyTestStack');
	const template = Template.fromStack(stack);

	template.resourceCountIs('AWS::EC2::Host', 1);
	template.resourceCountIs('AWS::EC2::VPC', 1);
	template.resourceCountIs('AWS::EC2::Instance', 1);
	template.hasOutput('DedicatedHostId', {});
	template.hasResourceProperties('AWS::EC2::SecurityGroup', {
		GroupDescription: 'OpenClaw Mac instance security group',
	});
});
