#!/usr/bin/env node
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
require("source-map-support/register");
const cdk = require("@aws-cdk/core");
const blog_resources_stack_1 = require("../lib/blog-resources-stack");
const myenv = { env: { "account": cdk.Aws.ACCOUNT_ID, "region": cdk.Aws.REGION } };
const app = new cdk.App();
new blog_resources_stack_1.BlogResourcesStack(app, 'BlogResourcesStack', myenv);
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmxvZy1yZXNvdXJjZXMuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJibG9nLXJlc291cmNlcy50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFDQSx1Q0FBcUM7QUFDckMscUNBQXFDO0FBQ3JDLHNFQUFpRTtBQUVqRSxNQUFNLEtBQUssR0FBQyxFQUFDLEdBQUcsRUFBQyxFQUFFLFNBQVMsRUFBRSxHQUFHLENBQUMsR0FBRyxDQUFDLFVBQVUsRUFBRSxRQUFRLEVBQUUsR0FBRyxDQUFDLEdBQUcsQ0FBQyxNQUFNLEVBQUUsRUFBQyxDQUFDO0FBRTlFLE1BQU0sR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsRUFBRSxDQUFDO0FBQzFCLElBQUkseUNBQWtCLENBQUMsR0FBRyxFQUFFLG9CQUFvQixFQUFDLEtBQUssQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiIyEvdXNyL2Jpbi9lbnYgbm9kZVxuaW1wb3J0ICdzb3VyY2UtbWFwLXN1cHBvcnQvcmVnaXN0ZXInO1xuaW1wb3J0ICogYXMgY2RrIGZyb20gJ0Bhd3MtY2RrL2NvcmUnO1xuaW1wb3J0IHsgQmxvZ1Jlc291cmNlc1N0YWNrIH0gZnJvbSAnLi4vbGliL2Jsb2ctcmVzb3VyY2VzLXN0YWNrJztcblxuY29uc3QgbXllbnY9e2Vudjp7IFwiYWNjb3VudFwiOiBjZGsuQXdzLkFDQ09VTlRfSUQsIFwicmVnaW9uXCI6IGNkay5Bd3MuUkVHSU9OIH19O1xuXG5jb25zdCBhcHAgPSBuZXcgY2RrLkFwcCgpO1xubmV3IEJsb2dSZXNvdXJjZXNTdGFjayhhcHAsICdCbG9nUmVzb3VyY2VzU3RhY2snLG15ZW52KTtcbiJdfQ==