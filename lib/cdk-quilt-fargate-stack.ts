import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as events from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";

import * as logs from "aws-cdk-lib/aws-logs";
import * as route53 from "aws-cdk-lib/aws-route53";
import * as route53Targets from "aws-cdk-lib/aws-route53-targets";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sfn from "aws-cdk-lib/aws-stepfunctions";
import * as sns from "aws-cdk-lib/aws-sns";
import * as sns_subscriptions from "aws-cdk-lib/aws-sns-subscriptions";
import * as targets from "aws-cdk-lib/aws-events-targets";
import * as tasks from "aws-cdk-lib/aws-stepfunctions-tasks";

import { Construct } from "constructs";

interface ContainerConfig {
    port: number;
    cpu: number;
    memory: number;
    imageTag: string;
    logRetention: logs.RetentionDays;
}

interface CdkQuiltFargateStackProps extends cdk.StackProps {
    email: string;
    projectName: string;
    zoneID: string;
    zoneDomain: string;
}

export class CdkQuiltFargateStack extends cdk.Stack {
    private readonly containerConfig: ContainerConfig = {
        port: 3000,
        cpu: 256,
        memory: 512,
        imageTag: "latest",
        logRetention: logs.RetentionDays.ONE_WEEK,
    };

    private readonly eventSource: string;

    constructor(
        scope: Construct,
        id: string,
        props: CdkQuiltFargateStackProps,
    ) {
        super(scope, id, props);

        const { email, projectName, zoneID, zoneDomain: zoneDomain } = props;
        const dnsName = `${projectName}.${zoneDomain}`;
        this.eventSource = `quilt.${projectName}`;

        const topic = this.createTopic(email);
        const vpc = this.createVpc();
        const cluster = this.createCluster(vpc);
        const repository = this.getEcrRepository(projectName);

        const taskDefinition = this.createTaskDefinition(
            repository,
            dnsName,
        );
        const fargateService = this.createFargateService(
            cluster,
            taskDefinition,
            vpc,
        );
        const nlb = this.createNetworkLoadBalancer(vpc, fargateService);
        const hostedZone = this.createHostedZone(zoneID, zoneDomain);
        const certificate = this.createRoute53Certificate(hostedZone, dnsName);
        const api = this.createApiGateway(certificate, dnsName, nlb);
        this.configureRoute53(hostedZone, dnsName, api);
        const invokeApiRole = this.createInvokeApiRole();

        const getters = {
            "info": "GetInfo",
            "health": "GetHealth",
            "test_api_key": "TestApiKey",
        };

        this.createEventBridgeRules(api, getters);
        // Create state machines to call each getter via EventBridge and notify topic
        this.createStateMachines(api, topic, getters);

        // Outputs
        new cdk.CfnOutput(this, "ApiGatewayURL", { value: api.url });
        new cdk.CfnOutput(this, "CustomDomainURL", {
            value: `https://${dnsName}`,
        });
        new cdk.CfnOutput(this, "InvokeApiRoleArn", {
            value: invokeApiRole.roleArn,
        });
    }

