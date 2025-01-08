# cdk-fargate-ts

Create Fargate cluster with AWS CDK using TypeScript

## Prerequisites

- AWS CDK installed
- AWS CLI installed and configured
- Node.js installed
- Docker installed

## Setup

```bash
npm install -g aws-cdk
npm install
cdk bootstrap
```

## Deploy

```bash
cdk deploy
```

## Test Permissions

```bash
 aws ecr batch-get-image --registry-id  730278974607\
    --repository-name quiltdata/services/package-engine\
    --image-ids imageTag=latest --region us-east-1
```
