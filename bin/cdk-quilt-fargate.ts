#!/usr/bin/env node
import * as cdk from "aws-cdk-lib";
import { CdkQuiltFargateStack } from "../lib/cdk-quilt-fargate-stack";

const app = new cdk.App();
new CdkQuiltFargateStack(app, "CdkQuiltFargateStack", {
    email: "omics-nov-2023-aaaalfn3qsvil4dfelmhhncbra@quiltdata.slack.com",
    projectName: "package-engine",
    zoneDomain: "quilttest.com",
    zoneID: "Z050530821I8SLJEKKYY6",
    env: {
        account: process.env.CDK_DEFAULT_ACCOUNT,
        region: process.env.CDK_DEFAULT_REGION,
    },
});
