#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { CdkQuiltFargateStack } from "../lib/cdk-quilt-fargate-stack";

const app = new cdk.App();
new CdkQuiltFargateStack(app, "CdkQuiltFargateStack", {
    repositoryName: "package-engine",
    hostedZoneId: "Z050530821I8SLJEKKYY6",
    zoneName: "quilttest.com",
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
    },
    /* Uncomment the next line if you know exactly what Account and Region you
   * want to deploy the stack to. */
    // env: { account: '123456789012', region: 'us-east-1' },

    /* For more information, see https://docs.aws.amazon.com/cdk/latest/guide/environments.html */
});