    private createTopic(email: string): sns.Topic {
        const topic = new sns.Topic(this, "CdkQuiltFargateTopic", {
            topicName: "CdkQuiltFargateTopic",
            displayName: "CdkQuiltFargateTopic",
            fifo: false,
        });
        topic.addSubscription(new sns_subscriptions.EmailSubscription(email));
        return topic;
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

    private getEcrRepository(projectName: string): ecr.IRepository {
        return ecr.Repository.fromRepositoryName(
            this,
            "CdkQuiltFargateRepo",
            projectName,
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
        dnsName: string,
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
            environment: {
                PUBLIC_DNS_NAME: dnsName,
            },
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
                command: [
                    "CMD-SHELL",
                    "curl -f http://localhost:3000/health || exit 1",
                ],
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
        const serviceSecurityGroup = new ec2.SecurityGroup(
            this,
            "ServiceSecurityGroup",
            {
                vpc,
                allowAllOutbound: true,
                description: "Security group for Fargate service",
            },
        );

        // Allow inbound from VPC CIDR
        serviceSecurityGroup.addIngressRule(
            ec2.Peer.ipv4(vpc.vpcCidrBlock),
            ec2.Port.tcp(this.containerConfig.port),
            "Allow inbound from NLB",
        );

        return new ecs.FargateService(this, "CdkQuiltFargateService", {
            cluster,
            taskDefinition,
            assignPublicIp: false,
            deploymentController: {
                type: ecs.DeploymentControllerType.ECS,
            },
            circuitBreaker: { rollback: false },
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
                    new iam.ServicePrincipal(
                        "logdelivery.elasticloadbalancing.amazonaws.com",
                    ),
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
        zoneID: string,
        zoneDomain: string,
    ): route53.IHostedZone {
        const hostedZone = route53.HostedZone.fromHostedZoneAttributes(
            this,
            "CdkQuiltHostedZone",
            {
                hostedZoneId: zoneID,
                zoneName: zoneDomain,
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

        // Create log group with consistent naming
        const apiLogGroup = new logs.LogGroup(this, "CdkQuiltApiGatewayLogs", {
            retention: this.containerConfig.logRetention,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
        });

        const api = new apigateway.RestApi(this, "CdkQuiltApiGateway", {
            restApiName: "CdkQuiltService",
            description: "API Gateway for the Quilt Package Engine service",
            domainName: {
                domainName: dnsName,
                certificate: certificate,
            },
            defaultCorsPreflightOptions: {
                allowOrigins: apigateway.Cors.ALL_ORIGINS,
                allowMethods: apigateway.Cors.ALL_METHODS,
            },
            deployOptions: {
                accessLogDestination: new apigateway.LogGroupLogDestination(
                    apiLogGroup,
                ),
                accessLogFormat: apigateway.AccessLogFormat.custom(
                    JSON.stringify({
                        requestId: "$context.requestId",
                        ip: "$context.identity.sourceIp",
                        caller: "$context.identity.caller",
                        user: "$context.identity.user",
                        requestTime: "$context.requestTime",
                        httpMethod: "$context.httpMethod",
                        resourcePath: "$context.resourcePath",
                        status: "$context.status",
                        protocol: "$context.protocol",
                        responseLength: "$context.responseLength",
                        errorMessage: "$context.error.message",
                        integrationError: "$context.integration.error",
                        integrationStatus: "$context.integration.status",
                        integrationLatency: "$context.integration.latency",
                        integrationRequestId: "$context.integration.requestId",
                    }),
                ),
                loggingLevel: apigateway.MethodLoggingLevel.INFO,
                dataTraceEnabled: true,
                tracingEnabled: true,
                metricsEnabled: true,
            },
        });

        // Add a proxy resource to catch all paths
        const proxyResource = api.root.addResource("{proxy+}");
        proxyResource.addMethod(
            "ANY",
            new apigateway.Integration({
                type: apigateway.IntegrationType.HTTP_PROXY,
                integrationHttpMethod: "ANY",
                options: {
                    connectionType: apigateway.ConnectionType.VPC_LINK,
                    vpcLink: vpcLink,
                    requestParameters: {
                        "integration.request.path.proxy":
                            "method.request.path.proxy",
                    },
                },
                uri: `http://${nlb.loadBalancerDnsName}:${this.containerConfig.port}/{proxy}`,
            }),
            {
                requestParameters: {
                    "method.request.path.proxy": true,
                },
            },
        );

        // Also add a method to the root path
        api.root.addMethod(
            "ANY",
            new apigateway.Integration({
                type: apigateway.IntegrationType.HTTP_PROXY,
                integrationHttpMethod: "ANY",
                options: {
                    connectionType: apigateway.ConnectionType.VPC_LINK,
                    vpcLink: vpcLink,
                },
                uri: `http://${nlb.loadBalancerDnsName}:${this.containerConfig.port}/`,
            }),
        );

        return api;
    }

    private configureRoute53(
        hostedZone: route53.IHostedZone,
        projectName: string,
        api: apigateway.RestApi,
    ): void {
        new route53.ARecord(this, "CdkQuiltAliasRecord", {
            zone: hostedZone,
            recordName: projectName,
            target: route53.RecordTarget.fromAlias(
                new route53Targets.ApiGateway(api),
            ),
        });
    }

    // Create IAM Role for StepFunction/EventBridge to invoke the API Gateway
    private createInvokeApiRole(): iam.Role {
        const role = new iam.Role(this, "CdkQuiltInvokeApiRole", {
            assumedBy: new iam.ServicePrincipal("events.amazonaws.com"),
        });
        const managedPolicyNames = [
            "AmazonAPIGatewayInvokeFullAccess",
            "AmazonEventBridgeFullAccess",
            "AmazonSNSFullAccess",
            "AmazonSQSFullAccess",
            "AWSXRayDaemonWriteAccess",
            "CloudWatchLogsFullAccess",
        ];
        for (const policyName of managedPolicyNames) {
            const policy = iam.ManagedPolicy.fromAwsManagedPolicyName(
                policyName,
            );
            role.addManagedPolicy(policy);
        }
        role.grant(new iam.ServicePrincipal("events.amazonaws.com"));
        role.grant(new iam.ServicePrincipal("states.amazonaws.com"));
        return role;
    }

    // Create a custom EventBridge rule to invokes the API Gateway endpoint
    // with arguments: bucket_name, s3_folder, package_handle, metadata<dict>
    private addRule(
        api: apigateway.RestApi,
        ruleName: string,
        method: string,
        path: string,
        queryParams?: { [key: string]: string },
        pathParams?: string[],
    ): events.Rule {
        // Count the number of path parameters in the path
        const pathParamCount = (path.match(/{[^}]+}/g) || []).length;

        // Validate that the number of path parameters matches the provided values
        if (pathParamCount !== (pathParams?.length || 0)) {
            throw new Error(
                `Path '${path}' has ${pathParamCount} parameters but ${
                    pathParams?.length || 0
                } values were provided`,
            );
        }

        const rule = new events.Rule(this, `CkdQuilt${ruleName}Rule`, {
            eventPattern: {
                source: [this.eventSource],
                detailType: [ruleName],
            },
        });

        rule.addTarget(
            new targets.ApiGateway(api, {
                method: method,
                path: path,
                stage: "prod",
                pathParameterValues: pathParams,
                queryStringParameters: queryParams,
            }),
        );
        return rule;
    }

    private createEventBridgeRules(
        api: apigateway.RestApi,
        getters: { [key: string]: string },
    ): events.Rule[] {
        const query = {
            "s3_folder": "$.detail.s3_folder", // Maps to s3-folder from the event
            "package_handle": "$.detail.package_name", // Maps to package-name from the event
            "metadata": "$.detail.metadata", // Maps to metadata from the event
        };
        const createPackageRule = this.addRule(
            api,
            "CreatePackage",
            "POST",
            "/registries/udp-spec/packages", // hardcode `udp-spec` vs `{*}` or `*` for bucket_name
            query,
            // ["$.detail.bucket_name"],
        );
        const get_rules = Object.entries(getters).map(([path, name]) =>
            this.addRule(api, name, "GET", `/${path}`)
        );
        return [
            createPackageRule,
            ...get_rules,
        ];
    }

    private createSendEventTask(path: string, type: string): sfn.IChainable {
        return new tasks.EventBridgePutEvents(
            this,
            `SendEventToEventBridge${type}`,
            {
                entries: [
                    {
                        source: this.eventSource,
                        detailType: type,
                        detail: sfn.TaskInput.fromObject({
                            message: `Event for ${type}`,
                            path: path,
                        }),
                    },
                ],
                resultPath: "$.eventResult",
            },
        );
    }

    private createApiTask(api: apigateway.RestApi, method: tasks.HttpMethod, path: string): sfn.IChainable {
        return new tasks.CallApiGatewayRestApiEndpoint(
            this,
            `CallApiGateway${path}`,
            {
                api,
                stageName: "prod",
                method: method,
                apiPath: `/${path}`,
                resultPath: `$.apiResult`,
            },
        );
    }
    
    // Create state machines to call each getter by sending an EventBridge event
    // - source: this.eventSource,
    // - detailType: value (from getters)
    // then notifying topic
    private createStateMachines(
        api: apigateway.RestApi,
        topic: sns.Topic,
        getters: { [key: string]: string },
    ): void {
        for (const [path, type] of Object.entries(getters)) {
            const stateMachineName = `CdkQuilt${type}StateMachine`;

            // const callApiTask = this.createSendEventTask(path, type);
            const callApiTask = this.createApiTask(api, tasks.HttpMethod.GET, path);
            const notifyTopicTask = new tasks.SnsPublish(
                this,
                `CdkQuiltNotify${type}Topic`,
                {
                    topic: topic,
                    message: sfn.TaskInput.fromObject({
                        "Date": sfn.JsonPath.stringAt('$.apiResult.Headers.Date[0]'),
                        "ResponseBody": sfn.JsonPath.stringAt('$.apiResult.ResponseBody'),
                        "Status Code": sfn.JsonPath.numberAt('$.apiResult.StatusCode'),
                        "Status Text": sfn.JsonPath.stringAt('$.apiResult.StatusText'),
                        // "Headers": sfn.JsonPath.objectAt('$.apiResult.Headers'),
                    }),
                },
            );
            const chain = sfn.Chain.start(callApiTask).next(notifyTopicTask);

            // Define the state machine
            const stateMachine = new sfn.StateMachine(this, stateMachineName, {
                stateMachineName: stateMachineName,
                definitionBody: sfn.DefinitionBody.fromChainable(chain),
            });
            console.log(`Created state machine: ${stateMachineName}`);
        }
    }
}
