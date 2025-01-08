import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs_patterns from "aws-cdk-lib/aws-ecs-patterns";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";

export class CdkQuiltFargateStack extends cdk.Stack {
  constructor(scope: cdk.App, id: string, props?: cdk.StackProps) {
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
    const repository = ecr.Repository.fromRepositoryName(this, "CdkQuiltFargateRepo", repositoryName);

    // 4. Create an IAM Role for Fargate Task Execution
    const executionRole = new iam.Role(this, "CdkQuiltFargateExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
    });

    executionRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy")
    );

    // 5. Create a Fargate Task Definition
    const taskDefinition = new ecs.FargateTaskDefinition(this, "CdkQuiltFargateTaskDef", {
      memoryLimitMiB: 512,
      cpu: 256,
      executionRole,
    });

    taskDefinition.addContainer("CdkQuiltFargateContainer", {
      image: ecs.ContainerImage.fromEcrRepository(repository, imageTag),
      portMappings: [{ containerPort: 3000 }],
    });

    // 6. Create an ECS Service with Application Load Balancer
    const fargateService = new ecs_patterns.ApplicationLoadBalancedFargateService(this, "CdkQuiltFargateService", {
      cluster,
      taskDefinition,
      desiredCount: 1,
      publicLoadBalancer: true,
    });

    // 7. Configure Route 53 DNS
    const hostedZone = route53.HostedZone.fromHostedZoneAttributes(this, "CdkQuiltHostedZone", {
      hostedZoneId: hostedZoneId,
      zoneName: dnsName.split(".").slice(1).join("."),
    });

    new route53.ARecord(this, "CdkQuiltAliasRecord", {
      zone: hostedZone,
      recordName: dnsName.split(".")[0],
      target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(fargateService.loadBalancer)),
    });

    // Output relevant values
    new cdk.CfnOutput(this, "LoadBalancerDNS", { value: fargateService.loadBalancer.loadBalancerDnsName });
    new cdk.CfnOutput(this, "ServiceURL", { value: `http://${dnsName}` });
  }
}
