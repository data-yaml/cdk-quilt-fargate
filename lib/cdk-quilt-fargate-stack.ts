import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as logs from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

interface ContainerConfig {
    port: number;
    cpu: number;
    memory: number;
    imageTag: string;
    logRetention: logs.RetentionDays;
}

export class CdkQuiltFargateStack extends cdk.Stack {
    private readonly containerConfig: ContainerConfig = {
        port: 3000,
        cpu: 256,
        memory: 512,
        imageTag: "latest",
        logRetention: logs.RetentionDays.ONE_WEEK,
    };

    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        // Variables
        const region = this.region; // Use the region from the stack context
        const repositoryName = "package-engine"; // Use the name of the existing repo
        const imageTag = "latest"; // Replace with your desired image tag
        const hostedZoneId = "Z050530821I8SLJEKKYY6";
        const dnsName = "package-engine.quilttest.com";

        // 1. Create a VPC
        const vpc = new ec2.Vpc(this, "CdkQuiltFargateVpc", {
            maxAzs: 2,
            natGateways: 1,
        });

        // 2. Create an ECS Cluster
        const cluster = new ecs.Cluster(this, "CdkQuiltFargateCluster", {
            vpc,
        });

        // 3. Reference an Existing ECR Repository
        const repository = ecr.Repository.fromRepositoryName(
            this,
            "CdkQuiltFargateRepo",
            repositoryName,
        );

        // 4. Create an IAM Role for Fargate Task Execution
        const executionRole = new iam.Role(
            this,
            "CdkQuiltFargateExecutionRole",
            {
                assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
            },
        );

        executionRole.addManagedPolicy(
            iam.ManagedPolicy.fromAwsManagedPolicyName(
                "service-role/AmazonECSTaskExecutionRolePolicy",
            ),
        );

        // Create log group with configured retention
        const logGroup = new logs.LogGroup(this, "CdkQuiltFargateLogGroup", {
            retention: this.containerConfig.logRetention,
        });

        // Create task definition with configured resources
        const taskDefinition = new ecs.FargateTaskDefinition(
            this,
            "CdkQuiltFargateTaskDef",
            {
                memoryLimitMiB: this.containerConfig.memory,
                cpu: this.containerConfig.cpu,
                executionRole,
                runtimePlatform: {
                    cpuArchitecture: ecs.CpuArchitecture.ARM64,
                },
            },
        );

        // Configure container with logging
        const container = taskDefinition.addContainer(
            "CdkQuiltFargateContainer",
            {
                image: ecs.ContainerImage.fromEcrRepository(
                    repository,
                    this.containerConfig.imageTag,
                ),
                portMappings: [{
                    containerPort: this.containerConfig.port,
                    hostPort: this.containerConfig.port,
                    protocol: ecs.Protocol.TCP,
                }],
                logging: ecs.LogDrivers.awsLogs({
                    logGroup,
                    streamPrefix: "CdkQuiltFargate",
                }),
            },
        );

        // Create Fargate service with ALB
        const fargateService = this.createFargateService(
            cluster,
            taskDefinition,
        );

        // 7. Configure Route 53 DNS
        const hostedZone = route53.HostedZone.fromHostedZoneAttributes(
            this,
            "CdkQuiltHostedZone",
            {
                hostedZoneId: hostedZoneId,
                zoneName: dnsName.split(".").slice(1).join("."),
            },
        );

        new route53.ARecord(this, "CdkQuiltAliasRecord", {
            zone: hostedZone,
            recordName: dnsName.split(".")[0],
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
        new cdk.CfnOutput(this, "ServiceURL", { value: `http://${dnsName}` });
    }

    private createFargateService(
        cluster: ecs.ICluster,
        taskDefinition: ecs.FargateTaskDefinition,
    ): ecs_patterns.ApplicationLoadBalancedFargateService {
        return new ecs_patterns.ApplicationLoadBalancedFargateService(
            this,
            "CdkQuiltFargateService",
            {
                cluster,
                taskDefinition,
                desiredCount: 1,
                publicLoadBalancer: true,
                listenerPort: 80,
                deploymentController: {
                    type: ecs.DeploymentControllerType.ECS,
                },
                circuitBreaker: { rollback: true },
            },
        );
    }
}
