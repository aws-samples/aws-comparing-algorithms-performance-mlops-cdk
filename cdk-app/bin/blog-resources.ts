#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { BlogResourcesStack } from '../lib/blog-resources-stack';

const myenv={env:{ "account": cdk.Aws.ACCOUNT_ID, "region": cdk.Aws.REGION }};

const app = new cdk.App();
new BlogResourcesStack(app, 'BlogResourcesStack',myenv);
