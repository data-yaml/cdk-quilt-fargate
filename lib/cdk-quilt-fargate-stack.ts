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
                },
            ],
            logging: ecs.LogDrivers.awsLogs({
                logGroup,
                streamPrefix: "CdkQuiltFargate",
            }),
        });

        return taskDefinition;
    }

    private createFargateService(
        cluster: ecs.Cluster,
        taskDefinition: ecs.FargateTaskDefinition,
    ): ecs.FargateService {
        return new ecs.FargateService(this, "CdkQuiltFargateService", {
            cluster,
            taskDefinition,
            assignPublicIp: true,
        });
    }

    private createNetworkLoadBalancer(
        vpc: ec2.Vpc,
        fargateService: ecs.FargateService,
    ): elbv2.NetworkLoadBalancer {
        const nlb = new elbv2.NetworkLoadBalancer(this, "CdkQuiltNLB", {
            vpc,
            internetFacing: true,
            crossZoneEnabled: true,
            loadBalancerName: "quilt-nlb",
        });
        const listener = nlb.addListener("Listener", {
            port: this.containerConfig.port,
        });
        listener.addTargets("FargateService", {
            port: this.containerConfig.port,
            targets: [fargateService],
        });
        return nlb;
    }

    private createHostedZone(hostedZoneId: string, zoneName: string): route53.IHostedZone {
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
