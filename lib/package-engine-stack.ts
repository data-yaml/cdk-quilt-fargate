import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";

export class PackageEngineStack extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // Configuration
        const ECR_REPO = "730278974607.dkr.ecr.us-east-1.amazonaws.com";
        const ECR_IMAGE = "quiltdata/services/package-engine";
        const IMAGE_HASH = "latest";
        const HOSTED_ZONE_ID = "Z050530821I8SLJEKKYY6";
        const DNS_NAME = "package-engine.quiltdata.com";

        // 1. Create a VPC
        const vpc = new ec2.Vpc(this, "PackageEngineVpc", {
            maxAzs: 2,
            natGateways: 1,
        });

        // 2. Create an ECS Cluster
        const cluster = new ecs.Cluster(this, "PackageEngineCluster", {
            vpc,
        });

        // 3. Create a Fargate Task Definition
        const taskDefinition = new ecs.FargateTaskDefinition(
            this,
            "PackageEngineTaskDef",
            {
                memoryLimitMiB: 512,
                cpu: 256,
            },
        );

        taskDefinition.addContainer("PackageEngineContainer", {
            image: ecs.ContainerImage.fromEcrRepository(
                new ecr.Repository(this, "PackageEngineRepository", {
                    repositoryName: ECR_IMAGE,
                }),
                IMAGE_HASH,
            ),
            portMappings: [{ containerPort: 80 }],
        });

        // 4. Create an ECS Service with Application Load Balancer
        const fargateService = new ecs_patterns
            .ApplicationLoadBalancedFargateService(
            this,
            "PackageEngineService",
            {
                cluster,
                taskDefinition,
                desiredCount: 1,
                publicLoadBalancer: true,
            },
        );

        // 5. Configure Route 53 DNS
        const hostedZone = route53.HostedZone.fromHostedZoneAttributes(
            this,
            "HostedZone",
            {
                hostedZoneId: HOSTED_ZONE_ID,
                zoneName: DNS_NAME.split(".").slice(1).join("."),
            },
        );

        new route53.ARecord(this, "PackageEngineAliasRecord", {
            zone: hostedZone,
            recordName: DNS_NAME.split(".")[0],
            target: route53.RecordTarget.fromAlias(
                new route53Targets.LoadBalancerTarget(
                    fargateService.loadBalancer,
                ),
            ),
        });

        // Output relevant values
        new cdk.CfnOutput(this, "LoadBalancerDNS", {
            value: fargateService.loadBalancer.loadBalancerDnsName,
        });
        new cdk.CfnOutput(this, "ServiceURL", { value: `http://${DNS_NAME}` });
    }
}
