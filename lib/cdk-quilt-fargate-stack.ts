import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";

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

        const repositoryName = "package-engine"; // Use the name of the existing repo
        const hostedZoneId = "Z050530821I8SLJEKKYY6";
        const zoneName = "quilttest.com";
        const dnsName = `${repositoryName}.${zoneName}`;

        const vpc = this.createVpc();
        const cluster = this.createCluster(vpc);
        const repository = this.getEcrRepository(repositoryName);

        const taskDefinition = this.createTaskDefinition(
            repository,
        );
        const fargateService = this.createFargateService(
            cluster,
            taskDefinition,
            vpc
        );
        const nlb = this.createNetworkLoadBalancer(vpc, fargateService);
        const hostedZone = this.createHostedZone(hostedZoneId, zoneName);
        const certificate = this.createRoute53Certificate(hostedZone, dnsName);
        const api = this.createApiGateway(certificate, dnsName, nlb);
        this.configureRoute53(hostedZone, dnsName, api);

        // Outputs
        new cdk.CfnOutput(this, "ApiGatewayURL", { value: api.url });
        new cdk.CfnOutput(this, "CustomDomainURL", {
            value: `https://${dnsName}`,
        });
    }

    private createVpc(): ec2.Vpc {
        return new ec2.Vpc(this, "CdkQuiltFargateVpc", {
            maxAzs: 2,
            natGateways: 1,
        });
    }

    private createCluster(vpc: ec2.Vpc): ecs.Cluster {
        return new ecs.Cluster(this, "CdkQuiltFargateCluster", {
            vpc,
        });
    }

    private getEcrRepository(repositoryName: string): ecr.IRepository {
        return ecr.Repository.fromRepositoryName(
            this,
            "CdkQuiltFargateRepo",
            repositoryName,
        );
    }

    private createExecutionRole(): iam.Role {
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

        return executionRole;
    }

    private createLogGroup(): logs.LogGroup {
        return new logs.LogGroup(this, "CdkQuiltFargateLogGroup", {
            retention: this.containerConfig.logRetention,
        });
    }

    private createTaskDefinition(
        repository: ecr.IRepository,
    ): ecs.FargateTaskDefinition {
        const executionRole = this.createExecutionRole();
        const logGroup = this.createLogGroup();
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

        taskDefinition.addContainer("CdkQuiltFargateContainer", {
            image: ecs.ContainerImage.fromEcrRepository(
                repository,
                this.containerConfig.imageTag,
            ),
            portMappings: [
                {
                    containerPort: this.containerConfig.port,
                    hostPort: this.containerConfig.port,
                    protocol: ecs.Protocol.TCP,
                },
            ],
            logging: ecs.LogDrivers.awsLogs({
                logGroup,
                streamPrefix: "CdkQuiltFargate",
            }),
            // Add container health check
            healthCheck: {
                command: ["CMD-SHELL", "curl -f http://localhost:3000/health || exit 1"],
                interval: cdk.Duration.seconds(30),
                timeout: cdk.Duration.seconds(5),
                retries: 3,
                startPeriod: cdk.Duration.seconds(60),
            },
        });

        return taskDefinition;
    }

    private createFargateService(
        cluster: ecs.Cluster,
        taskDefinition: ecs.FargateTaskDefinition,
        vpc: ec2.Vpc,
    ): ecs.FargateService {
        // Create security group for the service
        const serviceSecurityGroup = new ec2.SecurityGroup(this, "ServiceSecurityGroup", {
            vpc,
            allowAllOutbound: true,
            description: "Security group for Fargate service",
        });

        // Allow inbound from VPC CIDR
        serviceSecurityGroup.addIngressRule(
            ec2.Peer.ipv4(vpc.vpcCidrBlock),
            ec2.Port.tcp(this.containerConfig.port),
            'Allow inbound from NLB'
        );

        return new ecs.FargateService(this, "CdkQuiltFargateService", {
            cluster,
            taskDefinition,
            assignPublicIp: true,
            deploymentController: {
                type: ecs.DeploymentControllerType.ECS,
            },
            // circuitBreaker: { rollback: false },
            securityGroups: [serviceSecurityGroup],
        });
    }

    private createNetworkLoadBalancer(
        vpc: ec2.Vpc,
        fargateService: ecs.FargateService,
    ): elbv2.NetworkLoadBalancer {
        const region = cdk.Stack.of(this).region;
        const elbAccountId = this.getELBAccountId(region);
        const bucket = new s3.Bucket(this, "CdkQuiltNLBLogBucket", {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            bucketName: `cdkquiltnlb-access-logs-${region}-${
                cdk.Stack.of(this).account
            }`,
        });

        bucket.addToResourcePolicy(
            new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                principals: [
                    new iam.AccountPrincipal(elbAccountId),
                    new iam.ServicePrincipal('logdelivery.elasticloadbalancing.amazonaws.com'),
                ],
                actions: ["s3:*"],
                resources: [bucket.arnForObjects("*")],
            }),
        );

        const nlb = new elbv2.NetworkLoadBalancer(this, "CdkQuiltNLB", {
            vpc,
            internetFacing: true,
            crossZoneEnabled: true,
            loadBalancerName: "quilt-nlb",
        });

        nlb.logAccessLogs(bucket);

        const listener = nlb.addListener("Listener", {
            port: this.containerConfig.port,
        });

        listener.addTargets("FargateService", {
            port: this.containerConfig.port,
            targets: [fargateService],
            healthCheck: {
                path: "/health", // Added health check path
                interval: cdk.Duration.seconds(30),
                timeout: cdk.Duration.seconds(5),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 2,
                // Added additional health check settings
                protocol: elbv2.Protocol.HTTP,
                port: String(this.containerConfig.port),
            },
        });

        return nlb;
    }

    private getELBAccountId(region: string): string {
        const elbAccountIds: { [key: string]: string } = {
            "us-east-1": "127311923021",
            "us-east-2": "033677994240",
            "us-west-1": "027434742980",
            "us-west-2": "797873946194",
            "af-south-1": "098369216593",
            "ap-east-1": "754344448648",
            "ap-southeast-3": "589379963580",
            "ap-south-1": "718504428378",
            "ap-northeast-3": "383597477331",
            "ap-northeast-2": "600734575887",
            "ap-southeast-1": "114774131450",
            "ap-southeast-2": "783225319266",
            "ap-northeast-1": "582318560864",
            "ca-central-1": "985666609251",
            "eu-central-1": "054676820928",
            "eu-west-1": "156460612806",
            "eu-west-2": "652711504416",
            "eu-south-1": "635631232127",
            "eu-west-3": "009996457667",
            "eu-north-1": "897822967062",
            "me-south-1": "076674570225",
            "sa-east-1": "507241528517",
        };

        const accountId = elbAccountIds[region];
        if (!accountId) {
            throw new Error(`No ELB account ID found for region ${region}`);
        }

        return accountId;
    }

    private createHostedZone(
        hostedZoneId: string,
        zoneName: string,
    ): route53.IHostedZone {
        const hostedZone = route53.HostedZone.fromHostedZoneAttributes(
            this,
            "CdkQuiltHostedZone",
            {
                hostedZoneId,
                zoneName,
            },
        );
        return hostedZone;
    }

    private createRoute53Certificate(
        hostedZone: route53.IHostedZone,
        dnsName: string,
    ): acm.Certificate {
        return new acm.Certificate(
            this,
            "ApiGatewayCertificate",
            {
                domainName: dnsName,
                validation: acm.CertificateValidation.fromDns(hostedZone),
            },
        );
    }

    private createApiGateway(
        certificate: acm.Certificate,
        dnsName: string,
        nlb: elbv2.NetworkLoadBalancer,
    ): apigateway.RestApi {
        const vpcLink = new apigateway.VpcLink(this, "ServiceVpcLink", {
            targets: [nlb],
        });

        const api = new apigateway.RestApi(this, "CdkQuiltApiGateway", {
            restApiName: "CdkQuiltService",
            description: "API Gateway for the Quilt Package Engine service",
            domainName: {
                domainName: dnsName,
                certificate: certificate,
            },
        });

        const apiResource = api.root.addResource("package-engine");
        apiResource.addMethod(
            "ANY",
            new apigateway.Integration({
                type: apigateway.IntegrationType.HTTP_PROXY,
                integrationHttpMethod: "ANY",
                options: {
                    connectionType: apigateway.ConnectionType.VPC_LINK,
                    vpcLink: vpcLink,
                },
                uri: `http://${nlb.loadBalancerDnsName}:${this.containerConfig.port}`,
            }),
        );

        return api;
    }

    private configureRoute53(
        hostedZone: route53.IHostedZone,
        repositoryName: string,
        api: apigateway.RestApi,
    ): void {
        new route53.ARecord(this, "CdkQuiltAliasRecord", {
            zone: hostedZone,
            recordName: repositoryName,
            target: route53.RecordTarget.fromAlias(
                new route53Targets.ApiGateway(api),
            ),
        });
    }
}
