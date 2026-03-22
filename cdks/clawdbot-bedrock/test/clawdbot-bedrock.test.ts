import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ClawdbotBedrockStack } from '../lib/clawdbot-bedrock-stack';

test('synthesizes the Linux OpenClaw infrastructure', () => {
	const app = new App();
	const stack = new ClawdbotBedrockStack(app, 'TestStack');
	const template = Template.fromStack(stack);

	template.resourceCountIs('AWS::EC2::Instance', 1);
	template.resourceCountIs('AWS::IAM::Role', 1);
	template.resourceCountIs('AWS::CloudFormation::WaitCondition', 1);
	template.resourceCountIs('AWS::EC2::VPCEndpoint', 5);

	template.hasResourceProperties('AWS::EC2::Instance', {
		InstanceType: { Ref: 'InstanceType' },
		IamInstanceProfile: { Ref: 'OpenClawInstanceProfile' },
		NetworkInterfaces: Match.arrayWith([
			Match.objectLike({
				AssociatePublicIpAddress: true,
				SubnetId: { Ref: 'PublicSubnet' },
			}),
		]),
	});

	template.hasOutput('InstanceArchitecture', Match.objectLike({
		Description: 'Instance architecture',
	}));
});
