import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as logs from "aws-cdk-lib/aws-logs";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
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
        const dnsName = "package-engine.quilttest.com";

        const cluster = this.createCluster();
        const repository = this.getEcrRepository(repositoryName);
        const executionRole = this.createExecutionRole();
        const logGroup = this.createLogGroup();
        const taskDefinition = this.createTaskDefinition(repository, executionRole, logGroup);
        const fargateService = this.createFargateService(cluster, taskDefinition);
        const api = this.createApiGateway(fargateService, dnsName);
        this.configureRoute53(hostedZoneId, dnsName, api);

        // Outputs
        new cdk.CfnOutput(this, "ApiGatewayURL", { value: api.url });
        new cdk.CfnOutput(this, "CustomDomainURL", { value: `https://${dnsName}` });
    }

    private createCluster(): ecs.Cluster {
        const vpc = new ec2.Vpc(this, "CdkQuiltFargateVpc", {
            maxAzs: 2,
            natGateways: 1,
        });

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
        executionRole: iam.Role,
        logGroup: logs.LogGroup,
    ): ecs.FargateTaskDefinition {
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

    private createApiGateway(fargateService: ecs.FargateService, dnsName: string): apigateway.RestApi {
        const api = new apigateway.RestApi(this, "CdkQuiltApiGateway", {
            restApiName: "CdkQuiltService",
            description: "API Gateway for the Quilt Package Engine service.",
            domainName: {
                domainName: dnsName,
                certificate: new acm.Certificate(this, 'ApiGatewayCertificate', {
                    domainName: dnsName,
                    validation: acm.CertificateValidation.fromDns(),
                }),
            },
        });

        const fargateEndpoint = `http://${fargateService.serviceName}.public-ip.amazonaws.com:${this.containerConfig.port}`;

        // Add a resource for /package-engine
        const apiResource = api.root.addResource("package-engine");
        apiResource.addMethod(
            "ANY",
            new apigateway.HttpIntegration(fargateEndpoint, {
                httpMethod: "ANY",
            })
        );
        
        return api;
    }

    private configureRoute53(hostedZoneId: string, dnsName: string, api: apigateway.RestApi): void {
        const hostedZone = route53.HostedZone.fromHostedZoneAttributes(
            this,
            "CdkQuiltHostedZone",
            {
                hostedZoneId,
                zoneName: dnsName.split(".").slice(1).join("."),
            },
        );

        new route53.ARecord(this, "CdkQuiltAliasRecord", {
            zone: hostedZone,
            recordName: dnsName.split(".")[0],
            target: route53.RecordTarget.fromAlias(
                new route53Targets.ApiGateway(api),
            ),
        });
    }
}
