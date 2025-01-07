#!/usr/bin/env deno run --allow-env --allow-net

import * as cdk from "aws-cdk-lib";
import { PackageEngineStack } from "../lib/package-engine-stack.ts";

const app = new cdk.App();
new PackageEngineStack(app, "PackageEngineStack");
app.synth();
