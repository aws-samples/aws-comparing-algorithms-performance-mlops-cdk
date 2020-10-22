"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BlogResourcesStack = void 0;
const cdk = require("@aws-cdk/core");
const ec2 = require("@aws-cdk/aws-ec2");
const s3 = require("@aws-cdk/aws-s3");
const stepFunction = require("@aws-cdk/aws-stepfunctions");
const tasks = require("@aws-cdk/aws-stepfunctions-tasks");
const lambda = require("@aws-cdk/aws-lambda");
const cloudformation = require("@aws-cdk/aws-cloudformation");
const s3Trigger = require("@aws-cdk/aws-s3-notifications");
const iam = require("@aws-cdk/aws-iam");
const s3deploy = require("@aws-cdk/aws-s3-deployment");
class BlogResourcesStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // The code that defines your stack goes here
        //creating bucket for the blog
        const blogBucket = new s3.Bucket(this, 'abaloneBlogBucket', {
            bucketName: 'abalone-blog' + '-' + cdk.Aws.ACCOUNT_ID + '-' + cdk.Aws.REGION,
            removalPolicy: cdk.RemovalPolicy.DESTROY
        });
        // Lambda as a custom resource to create the folder structure within the bucket
        const bucketFolderCreator = new lambda.Function(this, "folderCreatorFunction", {
            runtime: lambda.Runtime.PYTHON_3_8,
            functionName: "abalone-bucketFolderCreator" + '-' + cdk.Aws.ACCOUNT_ID + '-' + cdk.Aws.REGION,
            code: lambda.Code.fromAsset('../functions/bucketFolderCreator'),
            handler: 'index.handler',
            environment: {
                bucket: blogBucket.bucketName
            }
        });
        //allow bucketFolderCreator lambda permission to read and write over the bucket
        blogBucket.grantReadWrite(bucketFolderCreator);
        //Create custom resource to invoke the lambda function to create the folders
        const invokeLambdaBucketCreator = new cloudformation.CustomResource(this, "InvokeBucketFolderCreator1", {
            provider: cloudformation.CustomResourceProvider.fromLambda(bucketFolderCreator)
        });
        const s3AssetForSagemakerProcessing = new s3deploy.BucketDeployment(this, 'DeploySagemakerProcessingScript', {
            sources: [s3deploy.Source.asset('scripts/processing_script')],
            destinationBucket: blogBucket,
            destinationKeyPrefix: 'Scripts'
        });
        //step functions definition section
        //Create stepfunctions role
        const stepFunctionsRole = new iam.Role(this, "stepFunctionsRole", {
            assumedBy: new iam.CompositePrincipal(new iam.ServicePrincipal("states.amazonaws.com"), new iam.ServicePrincipal("sagemaker.amazonaws.com")),
            managedPolicies: [
                iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLogsFullAccess'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AWSLambdaFullAccess'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSageMakerFullAccess'),
                iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess')
            ]
        });
        /* collect information lambda
         that gets the algorithm images required for preprocessing and training */
        const startLambda = new lambda.Function(this, "lambdaStartingFunction", {
            runtime: lambda.Runtime.PYTHON_3_8,
            functionName: "abalone-stateFirstFunction" + '-' + cdk.Aws.ACCOUNT_ID + '-' + cdk.Aws.REGION,
            code: lambda.Code.fromAsset('../functions/startLambda'),
            handler: 'index.handler',
            environment: {
                region: cdk.Aws.REGION
            }
        });
        /* first task in step function is to invoke the starting lambda
        to collect information*/
        const submitJob = new tasks.LambdaInvoke(this, 'Fetch Image URIs', {
            lambdaFunction: startLambda,
            // Lambda's result is in the attribute `Payload`
            resultPath: '$.startLambda',
        });
        /* perform dataset conversion and divide the data set into train, validation, test dataset  */
        // create a processing job
        const processingJobJson = {
            Type: 'Task',
            Resource: "arn:aws:states:::sagemaker:createProcessingJob.sync",
            Parameters: {
                "ProcessingJobName.$": '$.input.processing_jobname',
                "ProcessingInputs": [
                    {
                        "InputName": "code",
                        "S3Input": {
                            "S3Uri": "s3://" + blogBucket.bucketName + "/Scripts/preprocessing.py",
                            "LocalPath": "/opt/ml/processing/input/code",
                            "S3DataType": "S3Prefix",
                            "S3InputMode": "File",
                            "S3DataDistributionType": "FullyReplicated",
                            "S3CompressionType": "None"
                        }
                    }
                ],
                "ProcessingOutputConfig": {
                    "Outputs": [
                        {
                            "OutputName": "output-1",
                            "S3Output": {
                                "S3Uri": "s3://" + blogBucket.bucketName + "/processing_job_logs/spark_event_logs",
                                "LocalPath": "/opt/ml/processing/spark-events/",
                                "S3UploadMode": "Continuous"
                            }
                        }
                    ]
                },
                "AppSpecification": {
                    "ImageUri.$": '$.startLambda.Payload.sagemaker_spark_image',
                    "ContainerArguments": [
                        "--s3_input_bucket",
                        blogBucket.bucketName,
                        "--s3_input_key_prefix",
                        "Inputs",
                        "--s3_output_bucket",
                        blogBucket.bucketName
                    ],
                    "ContainerEntrypoint": [
                        "smspark-submit",
                        "--local-spark-event-logs-dir",
                        "/opt/ml/processing/spark-events/",
                        "/opt/ml/processing/input/code/preprocessing.py"
                    ]
                },
                "RoleArn": stepFunctionsRole.roleArn,
                "ProcessingResources": {
                    "ClusterConfig": {
                        "InstanceCount": 1,
                        "InstanceType": "ml.m5.xlarge",
                        "VolumeSizeInGB": 30
                    }
                },
                "StoppingCondition": {
                    "MaxRuntimeInSeconds": 1200
                }
            },
            ResultPath: '$.model.xgboost'
        };
        //create a state to start the preprocessing of the dataset
        const processingJobTask = new stepFunction.CustomState(this, 'Process and divide dataset', {
            stateJson: processingJobJson
        });
        //task to train using Xgboost algorithm
        const sagemakerXgboostTrainjob = new tasks.SageMakerCreateTrainingJob(this, 'XgboostTraining', {
            trainingJobName: stepFunction.JsonPath.stringAt('$.input.xgb_jobname'),
            integrationPattern: stepFunction.IntegrationPattern.RUN_JOB,
            algorithmSpecification: {
                trainingImage: tasks.DockerImage.fromRegistry(stepFunction.JsonPath.stringAt('$.startLambda.Payload.xgb_image')),
                trainingInputMode: tasks.InputMode.FILE
            },
            inputDataConfig: [
                {
                    channelName: "train",
                    contentType: "libsvm",
                    dataSource: {
                        s3DataSource: {
                            s3DataType: tasks.S3DataType.S3_PREFIX,
                            s3DataDistributionType: tasks.S3DataDistributionType.FULLY_REPLICATED,
                            s3Location: tasks.S3Location.fromBucket(blogBucket, 'Xgboost/train/')
                        }
                    }
                },
                {
                    channelName: "validation",
                    contentType: "libsvm",
                    dataSource: {
                        s3DataSource: {
                            s3DataType: tasks.S3DataType.S3_PREFIX,
                            s3DataDistributionType: tasks.S3DataDistributionType.FULLY_REPLICATED,
                            s3Location: tasks.S3Location.fromBucket(blogBucket, 'Xgboost/validation/')
                        }
                    }
                }
            ],
            outputDataConfig: {
                s3OutputLocation: tasks.S3Location.fromBucket(blogBucket, 'ml_models/xgboost/')
            },
            resourceConfig: {
                instanceCount: 1,
                instanceType: ec2.InstanceType.of(ec2.InstanceClass.M5, ec2.InstanceSize.XLARGE2),
                volumeSize: cdk.Size.gibibytes(30),
            },
            stoppingCondition: {
                maxRuntime: cdk.Duration.hours(1),
            },
            hyperparameters: {
                "max_depth": "5",
                "eta": "0.2",
                "gamma": "4",
                "min_child_weight": "6",
                "subsample": "0.7",
                "silent": "0",
                "objective": "reg:linear",
                "num_round": "50"
            },
            resultPath: '$.training.xgboostresult'
        });
        //task to train using linear learner algorithm
        const sagemakerLinearTrainjob = new tasks.SageMakerCreateTrainingJob(this, 'LinearTraining', {
            trainingJobName: stepFunction.JsonPath.stringAt('$.input.ll_jobname'),
            integrationPattern: stepFunction.IntegrationPattern.RUN_JOB,
            algorithmSpecification: {
                trainingImage: tasks.DockerImage.fromRegistry(stepFunction.JsonPath.stringAt('$.startLambda.Payload.linear_image')),
                trainingInputMode: tasks.InputMode.FILE
            },
            inputDataConfig: [
                {
                    channelName: "train",
                    contentType: "text/csv",
                    dataSource: {
                        s3DataSource: {
                            s3DataType: tasks.S3DataType.S3_PREFIX,
                            s3DataDistributionType: tasks.S3DataDistributionType.FULLY_REPLICATED,
                            s3Location: tasks.S3Location.fromBucket(blogBucket, 'Linear/train/')
                        }
                    }
                },
                {
                    channelName: "validation",
                    contentType: "text/csv",
                    dataSource: {
                        s3DataSource: {
                            s3DataType: tasks.S3DataType.S3_PREFIX,
                            s3DataDistributionType: tasks.S3DataDistributionType.FULLY_REPLICATED,
                            s3Location: tasks.S3Location.fromBucket(blogBucket, 'Linear/validation/')
                        }
                    }
                }
            ],
            outputDataConfig: {
                s3OutputLocation: tasks.S3Location.fromBucket(blogBucket, 'ml_models/linear/')
            },
            resourceConfig: {
                instanceCount: 1,
                instanceType: ec2.InstanceType.of(ec2.InstanceClass.M5, ec2.InstanceSize.XLARGE),
                volumeSize: cdk.Size.gibibytes(30),
            },
            stoppingCondition: {
                maxRuntime: cdk.Duration.hours(1),
            },
            hyperparameters: {
                "feature_dim": "8",
                "epochs": "10",
                "loss": "absolute_loss",
                "predictor_type": "regressor",
                "normalize_data": "True",
                "optimizer": "adam",
                "mini_batch_size": "100",
                "learning_rate": "0.0001"
            },
            resultPath: '$.training.llresult'
        });
        // create a model out of the xgboost training job
        const createXgboostModelJson = {
            Type: 'Task',
            Resource: "arn:aws:states:::sagemaker:createModel",
            Parameters: {
                "ExecutionRoleArn": stepFunctionsRole.roleArn,
                "ModelName.$": '$.input.xgb_model_name',
                "PrimaryContainer": {
                    "Environment": {},
                    "Image.$": '$.startLambda.Payload.xgb_image',
                    "ModelDataUrl.$": "$.training.xgboostresult.ModelArtifacts.S3ModelArtifacts"
                }
            },
            ResultPath: '$.model.xgboost'
        };
        //create a state to save the xgboost model created from the training job
        const saveXgboostModel = new stepFunction.CustomState(this, 'Save Xgboost Model', {
            stateJson: createXgboostModelJson
        });
        // create endpoint configuration for the xgboost model
        const createXgboostModelEndPointConfigJson = {
            Type: 'Task',
            Resource: "arn:aws:states:::sagemaker:createEndpointConfig",
            Parameters: {
                "EndpointConfigName.$": '$.input.xgb_model_name',
                "ProductionVariants": [
                    {
                        "InitialInstanceCount": 1,
                        "InstanceType": "ml.m4.xlarge",
                        "ModelName.$": '$.input.xgb_model_name',
                        "VariantName": "AllTraffic"
                    }
                ]
            },
            ResultPath: null
        };
        // create a state to save the linear model created from the training job
        const createXgboostEndPointConfig = new stepFunction.CustomState(this, 'Create Xgboost Endpoint Config', {
            stateJson: createXgboostModelEndPointConfigJson
        });
        // create a model out of the linear learner training job
        const createLinearModelJson = {
            Type: 'Task',
            Resource: "arn:aws:states:::sagemaker:createModel",
            Parameters: {
                "ExecutionRoleArn": stepFunctionsRole.roleArn,
                "ModelName.$": '$.input.ll_model_name',
                "PrimaryContainer": {
                    "Environment": {},
                    "Image.$": '$.startLambda.Payload.linear_image',
                    "ModelDataUrl.$": "$.training.llresult.ModelArtifacts.S3ModelArtifacts"
                }
            },
            ResultPath: '$.model.linearlearner'
        };
        // create a state to save the linear model created from the training job
        const saveLinearModel = new stepFunction.CustomState(this, 'Save Linear Model', {
            stateJson: createLinearModelJson
        });
        // create endpoint configurationfor the model
        const createLinearModelEndPointConfigJson = {
            Type: 'Task',
            Resource: "arn:aws:states:::sagemaker:createEndpointConfig",
            Parameters: {
                "EndpointConfigName.$": '$.input.ll_model_name',
                "ProductionVariants": [
                    {
                        "InitialInstanceCount": 1,
                        "InstanceType": "ml.m4.xlarge",
                        "ModelName.$": '$.input.ll_model_name',
                        "VariantName": "AllTraffic"
                    }
                ]
            },
            ResultPath: null
        };
        // create a state to save the linear model created from the training job
        const createLinearEndPointConfig = new stepFunction.CustomState(this, 'Create Linear Endpoint Config', {
            stateJson: createLinearModelEndPointConfigJson
        });
        //create xgboost endpoint based on configuration
        const createXgboostEndPointJson = {
            Type: 'Task',
            Resource: "arn:aws:states:::sagemaker:createEndpoint",
            Parameters: {
                "EndpointConfigName.$": "$.input.xgb_model_name",
                "EndpointName.$": "$.input.xgb_endpoint_name"
            },
            ResultPath: null
        };
        // create a state to create the xgboost endpoint
        const createXgboostEndPoint = new stepFunction.CustomState(this, 'Create Xgboost Endpoint', {
            stateJson: createXgboostEndPointJson
        });
        //create linear endpoint based on configuration
        const createLinearEndPointJson = {
            Type: 'Task',
            Resource: "arn:aws:states:::sagemaker:createEndpoint",
            Parameters: {
                "EndpointConfigName.$": "$.input.ll_model_name",
                "EndpointName.$": "$.input.ll_endpoint_name"
            },
            ResultPath: null
        };
        // create a state to create the endpoint
        const createLinearEndPoint = new stepFunction.CustomState(this, 'Create Linear Endpoint', {
            stateJson: createLinearEndPointJson
        });
        // create a lambda to describe the endpoint and return its status
        const describeEndpointLambda = new lambda.Function(this, "describeEndpointLambda", {
            runtime: lambda.Runtime.PYTHON_3_8,
            functionName: "abalone-describeEndpointFunction" + '-' + cdk.Aws.ACCOUNT_ID + '-' + cdk.Aws.REGION,
            code: lambda.Code.fromAsset('../functions/describeEndpointLambda'),
            handler: 'index.handler'
        });
        //add permission to invoke endpoints
        describeEndpointLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'sagemaker:DescribeEndpoint'
            ],
            resources: ['*']
        }));
        //create a task to invoke the lambda to perform the prediction
        const describeXgboostEndpoint = new tasks.LambdaInvoke(this, 'Describe Xgboost Endpoint', {
            lambdaFunction: describeEndpointLambda,
            // Lambda's result is in the attribute `Payload`
            resultPath: '$.endpoints_status.xgboostresult',
        });
        //create a task to invoke the lambda to perform the prediction
        const describeLinearEndpoint = new tasks.LambdaInvoke(this, 'Describe Linear Endpoint', {
            lambdaFunction: describeEndpointLambda,
            // Lambda's result is in the attribute `Payload`
            resultPath: '$.endpoints_status.llresult',
        });
        // create a prediction Lambda
        const predictionAccuracy = new lambda.Function(this, "predictionFunction", {
            runtime: lambda.Runtime.PYTHON_3_8,
            functionName: "abalone-predictionFunction" + '-' + cdk.Aws.ACCOUNT_ID + '-' + cdk.Aws.REGION,
            code: lambda.Code.fromAsset('../functions/predictionLambda'),
            handler: 'index.handler',
            environment: {
                region: cdk.Aws.REGION,
                bucket: blogBucket.bucketName
            }
        });
        //add permission to invoke endpoints
        predictionAccuracy.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'sagemaker:InvokeEndpoint'
            ],
            resources: ['*']
        }));
        //add permission to read and write from buckets
        blogBucket.grantRead(predictionAccuracy);
        //create a task to invoke the lambda to perform the prediction
        const performXgboostPredction = new tasks.LambdaInvoke(this, 'Perform Xgboost Prediction', {
            lambdaFunction: predictionAccuracy,
            // Lambda's result is in the attribute `Payload`
            resultPath: '$.prediction.xgboostresult',
        });
        const performLinearPredction = new tasks.LambdaInvoke(this, 'Perform Linear Prediction', {
            lambdaFunction: predictionAccuracy,
            // Lambda's result is in the attribute `Payload`
            resultPath: '$.prediction.llresult',
        });
        // create a cleanup Lambda
        const cleanupLambda = new lambda.Function(this, "cleanupFunction", {
            runtime: lambda.Runtime.PYTHON_3_8,
            functionName: "abalone-cleanupFunction" + '-' + cdk.Aws.ACCOUNT_ID + '-' + cdk.Aws.REGION,
            code: lambda.Code.fromAsset('../functions/cleanupLambda'),
            handler: 'index.handler',
        });
        //add permission to invoke endpoints
        cleanupLambda.addToRolePolicy(new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: [
                'sagemaker:*'
            ],
            resources: ['*']
        }));
        // create a task in stepfunctions to invoke the clean up lambda for xgboost endpoint
        const xgboostCleanupTask = new tasks.LambdaInvoke(this, 'Delete xgboost Endpoint', {
            lambdaFunction: cleanupLambda,
            resultPath: '$.null'
        });
        // create a task in stepfunctions to invoke the clean up lambda for Linear endpoint
        const LinearCleanupTask = new tasks.LambdaInvoke(this, 'Delete Linear Endpoint', {
            lambdaFunction: cleanupLambda,
            resultPath: '$.null'
        });
        // Wait until it's the time mentioned in the the state object's "triggerTime"
        // field.
        const xgboostWait = new stepFunction.Wait(this, 'Wait For xgboost endpoint', {
            time: stepFunction.WaitTime.duration(cdk.Duration.minutes(1))
        });
        //checking if the endpoint is ready
        const isXgboostEndpointReady = new stepFunction.Choice(this, 'Xgboost Endpoint Ready?');
        isXgboostEndpointReady.when(stepFunction.Condition.not(stepFunction.Condition.stringEquals('$.endpoints_status.xgboostresult.Payload.endpoint_status', 'InService')), xgboostWait);
        isXgboostEndpointReady.otherwise(performXgboostPredction.next(xgboostCleanupTask));
        // Set the next state
        xgboostWait.next(describeXgboostEndpoint);
        // Wait until it's the time mentioned in the the state object's "triggerTime"
        // field.
        const linearWait = new stepFunction.Wait(this, 'Wait For Linear endpoint', {
            time: stepFunction.WaitTime.duration(cdk.Duration.minutes(1))
        });
        //checking if the endpoint is ready
        const isLinearEndpointReady = new stepFunction.Choice(this, 'Linear Endpoint Ready?');
        isLinearEndpointReady.when(stepFunction.Condition.not(stepFunction.Condition.stringEquals('$.endpoints_status.llresult.Payload.endpoint_status', 'InService')), linearWait);
        isLinearEndpointReady.otherwise(performLinearPredction.next(LinearCleanupTask));
        // Set the next state
        linearWait.next(describeLinearEndpoint);
        //xgboost succees state
        const XgboostWins = new stepFunction.Succeed(this, 'Xgboost has better accuracy!');
        //Linear sucess state
        const LinearWins = new stepFunction.Succeed(this, 'Linear has better accuracy!');
        //perform training for both alogirthms at the same time
        const parallel = new stepFunction.Parallel(this, 'Do the work in parallel');
        // xgboost branch
        parallel.branch(sagemakerXgboostTrainjob
            .next(saveXgboostModel)
            .next(createXgboostEndPointConfig)
            .next(createXgboostEndPoint)
            .next(describeXgboostEndpoint)
            .next(isXgboostEndpointReady));
        // linear learner branch
        parallel.branch(sagemakerLinearTrainjob
            .next(saveLinearModel)
            .next(createLinearEndPointConfig)
            .next(createLinearEndPoint)
            .next(describeLinearEndpoint)
            .next(isLinearEndpointReady));
        // create a comparison Lambda
        const comparisonLambda = new lambda.Function(this, "comparisonFunction", {
            runtime: lambda.Runtime.PYTHON_3_8,
            functionName: "abalone-comparisonFunction" + '-' + cdk.Aws.ACCOUNT_ID + '-' + cdk.Aws.REGION,
            code: lambda.Code.fromAsset('../functions/comparisonLambda'),
            handler: 'index.handler',
        });
        // create a task in the step functions to invoke the comparison Lambda
        const ComparisonTask = new tasks.LambdaInvoke(this, 'Compare performace', {
            lambdaFunction: comparisonLambda,
            resultPath: '$[0].winningAlgorithm',
            outputPath: '$[0].winningAlgorithm'
        });
        //making a choice which performed better
        const choice = new stepFunction.Choice(this, 'which model had better results ?');
        choice.when(stepFunction.Condition.stringEquals('$.Payload.winnerAlgorithm', 'xgboost'), XgboostWins);
        choice.otherwise(LinearWins);
        /* Creating the definition of the step function by
        chaining steps for the step function */
        const definition = submitJob
            .next(processingJobTask)
            .next(parallel)
            .next(ComparisonTask)
            .next(choice);
        // creating the stepfunctions resource
        const blogStepFunction = new stepFunction.StateMachine(this, "abaloneStepFunction", {
            definition,
            role: stepFunctionsRole,
            timeout: cdk.Duration.minutes(60)
        });
        /*Lambda to invoke the step function
        this lambda is invoked once the dataset is divided*/
        const stateInvokeLambda = new lambda.Function(this, "InvokeStateMachine", {
            runtime: lambda.Runtime.PYTHON_3_8,
            functionName: "abalone-invokeStateMachine" + '-' + cdk.Aws.ACCOUNT_ID + '-' + cdk.Aws.REGION,
            code: lambda.Code.fromAsset('../functions/invokeStateLambda'),
            handler: 'index.handler',
            environment: {
                stateMachineArn: blogStepFunction.stateMachineArn,
                accountId: cdk.Aws.ACCOUNT_ID
            }
        });
        // Invoke Lambda to start step function when object are uploaded
        blogBucket.addEventNotification(s3.EventType.OBJECT_CREATED_PUT, new s3Trigger.LambdaDestination(stateInvokeLambda), { prefix: 'Inputs/' });
        blogStepFunction.grantStartExecution(stateInvokeLambda);
    }
}
exports.BlogResourcesStack = BlogResourcesStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmxvZy1yZXNvdXJjZXMtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJibG9nLXJlc291cmNlcy1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxxQ0FBcUM7QUFDckMsd0NBQXdDO0FBQ3hDLHNDQUFzQztBQUN0QywyREFBMkQ7QUFDM0QsMERBQTBEO0FBQzFELDhDQUE4QztBQUM5Qyw4REFBOEQ7QUFDOUQsMkRBQTJEO0FBQzNELHdDQUF3QztBQUN4Qyx1REFBdUQ7QUFHdkQsTUFBYSxrQkFBbUIsU0FBUSxHQUFHLENBQUMsS0FBSztJQUMvQyxZQUFZLEtBQW9CLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQ2xFLEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLDZDQUE2QztRQUU3Qyw4QkFBOEI7UUFDOUIsTUFBTSxVQUFVLEdBQUMsSUFBSSxFQUFFLENBQUMsTUFBTSxDQUFDLElBQUksRUFBQyxtQkFBbUIsRUFBQztZQUN0RCxVQUFVLEVBQUUsY0FBYyxHQUFHLEdBQUcsR0FBRyxHQUFHLENBQUMsR0FBRyxDQUFDLFVBQVUsR0FBRyxHQUFHLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQyxNQUFNO1lBQzVFLGFBQWEsRUFBRSxHQUFHLENBQUMsYUFBYSxDQUFDLE9BQU87U0FDekMsQ0FBQyxDQUFDO1FBRUgsK0VBQStFO1FBQy9FLE1BQU0sbUJBQW1CLEdBQUUsSUFBSSxNQUFNLENBQUMsUUFBUSxDQUFDLElBQUksRUFBQyx1QkFBdUIsRUFBQztZQUMxRSxPQUFPLEVBQUUsTUFBTSxDQUFDLE9BQU8sQ0FBQyxVQUFVO1lBQ2xDLFlBQVksRUFBRSw2QkFBNkIsR0FBRyxHQUFHLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQyxVQUFVLEdBQUcsR0FBRyxHQUFHLEdBQUcsQ0FBQyxHQUFHLENBQUMsTUFBTTtZQUM3RixJQUFJLEVBQUUsTUFBTSxDQUFDLElBQUksQ0FBQyxTQUFT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RyxDQUFDLFVBQVUsR0FBRyxHQUFHLEdBQUcsR0FBRyxDQUFDLEdBQUcsQ0FBQyxNQUFNO1lBQzVGLElBQUksRUFBRSxNQUFNLENBQUMsSUFBSSxDQUFDLFNBQVMsQ0FBQyxnQ0FBZ0MsQ0FBQztZQUM3RCxPQUFPLEVBQUUsZUFBZTtZQUN4QixXQUFXLEVBQUM7Z0JBQ1YsZUFBZSxFQUFFLGdCQUFnQixDQUFDLGVBQWU7Z0JBQ2pELFNBQVMsRUFBRSxHQUFHLENBQUMsR0FBRyxDQUFDLFVBQVU7YUFDOUI7U0FDRixDQUFDLENBQUE7UUFFTixnRUFBZ0U7UUFDaEUsVUFBVSxDQUFDLG9CQUFvQixDQUFDLEVBQUUsQ0FBQyxTQUFTLENBQUMsa0JBQWtCLEVBQUMsSUFBSSxTQUFTLENBQUMsaUJBQWlCLENBQUMsaUJBQWlCLENBQUMsRUFBQyxFQUFFLE1BQU0sRUFBRSxTQUFTLEVBQUMsQ0FBQyxDQUFBO1FBQ3hJLGdCQUFnQixDQUFDLG1CQUFtQixDQUFDLGlCQUFpQixDQUFDLENBQUM7SUFDeEQsQ0FBQztDQUNGO0FBMWtCRCxnREEwa0JDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICogYXMgY2RrIGZyb20gJ0Bhd3MtY2RrL2NvcmUnO1xuaW1wb3J0ICogYXMgZWMyIGZyb20gJ0Bhd3MtY2RrL2F3cy1lYzInO1xuaW1wb3J0ICogYXMgczMgZnJvbSAnQGF3cy1jZGsvYXdzLXMzJztcbmltcG9ydCAqIGFzIHN0ZXBGdW5jdGlvbiBmcm9tICdAYXdzLWNkay9hd3Mtc3RlcGZ1bmN0aW9ucyc7XG5pbXBvcnQgKiBhcyB0YXNrcyBmcm9tICdAYXdzLWNkay9hd3Mtc3RlcGZ1bmN0aW9ucy10YXNrcyc7XG5pbXBvcnQgKiBhcyBsYW1iZGEgZnJvbSAnQGF3cy1jZGsvYXdzLWxhbWJkYSc7XG5pbXBvcnQgKiBhcyBjbG91ZGZvcm1hdGlvbiBmcm9tICdAYXdzLWNkay9hd3MtY2xvdWRmb3JtYXRpb24nO1xuaW1wb3J0ICogYXMgczNUcmlnZ2VyIGZyb20gJ0Bhd3MtY2RrL2F3cy1zMy1ub3RpZmljYXRpb25zJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdAYXdzLWNkay9hd3MtaWFtJztcbmltcG9ydCAqIGFzIHMzZGVwbG95IGZyb20gJ0Bhd3MtY2RrL2F3cy1zMy1kZXBsb3ltZW50JztcblxuXG5leHBvcnQgY2xhc3MgQmxvZ1Jlc291cmNlc1N0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IGNkay5Db25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzPzogY2RrLlN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8vIFRoZSBjb2RlIHRoYXQgZGVmaW5lcyB5b3VyIHN0YWNrIGdvZXMgaGVyZVxuXG4gICAgLy9jcmVhdGluZyBidWNrZXQgZm9yIHRoZSBibG9nXG4gICAgY29uc3QgYmxvZ0J1Y2tldD1uZXcgczMuQnVja2V0KHRoaXMsJ2FiYWxvbmVCbG9nQnVja2V0Jyx7XG4gICAgICBidWNrZXROYW1lOiAnYWJhbG9uZS1ibG9nJyArICctJyArIGNkay5Bd3MuQUNDT1VOVF9JRCArICctJyArIGNkay5Bd3MuUkVHSU9OLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWVxuICAgIH0pO1xuXG4gICAgLy8gTGFtYmRhIGFzIGEgY3VzdG9tIHJlc291cmNlIHRvIGNyZWF0ZSB0aGUgZm9sZGVyIHN0cnVjdHVyZSB3aXRoaW4gdGhlIGJ1Y2tldFxuICAgIGNvbnN0IGJ1Y2tldEZvbGRlckNyZWF0b3I9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcyxcImZvbGRlckNyZWF0b3JGdW5jdGlvblwiLHtcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzgsXG4gICAgICBmdW5jdGlvbk5hbWU6IFwiYWJhbG9uZS1idWNrZXRGb2xkZXJDcmVhdG9yXCIgKyAnLScgKyBjZGsuQXdzLkFDQ09VTlRfSUQgKyAnLScgKyBjZGsuQXdzLlJFR0lPTixcbiAgICAgIGNvZGU6IGxhbWJkYS5Db2RlLmZyb21Bc3NldCgnLi4vZnVuY3Rpb25zL2J1Y2tldEZvbGRlckNyZWF0b3InKSxcbiAgICAgIGhhbmRsZXI6ICdpbmRleC5oYW5kbGVyJyxcbiAgICAgIGVudmlyb25tZW50OntcbiAgICAgICAgYnVja2V0OiBibG9nQnVja2V0LmJ1Y2tldE5hbWVcbiAgICAgIH1cbiAgICB9KTtcblxuICAgIC8vYWxsb3cgYnVja2V0Rm9sZGVyQ3JlYXRvciBsYW1iZGEgcGVybWlzc2lvbiB0byByZWFkIGFuZCB3cml0ZSBvdmVyIHRoZSBidWNrZXRcbiAgICBibG9nQnVja2V0LmdyYW50UmVhZFdyaXRlKGJ1Y2tldEZvbGRlckNyZWF0b3IpO1xuXG4gICAgLy9DcmVhdGUgY3VzdG9tIHJlc291cmNlIHRvIGludm9rZSB0aGUgbGFtYmRhIGZ1bmN0aW9uIHRvIGNyZWF0ZSB0aGUgZm9sZGVyc1xuICAgIGNvbnN0IGludm9rZUxhbWJkYUJ1Y2tldENyZWF0b3I9IG5ldyBjbG91ZGZvcm1hdGlvbi5DdXN0b21SZXNvdXJjZSh0aGlzLFwiSW52b2tlQnVja2V0Rm9sZGVyQ3JlYXRvcjFcIix7XG4gICAgICBwcm92aWRlcjogY2xvdWRmb3JtYXRpb24uQ3VzdG9tUmVzb3VyY2VQcm92aWRlci5mcm9tTGFtYmRhKGJ1Y2tldEZvbGRlckNyZWF0b3IpXG4gICAgfSk7XG4gICAgXG4gICAgY29uc3QgczNBc3NldEZvclNhZ2VtYWtlclByb2Nlc3Npbmc9IG5ldyBzM2RlcGxveS5CdWNrZXREZXBsb3ltZW50KHRoaXMsICdEZXBsb3lTYWdlbWFrZXJQcm9jZXNzaW5nU2NyaXB0Jywge1xuICAgICAgc291cmNlczogW3MzZGVwbG95LlNvdXJjZS5hc3NldCgnc2NyaXB0cy9wcm9jZXNzaW5nX3NjcmlwdCcpXSxcbiAgICAgIGRlc3RpbmF0aW9uQnVja2V0OiBibG9nQnVja2V0LFxuICAgICAgZGVzdGluYXRpb25LZXlQcmVmaXg6ICdTY3JpcHRzJ1xuICAgIH0pO1xuICAgIFxuXG4gICAgLy9zdGVwIGZ1bmN0aW9ucyBkZWZpbml0aW9uIHNlY3Rpb25cbiAgICAvL0NyZWF0ZSBzdGVwZnVuY3Rpb25zIHJvbGVcbiAgICBjb25zdCBzdGVwRnVuY3Rpb25zUm9sZT1uZXcgaWFtLlJvbGUodGhpcywgXCJzdGVwRnVuY3Rpb25zUm9sZVwiLHtcbiAgICAgIGFzc3VtZWRCeTogbmV3IGlhbS5Db21wb3NpdGVQcmluY2lwYWwoXG4gICAgICAgIG5ldyBpYW0uU2VydmljZVByaW5jaXBhbChcInN0YXRlcy5hbWF6b25hd3MuY29tXCIpLFxuICAgICAgICBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoXCJzYWdlbWFrZXIuYW1hem9uYXdzLmNvbVwiKVxuICAgICAgKSxcbiAgICAgIG1hbmFnZWRQb2xpY2llczpbXG4gICAgICAgIGlhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZSgnQ2xvdWRXYXRjaExvZ3NGdWxsQWNjZXNzJyksIFxuICAgICAgICBpYW0uTWFuYWdlZFBvbGljeS5mcm9tQXdzTWFuYWdlZFBvbGljeU5hbWUoJ0FXU0xhbWJkYUZ1bGxBY2Nlc3MnKSxcbiAgICAgICAgaWFtLk1hbmFnZWRQb2xpY3kuZnJvbUF3c01hbmFnZWRQb2xpY3lOYW1lKCdBbWF6b25TYWdlTWFrZXJGdWxsQWNjZXNzJyksXG4gICAgICAgIGlhbS5NYW5hZ2VkUG9saWN5LmZyb21Bd3NNYW5hZ2VkUG9saWN5TmFtZSgnQW1hem9uUzNGdWxsQWNjZXNzJylcbiAgICAgIF1cbiAgICB9KTtcblxuXG4gICAgLyogY29sbGVjdCBpbmZvcm1hdGlvbiBsYW1iZGFcbiAgICAgdGhhdCBnZXRzIHRoZSBhbGdvcml0aG0gaW1hZ2VzIHJlcXVpcmVkIGZvciBwcmVwcm9jZXNzaW5nIGFuZCB0cmFpbmluZyAqL1xuICAgIGNvbnN0IHN0YXJ0TGFtYmRhPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsXCJsYW1iZGFTdGFydGluZ0Z1bmN0aW9uXCIse1xuICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfOCxcbiAgICAgIGZ1bmN0aW9uTmFtZTogXCJhYmFsb25lLXN0YXRlRmlyc3RGdW5jdGlvblwiICsgJy0nICsgY2RrLkF3cy5BQ0NPVU5UX0lEICsgJy0nICsgY2RrLkF3cy5SRUdJT04sXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQoJy4uL2Z1bmN0aW9ucy9zdGFydExhbWJkYScpLFxuICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxuICAgICAgZW52aXJvbm1lbnQ6e1xuICAgICAgICByZWdpb246IGNkay5Bd3MuUkVHSU9OXG4gICAgICB9XG4gICAgfSlcblxuICAgIC8qIGZpcnN0IHRhc2sgaW4gc3RlcCBmdW5jdGlvbiBpcyB0byBpbnZva2UgdGhlIHN0YXJ0aW5nIGxhbWJkYVxuICAgIHRvIGNvbGxlY3QgaW5mb3JtYXRpb24qL1xuICAgIGNvbnN0IHN1Ym1pdEpvYiA9IG5ldyB0YXNrcy5MYW1iZGFJbnZva2UodGhpcywgJ0ZldGNoIEltYWdlIFVSSXMnLCB7XG4gICAgICBsYW1iZGFGdW5jdGlvbjogc3RhcnRMYW1iZGEsXG4gICAgICAvLyBMYW1iZGEncyByZXN1bHQgaXMgaW4gdGhlIGF0dHJpYnV0ZSBgUGF5bG9hZGBcbiAgICAgIHJlc3VsdFBhdGg6ICckLnN0YXJ0TGFtYmRhJyxcbiAgICB9KTtcblxuICAgIC8qIHBlcmZvcm0gZGF0YXNldCBjb252ZXJzaW9uIGFuZCBkaXZpZGUgdGhlIGRhdGEgc2V0IGludG8gdHJhaW4sIHZhbGlkYXRpb24sIHRlc3QgZGF0YXNldCAgKi9cbiAgICAvLyBjcmVhdGUgYSBwcm9jZXNzaW5nIGpvYlxuICAgIGNvbnN0IHByb2Nlc3NpbmdKb2JKc29uID0ge1xuICAgICAgVHlwZTogJ1Rhc2snLFxuICAgICAgUmVzb3VyY2U6IFwiYXJuOmF3czpzdGF0ZXM6OjpzYWdlbWFrZXI6Y3JlYXRlUHJvY2Vzc2luZ0pvYi5zeW5jXCIsXG4gICAgICBQYXJhbWV0ZXJzOiB7XG4gICAgICAgIFwiUHJvY2Vzc2luZ0pvYk5hbWUuJFwiOiAnJC5pbnB1dC5wcm9jZXNzaW5nX2pvYm5hbWUnLFxuICAgICAgICBcIlByb2Nlc3NpbmdJbnB1dHNcIjpbXG4gICAgICAgICAge1xuICAgICAgICAgICAgICBcIklucHV0TmFtZVwiOiBcImNvZGVcIixcbiAgICAgICAgICAgICAgXCJTM0lucHV0XCI6IHtcbiAgICAgICAgICAgICAgICAgIFwiUzNVcmlcIjogXCJzMzovL1wiICsgYmxvZ0J1Y2tldC5idWNrZXROYW1lICsgXCIvU2NyaXB0cy9wcmVwcm9jZXNzaW5nLnB5XCIsXG4gICAgICAgICAgICAgICAgICBcIkxvY2FsUGF0aFwiOiBcIi9vcHQvbWwvcHJvY2Vzc2luZy9pbnB1dC9jb2RlXCIsXG4gICAgICAgICAgICAgICAgICBcIlMzRGF0YVR5cGVcIjogXCJTM1ByZWZpeFwiLFxuICAgICAgICAgICAgICAgICAgXCJTM0lucHV0TW9kZVwiOiBcIkZpbGVcIixcbiAgICAgICAgICAgICAgICAgIFwiUzNEYXRhRGlzdHJpYnV0aW9uVHlwZVwiOiBcIkZ1bGx5UmVwbGljYXRlZFwiLFxuICAgICAgICAgICAgICAgICAgXCJTM0NvbXByZXNzaW9uVHlwZVwiOiBcIk5vbmVcIlxuICAgICAgICAgICAgICB9XG4gICAgICAgICAgfVxuICAgICAgICBdLFxuICAgICAgICBcIlByb2Nlc3NpbmdPdXRwdXRDb25maWdcIjoge1xuICAgICAgICAgIFwiT3V0cHV0c1wiOiBbXG4gICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgIFwiT3V0cHV0TmFtZVwiOiBcIm91dHB1dC0xXCIsXG4gICAgICAgICAgICAgICAgICBcIlMzT3V0cHV0XCI6IHtcbiAgICAgICAgICAgICAgICAgICAgICBcIlMzVXJpXCI6IFwiczM6Ly9cIiArIGJsb2dCdWNrZXQuYnVja2V0TmFtZSArIFwiL3Byb2Nlc3Npbmdfam9iX2xvZ3Mvc3BhcmtfZXZlbnRfbG9nc1wiICxcbiAgICAgICAgICAgICAgICAgICAgICBcIkxvY2FsUGF0aFwiOiBcIi9vcHQvbWwvcHJvY2Vzc2luZy9zcGFyay1ldmVudHMvXCIsXG4gICAgICAgICAgICAgICAgICAgICAgXCJTM1VwbG9hZE1vZGVcIjogXCJDb250aW51b3VzXCJcbiAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgfVxuICAgICAgICAgIF1cbiAgICAgICAgfSxcbiAgICAgICAgXCJBcHBTcGVjaWZpY2F0aW9uXCI6e1xuICAgICAgICAgIFwiSW1hZ2VVcmkuJFwiOiAnJC5zdGFydExhbWJkYS5QYXlsb2FkLnNhZ2VtYWtlcl9zcGFya19pbWFnZScsXG4gICAgICAgICAgXCJDb250YWluZXJBcmd1bWVudHNcIjogW1xuICAgICAgICAgICAgICAgICAgICAgICAgXCItLXMzX2lucHV0X2J1Y2tldFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgYmxvZ0J1Y2tldC5idWNrZXROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgXCItLXMzX2lucHV0X2tleV9wcmVmaXhcIixcbiAgICAgICAgICAgICAgICAgICAgICAgIFwiSW5wdXRzXCIsXG4gICAgICAgICAgICAgICAgICAgICAgICBcIi0tczNfb3V0cHV0X2J1Y2tldFwiLFxuICAgICAgICAgICAgICAgICAgICAgICAgYmxvZ0J1Y2tldC5idWNrZXROYW1lXG4gICAgICAgICAgXSxcbiAgICAgICAgICBcIkNvbnRhaW5lckVudHJ5cG9pbnRcIjogW1xuICAgICAgICAgICAgICBcInNtc3Bhcmstc3VibWl0XCIsXG4gICAgICAgICAgICAgIFwiLS1sb2NhbC1zcGFyay1ldmVudC1sb2dzLWRpclwiLFxuICAgICAgICAgICAgICBcIi9vcHQvbWwvcHJvY2Vzc2luZy9zcGFyay1ldmVudHMvXCIsXG4gICAgICAgICAgICAgIFwiL29wdC9tbC9wcm9jZXNzaW5nL2lucHV0L2NvZGUvcHJlcHJvY2Vzc2luZy5weVwiXG4gICAgICAgICAgXVxuICAgICAgICB9LFxuICAgICAgICBcIlJvbGVBcm5cIjogc3RlcEZ1bmN0aW9uc1JvbGUucm9sZUFybixcbiAgICAgICAgXCJQcm9jZXNzaW5nUmVzb3VyY2VzXCI6IHtcbiAgICAgICAgICBcIkNsdXN0ZXJDb25maWdcIjoge1xuICAgICAgICAgICAgXCJJbnN0YW5jZUNvdW50XCI6IDEsXG4gICAgICAgICAgICBcIkluc3RhbmNlVHlwZVwiOiBcIm1sLm01LnhsYXJnZVwiLFxuICAgICAgICAgICAgXCJWb2x1bWVTaXplSW5HQlwiOiAzMFxuICAgICAgICAgIH1cbiAgICAgICAgfSxcbiAgICAgICAgXCJTdG9wcGluZ0NvbmRpdGlvblwiOiB7XG4gICAgICAgICAgXCJNYXhSdW50aW1lSW5TZWNvbmRzXCI6IDEyMDBcbiAgICAgICAgfVxuICAgICAgfSxcbiAgICAgIFJlc3VsdFBhdGg6ICckLm1vZGVsLnhnYm9vc3QnXG4gICAgfVxuXG4gICAgLy9jcmVhdGUgYSBzdGF0ZSB0byBzdGFydCB0aGUgcHJlcHJvY2Vzc2luZyBvZiB0aGUgZGF0YXNldFxuICAgIGNvbnN0IHByb2Nlc3NpbmdKb2JUYXNrPSBuZXcgc3RlcEZ1bmN0aW9uLkN1c3RvbVN0YXRlKHRoaXMsICdQcm9jZXNzIGFuZCBkaXZpZGUgZGF0YXNldCcse1xuICAgICAgc3RhdGVKc29uOiBwcm9jZXNzaW5nSm9iSnNvblxuICAgIH0pXG5cbiAgICAvL3Rhc2sgdG8gdHJhaW4gdXNpbmcgWGdib29zdCBhbGdvcml0aG1cbiAgICBjb25zdCBzYWdlbWFrZXJYZ2Jvb3N0VHJhaW5qb2IgPSBuZXcgdGFza3MuU2FnZU1ha2VyQ3JlYXRlVHJhaW5pbmdKb2IodGhpcywnWGdib29zdFRyYWluaW5nJyx7XG4gICAgICB0cmFpbmluZ0pvYk5hbWU6IHN0ZXBGdW5jdGlvbi5Kc29uUGF0aC5zdHJpbmdBdCgnJC5pbnB1dC54Z2Jfam9ibmFtZScpLFxuICAgICAgaW50ZWdyYXRpb25QYXR0ZXJuOiBzdGVwRnVuY3Rpb24uSW50ZWdyYXRpb25QYXR0ZXJuLlJVTl9KT0IsXG4gICAgICBhbGdvcml0aG1TcGVjaWZpY2F0aW9uOiB7XG4gICAgICAgIHRyYWluaW5nSW1hZ2U6IHRhc2tzLkRvY2tlckltYWdlLmZyb21SZWdpc3RyeShzdGVwRnVuY3Rpb24uSnNvblBhdGguc3RyaW5nQXQoJyQuc3RhcnRMYW1iZGEuUGF5bG9hZC54Z2JfaW1hZ2UnKSksXG4gICAgICAgIHRyYWluaW5nSW5wdXRNb2RlOiB0YXNrcy5JbnB1dE1vZGUuRklMRVxuICAgICAgfSxcbiAgICAgIGlucHV0RGF0YUNvbmZpZzpbXG4gICAgICAgIHtcbiAgICAgICAgICBjaGFubmVsTmFtZTogXCJ0cmFpblwiLFxuICAgICAgICAgIGNvbnRlbnRUeXBlOiBcImxpYnN2bVwiLFxuICAgICAgICAgIGRhdGFTb3VyY2U6e1xuICAgICAgICAgICAgICBzM0RhdGFTb3VyY2U6IHtcbiAgICAgICAgICAgICAgICBzM0RhdGFUeXBlOiB0YXNrcy5TM0RhdGFUeXBlLlMzX1BSRUZJWCxcbiAgICAgICAgICAgICAgICBzM0RhdGFEaXN0cmlidXRpb25UeXBlOiB0YXNrcy5TM0RhdGFEaXN0cmlidXRpb25UeXBlLkZVTExZX1JFUExJQ0FURUQsXG4gICAgICAgICAgICAgICAgczNMb2NhdGlvbjogdGFza3MuUzNMb2NhdGlvbi5mcm9tQnVja2V0KGJsb2dCdWNrZXQsJ1hnYm9vc3QvdHJhaW4vJylcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGNoYW5uZWxOYW1lOiBcInZhbGlkYXRpb25cIixcbiAgICAgICAgICBjb250ZW50VHlwZTogXCJsaWJzdm1cIixcbiAgICAgICAgICBkYXRhU291cmNlOntcbiAgICAgICAgICAgICAgczNEYXRhU291cmNlOiB7XG4gICAgICAgICAgICAgICAgczNEYXRhVHlwZTogdGFza3MuUzNEYXRhVHlwZS5TM19QUkVGSVgsXG4gICAgICAgICAgICAgICAgczNEYXRhRGlzdHJpYnV0aW9uVHlwZTogdGFza3MuUzNEYXRhRGlzdHJpYnV0aW9uVHlwZS5GVUxMWV9SRVBMSUNBVEVELFxuICAgICAgICAgICAgICAgIHMzTG9jYXRpb246IHRhc2tzLlMzTG9jYXRpb24uZnJvbUJ1Y2tldChibG9nQnVja2V0LCdYZ2Jvb3N0L3ZhbGlkYXRpb24vJylcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgXSxcbiAgICAgIG91dHB1dERhdGFDb25maWc6e1xuICAgICAgICBzM091dHB1dExvY2F0aW9uOiB0YXNrcy5TM0xvY2F0aW9uLmZyb21CdWNrZXQoYmxvZ0J1Y2tldCwgJ21sX21vZGVscy94Z2Jvb3N0LycpXG4gICAgICB9LFxuICAgICAgcmVzb3VyY2VDb25maWc6IHtcbiAgICAgICAgaW5zdGFuY2VDb3VudDogMSxcbiAgICAgICAgaW5zdGFuY2VUeXBlOiBlYzIuSW5zdGFuY2VUeXBlLm9mKGVjMi5JbnN0YW5jZUNsYXNzLk01LCBlYzIuSW5zdGFuY2VTaXplLlhMQVJHRTIpLFxuICAgICAgICB2b2x1bWVTaXplOiBjZGsuU2l6ZS5naWJpYnl0ZXMoMzApLFxuICAgICAgfSxcbiAgICAgIHN0b3BwaW5nQ29uZGl0aW9uOiB7XG4gICAgICAgIG1heFJ1bnRpbWU6IGNkay5EdXJhdGlvbi5ob3VycygxKSxcbiAgICAgIH0sXG4gICAgICBoeXBlcnBhcmFtZXRlcnM6e1xuICAgICAgICBcIm1heF9kZXB0aFwiOlwiNVwiLFxuICAgICAgICBcImV0YVwiOlwiMC4yXCIsXG4gICAgICAgIFwiZ2FtbWFcIjpcIjRcIixcbiAgICAgICAgXCJtaW5fY2hpbGRfd2VpZ2h0XCI6XCI2XCIsXG4gICAgICAgIFwic3Vic2FtcGxlXCI6XCIwLjdcIixcbiAgICAgICAgXCJzaWxlbnRcIjpcIjBcIixcbiAgICAgICAgXCJvYmplY3RpdmVcIjpcInJlZzpsaW5lYXJcIixcbiAgICAgICAgXCJudW1fcm91bmRcIjpcIjUwXCJcbiAgICAgIH0sXG4gICAgICByZXN1bHRQYXRoOiAnJC50cmFpbmluZy54Z2Jvb3N0cmVzdWx0J1xuICAgIH0pXG5cbiAgICAvL3Rhc2sgdG8gdHJhaW4gdXNpbmcgbGluZWFyIGxlYXJuZXIgYWxnb3JpdGhtXG4gICAgY29uc3Qgc2FnZW1ha2VyTGluZWFyVHJhaW5qb2IgPSBuZXcgdGFza3MuU2FnZU1ha2VyQ3JlYXRlVHJhaW5pbmdKb2IodGhpcywnTGluZWFyVHJhaW5pbmcnLHtcbiAgICAgIHRyYWluaW5nSm9iTmFtZTogc3RlcEZ1bmN0aW9uLkpzb25QYXRoLnN0cmluZ0F0KCckLmlucHV0LmxsX2pvYm5hbWUnKSxcbiAgICAgIGludGVncmF0aW9uUGF0dGVybjpzdGVwRnVuY3Rpb24uSW50ZWdyYXRpb25QYXR0ZXJuLlJVTl9KT0IsXG4gICAgICBhbGdvcml0aG1TcGVjaWZpY2F0aW9uOntcbiAgICAgICAgdHJhaW5pbmdJbWFnZTogdGFza3MuRG9ja2VySW1hZ2UuZnJvbVJlZ2lzdHJ5KHN0ZXBGdW5jdGlvbi5Kc29uUGF0aC5zdHJpbmdBdCgnJC5zdGFydExhbWJkYS5QYXlsb2FkLmxpbmVhcl9pbWFnZScpKSxcbiAgICAgICAgdHJhaW5pbmdJbnB1dE1vZGU6IHRhc2tzLklucHV0TW9kZS5GSUxFXG4gICAgICB9LFxuICAgICAgaW5wdXREYXRhQ29uZmlnOltcbiAgICAgICAge1xuICAgICAgICAgIGNoYW5uZWxOYW1lOiBcInRyYWluXCIsXG4gICAgICAgICAgY29udGVudFR5cGU6IFwidGV4dC9jc3ZcIixcbiAgICAgICAgICBkYXRhU291cmNlOntcbiAgICAgICAgICAgICAgczNEYXRhU291cmNlOiB7XG4gICAgICAgICAgICAgICAgczNEYXRhVHlwZTogdGFza3MuUzNEYXRhVHlwZS5TM19QUkVGSVgsXG4gICAgICAgICAgICAgICAgczNEYXRhRGlzdHJpYnV0aW9uVHlwZTogdGFza3MuUzNEYXRhRGlzdHJpYnV0aW9uVHlwZS5GVUxMWV9SRVBMSUNBVEVELFxuICAgICAgICAgICAgICAgIHMzTG9jYXRpb246IHRhc2tzLlMzTG9jYXRpb24uZnJvbUJ1Y2tldChibG9nQnVja2V0LCdMaW5lYXIvdHJhaW4vJylcbiAgICAgICAgICAgICAgfVxuICAgICAgICAgIH1cbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIGNoYW5uZWxOYW1lOiBcInZhbGlkYXRpb25cIixcbiAgICAgICAgICBjb250ZW50VHlwZTogXCJ0ZXh0L2NzdlwiLFxuICAgICAgICAgIGRhdGFTb3VyY2U6e1xuICAgICAgICAgICAgICBzM0RhdGFTb3VyY2U6IHtcbiAgICAgICAgICAgICAgICBzM0RhdGFUeXBlOiB0YXNrcy5TM0RhdGFUeXBlLlMzX1BSRUZJWCxcbiAgICAgICAgICAgICAgICBzM0RhdGFEaXN0cmlidXRpb25UeXBlOiB0YXNrcy5TM0RhdGFEaXN0cmlidXRpb25UeXBlLkZVTExZX1JFUExJQ0FURUQsXG4gICAgICAgICAgICAgICAgczNMb2NhdGlvbjogdGFza3MuUzNMb2NhdGlvbi5mcm9tQnVja2V0KGJsb2dCdWNrZXQsJ0xpbmVhci92YWxpZGF0aW9uLycpXG4gICAgICAgICAgICAgIH1cbiAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgIF0sXG4gICAgICBvdXRwdXREYXRhQ29uZmlnOntcbiAgICAgICAgczNPdXRwdXRMb2NhdGlvbjogdGFza3MuUzNMb2NhdGlvbi5mcm9tQnVja2V0KGJsb2dCdWNrZXQsICdtbF9tb2RlbHMvbGluZWFyLycpXG4gICAgICB9LFxuICAgICAgcmVzb3VyY2VDb25maWc6IHtcbiAgICAgICAgaW5zdGFuY2VDb3VudDogMSxcbiAgICAgICAgaW5zdGFuY2VUeXBlOiBlYzIuSW5zdGFuY2VUeXBlLm9mKGVjMi5JbnN0YW5jZUNsYXNzLk01LGVjMi5JbnN0YW5jZVNpemUuWExBUkdFKSxcbiAgICAgICAgdm9sdW1lU2l6ZTogY2RrLlNpemUuZ2liaWJ5dGVzKDMwKSxcbiAgICAgIH0sXG4gICAgICBzdG9wcGluZ0NvbmRpdGlvbjoge1xuICAgICAgICBtYXhSdW50aW1lOiBjZGsuRHVyYXRpb24uaG91cnMoMSksXG4gICAgICB9LFxuICAgICAgaHlwZXJwYXJhbWV0ZXJzOntcbiAgICAgICAgXCJmZWF0dXJlX2RpbVwiOiBcIjhcIixcbiAgICAgICAgXCJlcG9jaHNcIjogXCIxMFwiLFxuICAgICAgICBcImxvc3NcIjogXCJhYnNvbHV0ZV9sb3NzXCIsXG4gICAgICAgIFwicHJlZGljdG9yX3R5cGVcIjogXCJyZWdyZXNzb3JcIixcbiAgICAgICAgXCJub3JtYWxpemVfZGF0YVwiOiBcIlRydWVcIixcbiAgICAgICAgXCJvcHRpbWl6ZXJcIjpcImFkYW1cIixcbiAgICAgICAgXCJtaW5pX2JhdGNoX3NpemVcIjogXCIxMDBcIixcbiAgICAgICAgXCJsZWFybmluZ19yYXRlXCI6IFwiMC4wMDAxXCJcbiAgICAgIH0sXG4gICAgICByZXN1bHRQYXRoOiAnJC50cmFpbmluZy5sbHJlc3VsdCdcbiAgICB9KVxuXG4gICAgLy8gY3JlYXRlIGEgbW9kZWwgb3V0IG9mIHRoZSB4Z2Jvb3N0IHRyYWluaW5nIGpvYlxuICAgIGNvbnN0IGNyZWF0ZVhnYm9vc3RNb2RlbEpzb24gPSB7XG4gICAgICBUeXBlOiAnVGFzaycsXG4gICAgICBSZXNvdXJjZTogXCJhcm46YXdzOnN0YXRlczo6OnNhZ2VtYWtlcjpjcmVhdGVNb2RlbFwiLFxuICAgICAgUGFyYW1ldGVyczoge1xuICAgICAgICBcIkV4ZWN1dGlvblJvbGVBcm5cIjogc3RlcEZ1bmN0aW9uc1JvbGUucm9sZUFybixcbiAgICAgICAgXCJNb2RlbE5hbWUuJFwiOiAnJC5pbnB1dC54Z2JfbW9kZWxfbmFtZScsXG4gICAgICAgIFwiUHJpbWFyeUNvbnRhaW5lclwiOiB7XG4gICAgICAgICAgICAgICAgICAgIFwiRW52aXJvbm1lbnRcIjoge30sXG4gICAgICAgICAgICAgICAgICAgIFwiSW1hZ2UuJFwiOiAnJC5zdGFydExhbWJkYS5QYXlsb2FkLnhnYl9pbWFnZScsXG4gICAgICAgICAgICAgICAgICAgIFwiTW9kZWxEYXRhVXJsLiRcIjogXCIkLnRyYWluaW5nLnhnYm9vc3RyZXN1bHQuTW9kZWxBcnRpZmFjdHMuUzNNb2RlbEFydGlmYWN0c1wiXG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgICBSZXN1bHRQYXRoOiAnJC5tb2RlbC54Z2Jvb3N0J1xuICAgIH1cbiAgICBcbiAgICAvL2NyZWF0ZSBhIHN0YXRlIHRvIHNhdmUgdGhlIHhnYm9vc3QgbW9kZWwgY3JlYXRlZCBmcm9tIHRoZSB0cmFpbmluZyBqb2JcbiAgICBjb25zdCBzYXZlWGdib29zdE1vZGVsPSBuZXcgc3RlcEZ1bmN0aW9uLkN1c3RvbVN0YXRlKHRoaXMsICdTYXZlIFhnYm9vc3QgTW9kZWwnLHtcbiAgICAgIHN0YXRlSnNvbjogY3JlYXRlWGdib29zdE1vZGVsSnNvblxuICAgIH0pXG5cbiAgICAvLyBjcmVhdGUgZW5kcG9pbnQgY29uZmlndXJhdGlvbiBmb3IgdGhlIHhnYm9vc3QgbW9kZWxcbiAgICBjb25zdCBjcmVhdGVYZ2Jvb3N0TW9kZWxFbmRQb2ludENvbmZpZ0pzb24gPSB7XG4gICAgICAgICAgVHlwZTogJ1Rhc2snLFxuICAgICAgICAgIFJlc291cmNlOiBcImFybjphd3M6c3RhdGVzOjo6c2FnZW1ha2VyOmNyZWF0ZUVuZHBvaW50Q29uZmlnXCIsXG4gICAgICAgICAgUGFyYW1ldGVyczoge1xuICAgICAgICAgICAgXCJFbmRwb2ludENvbmZpZ05hbWUuJFwiOiAnJC5pbnB1dC54Z2JfbW9kZWxfbmFtZScsXG4gICAgICAgICAgICBcIlByb2R1Y3Rpb25WYXJpYW50c1wiOiBbXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBcIkluaXRpYWxJbnN0YW5jZUNvdW50XCI6IDEsXG4gICAgICAgICAgICAgICAgICAgIFwiSW5zdGFuY2VUeXBlXCI6IFwibWwubTQueGxhcmdlXCIsXG4gICAgICAgICAgICAgICAgICAgIFwiTW9kZWxOYW1lLiRcIjogJyQuaW5wdXQueGdiX21vZGVsX25hbWUnLFxuICAgICAgICAgICAgICAgICAgICBcIlZhcmlhbnROYW1lXCI6IFwiQWxsVHJhZmZpY1wiXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgXVxuICAgICAgICAgIH0sXG4gICAgICAgICAgUmVzdWx0UGF0aDogbnVsbFxuICAgICAgICB9XG4gICAgXG4gICAgLy8gY3JlYXRlIGEgc3RhdGUgdG8gc2F2ZSB0aGUgbGluZWFyIG1vZGVsIGNyZWF0ZWQgZnJvbSB0aGUgdHJhaW5pbmcgam9iXG4gICAgY29uc3QgY3JlYXRlWGdib29zdEVuZFBvaW50Q29uZmlnPSBuZXcgc3RlcEZ1bmN0aW9uLkN1c3RvbVN0YXRlKHRoaXMsICdDcmVhdGUgWGdib29zdCBFbmRwb2ludCBDb25maWcnLHtcbiAgICAgIHN0YXRlSnNvbjogY3JlYXRlWGdib29zdE1vZGVsRW5kUG9pbnRDb25maWdKc29uXG4gICAgfSlcblxuXG4gICAgLy8gY3JlYXRlIGEgbW9kZWwgb3V0IG9mIHRoZSBsaW5lYXIgbGVhcm5lciB0cmFpbmluZyBqb2JcbiAgICBjb25zdCBjcmVhdGVMaW5lYXJNb2RlbEpzb24gPSB7XG4gICAgICBUeXBlOiAnVGFzaycsXG4gICAgICBSZXNvdXJjZTogXCJhcm46YXdzOnN0YXRlczo6OnNhZ2VtYWtlcjpjcmVhdGVNb2RlbFwiLFxuICAgICAgUGFyYW1ldGVyczoge1xuICAgICAgICBcIkV4ZWN1dGlvblJvbGVBcm5cIjogc3RlcEZ1bmN0aW9uc1JvbGUucm9sZUFybixcbiAgICAgICAgXCJNb2RlbE5hbWUuJFwiOiAnJC5pbnB1dC5sbF9tb2RlbF9uYW1lJyxcbiAgICAgICAgXCJQcmltYXJ5Q29udGFpbmVyXCI6IHtcbiAgICAgICAgICAgICAgICAgICAgXCJFbnZpcm9ubWVudFwiOiB7fSxcbiAgICAgICAgICAgICAgICAgICAgXCJJbWFnZS4kXCI6ICckLnN0YXJ0TGFtYmRhLlBheWxvYWQubGluZWFyX2ltYWdlJyxcbiAgICAgICAgICAgICAgICAgICAgXCJNb2RlbERhdGFVcmwuJFwiOiBcIiQudHJhaW5pbmcubGxyZXN1bHQuTW9kZWxBcnRpZmFjdHMuUzNNb2RlbEFydGlmYWN0c1wiXG4gICAgICAgIH1cbiAgICAgIH0sXG4gICAgICBSZXN1bHRQYXRoOiAnJC5tb2RlbC5saW5lYXJsZWFybmVyJ1xuICAgIH1cbiAgICBcbiAgICAvLyBjcmVhdGUgYSBzdGF0ZSB0byBzYXZlIHRoZSBsaW5lYXIgbW9kZWwgY3JlYXRlZCBmcm9tIHRoZSB0cmFpbmluZyBqb2JcbiAgICBjb25zdCBzYXZlTGluZWFyTW9kZWw9IG5ldyBzdGVwRnVuY3Rpb24uQ3VzdG9tU3RhdGUodGhpcywgJ1NhdmUgTGluZWFyIE1vZGVsJyx7XG4gICAgICBzdGF0ZUpzb246IGNyZWF0ZUxpbmVhck1vZGVsSnNvblxuICAgIH0pXG5cbiAgICAvLyBjcmVhdGUgZW5kcG9pbnQgY29uZmlndXJhdGlvbmZvciB0aGUgbW9kZWxcbiAgICBjb25zdCBjcmVhdGVMaW5lYXJNb2RlbEVuZFBvaW50Q29uZmlnSnNvbiA9IHtcbiAgICAgIFR5cGU6ICdUYXNrJyxcbiAgICAgIFJlc291cmNlOiBcImFybjphd3M6c3RhdGVzOjo6c2FnZW1ha2VyOmNyZWF0ZUVuZHBvaW50Q29uZmlnXCIsXG4gICAgICBQYXJhbWV0ZXJzOiB7XG4gICAgICAgIFwiRW5kcG9pbnRDb25maWdOYW1lLiRcIjogJyQuaW5wdXQubGxfbW9kZWxfbmFtZScsXG4gICAgICAgIFwiUHJvZHVjdGlvblZhcmlhbnRzXCI6IFtcbiAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICBcIkluaXRpYWxJbnN0YW5jZUNvdW50XCI6IDEsXG4gICAgICAgICAgICAgICAgXCJJbnN0YW5jZVR5cGVcIjogXCJtbC5tNC54bGFyZ2VcIixcbiAgICAgICAgICAgICAgICBcIk1vZGVsTmFtZS4kXCI6ICckLmlucHV0LmxsX21vZGVsX25hbWUnLFxuICAgICAgICAgICAgICAgIFwiVmFyaWFudE5hbWVcIjogXCJBbGxUcmFmZmljXCJcbiAgICAgICAgICAgIH1cbiAgICAgICAgXVxuICAgICAgfSxcbiAgICAgIFJlc3VsdFBhdGg6IG51bGxcbiAgICB9XG4gICAgXG4gICAgLy8gY3JlYXRlIGEgc3RhdGUgdG8gc2F2ZSB0aGUgbGluZWFyIG1vZGVsIGNyZWF0ZWQgZnJvbSB0aGUgdHJhaW5pbmcgam9iXG4gICAgY29uc3QgY3JlYXRlTGluZWFyRW5kUG9pbnRDb25maWc9IG5ldyBzdGVwRnVuY3Rpb24uQ3VzdG9tU3RhdGUodGhpcywgJ0NyZWF0ZSBMaW5lYXIgRW5kcG9pbnQgQ29uZmlnJyx7XG4gICAgICBzdGF0ZUpzb246IGNyZWF0ZUxpbmVhck1vZGVsRW5kUG9pbnRDb25maWdKc29uXG4gICAgfSlcblxuICAgIC8vY3JlYXRlIHhnYm9vc3QgZW5kcG9pbnQgYmFzZWQgb24gY29uZmlndXJhdGlvblxuICAgIGNvbnN0IGNyZWF0ZVhnYm9vc3RFbmRQb2ludEpzb24gPSB7XG4gICAgICBUeXBlOiAnVGFzaycsXG4gICAgICBSZXNvdXJjZTogXCJhcm46YXdzOnN0YXRlczo6OnNhZ2VtYWtlcjpjcmVhdGVFbmRwb2ludFwiLFxuICAgICAgUGFyYW1ldGVyczoge1xuICAgICAgICBcIkVuZHBvaW50Q29uZmlnTmFtZS4kXCI6IFwiJC5pbnB1dC54Z2JfbW9kZWxfbmFtZVwiLFxuICAgICAgICBcIkVuZHBvaW50TmFtZS4kXCI6IFwiJC5pbnB1dC54Z2JfZW5kcG9pbnRfbmFtZVwiXG4gICAgICB9LFxuICAgICAgUmVzdWx0UGF0aDogbnVsbFxuICAgIH1cbiAgICBcbiAgICAvLyBjcmVhdGUgYSBzdGF0ZSB0byBjcmVhdGUgdGhlIHhnYm9vc3QgZW5kcG9pbnRcbiAgICBjb25zdCBjcmVhdGVYZ2Jvb3N0RW5kUG9pbnQ9IG5ldyBzdGVwRnVuY3Rpb24uQ3VzdG9tU3RhdGUodGhpcywgJ0NyZWF0ZSBYZ2Jvb3N0IEVuZHBvaW50Jyx7XG4gICAgICBzdGF0ZUpzb246IGNyZWF0ZVhnYm9vc3RFbmRQb2ludEpzb25cbiAgICB9KVxuXG4gICAgLy9jcmVhdGUgbGluZWFyIGVuZHBvaW50IGJhc2VkIG9uIGNvbmZpZ3VyYXRpb25cbiAgICBjb25zdCBjcmVhdGVMaW5lYXJFbmRQb2ludEpzb24gPSB7XG4gICAgVHlwZTogJ1Rhc2snLFxuICAgIFJlc291cmNlOiBcImFybjphd3M6c3RhdGVzOjo6c2FnZW1ha2VyOmNyZWF0ZUVuZHBvaW50XCIsXG4gICAgUGFyYW1ldGVyczoge1xuICAgICAgXCJFbmRwb2ludENvbmZpZ05hbWUuJFwiOiBcIiQuaW5wdXQubGxfbW9kZWxfbmFtZVwiLFxuICAgICAgXCJFbmRwb2ludE5hbWUuJFwiOiBcIiQuaW5wdXQubGxfZW5kcG9pbnRfbmFtZVwiXG4gICAgfSxcbiAgICBSZXN1bHRQYXRoOiBudWxsXG4gIH1cbiAgXG4gIC8vIGNyZWF0ZSBhIHN0YXRlIHRvIGNyZWF0ZSB0aGUgZW5kcG9pbnRcbiAgY29uc3QgY3JlYXRlTGluZWFyRW5kUG9pbnQ9IG5ldyBzdGVwRnVuY3Rpb24uQ3VzdG9tU3RhdGUodGhpcywgJ0NyZWF0ZSBMaW5lYXIgRW5kcG9pbnQnLHtcbiAgICBzdGF0ZUpzb246IGNyZWF0ZUxpbmVhckVuZFBvaW50SnNvblxuICB9KVxuXG4gIC8vIGNyZWF0ZSBhIGxhbWJkYSB0byBkZXNjcmliZSB0aGUgZW5kcG9pbnQgYW5kIHJldHVybiBpdHMgc3RhdHVzXG4gIGNvbnN0IGRlc2NyaWJlRW5kcG9pbnRMYW1iZGEgPSBuZXcgbGFtYmRhLkZ1bmN0aW9uKHRoaXMsXCJkZXNjcmliZUVuZHBvaW50TGFtYmRhXCIse1xuICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzgsXG4gICAgZnVuY3Rpb25OYW1lOiBcImFiYWxvbmUtZGVzY3JpYmVFbmRwb2ludEZ1bmN0aW9uXCIgKyAnLScgKyBjZGsuQXdzLkFDQ09VTlRfSUQgKyAnLScgKyBjZGsuQXdzLlJFR0lPTixcbiAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQoJy4uL2Z1bmN0aW9ucy9kZXNjcmliZUVuZHBvaW50TGFtYmRhJyksXG4gICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInXG4gIH0pXG5cbiAgLy9hZGQgcGVybWlzc2lvbiB0byBpbnZva2UgZW5kcG9pbnRzXG4gIGRlc2NyaWJlRW5kcG9pbnRMYW1iZGEuYWRkVG9Sb2xlUG9saWN5KG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICBlZmZlY3Q6IGlhbS5FZmZlY3QuQUxMT1csXG4gICAgYWN0aW9uczogW1xuICAgICAgJ3NhZ2VtYWtlcjpEZXNjcmliZUVuZHBvaW50J1xuICAgIF0sXG4gICAgcmVzb3VyY2VzOlsgJyonIF1cbiAgfSkpO1xuXG4gIC8vY3JlYXRlIGEgdGFzayB0byBpbnZva2UgdGhlIGxhbWJkYSB0byBwZXJmb3JtIHRoZSBwcmVkaWN0aW9uXG4gIGNvbnN0IGRlc2NyaWJlWGdib29zdEVuZHBvaW50ID0gbmV3IHRhc2tzLkxhbWJkYUludm9rZSh0aGlzLCAnRGVzY3JpYmUgWGdib29zdCBFbmRwb2ludCcsIHtcbiAgICBsYW1iZGFGdW5jdGlvbjogZGVzY3JpYmVFbmRwb2ludExhbWJkYSxcbiAgICAvLyBMYW1iZGEncyByZXN1bHQgaXMgaW4gdGhlIGF0dHJpYnV0ZSBgUGF5bG9hZGBcbiAgICByZXN1bHRQYXRoOiAnJC5lbmRwb2ludHNfc3RhdHVzLnhnYm9vc3RyZXN1bHQnLFxuICB9KTtcblxuICAvL2NyZWF0ZSBhIHRhc2sgdG8gaW52b2tlIHRoZSBsYW1iZGEgdG8gcGVyZm9ybSB0aGUgcHJlZGljdGlvblxuICBjb25zdCBkZXNjcmliZUxpbmVhckVuZHBvaW50ID0gbmV3IHRhc2tzLkxhbWJkYUludm9rZSh0aGlzLCAnRGVzY3JpYmUgTGluZWFyIEVuZHBvaW50Jywge1xuICAgIGxhbWJkYUZ1bmN0aW9uOiBkZXNjcmliZUVuZHBvaW50TGFtYmRhLFxuICAgIC8vIExhbWJkYSdzIHJlc3VsdCBpcyBpbiB0aGUgYXR0cmlidXRlIGBQYXlsb2FkYFxuICAgIHJlc3VsdFBhdGg6ICckLmVuZHBvaW50c19zdGF0dXMubGxyZXN1bHQnLFxuICB9KTtcblxuXG4gIC8vIGNyZWF0ZSBhIHByZWRpY3Rpb24gTGFtYmRhXG4gIGNvbnN0IHByZWRpY3Rpb25BY2N1cmFjeSA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcyxcInByZWRpY3Rpb25GdW5jdGlvblwiLHtcbiAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM184LFxuICAgIGZ1bmN0aW9uTmFtZTogXCJhYmFsb25lLXByZWRpY3Rpb25GdW5jdGlvblwiICsgJy0nICsgY2RrLkF3cy5BQ0NPVU5UX0lEICsgJy0nICsgY2RrLkF3cy5SRUdJT04sXG4gICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KCcuLi9mdW5jdGlvbnMvcHJlZGljdGlvbkxhbWJkYScpLFxuICAgIGhhbmRsZXI6ICdpbmRleC5oYW5kbGVyJyxcbiAgICBlbnZpcm9ubWVudDp7XG4gICAgICByZWdpb246IGNkay5Bd3MuUkVHSU9OLFxuICAgICAgYnVja2V0OiBibG9nQnVja2V0LmJ1Y2tldE5hbWVcbiAgICB9XG4gIH0pXG5cbiAgLy9hZGQgcGVybWlzc2lvbiB0byBpbnZva2UgZW5kcG9pbnRzXG4gIHByZWRpY3Rpb25BY2N1cmFjeS5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICBhY3Rpb25zOiBbXG4gICAgICAnc2FnZW1ha2VyOkludm9rZUVuZHBvaW50J1xuICAgIF0sXG4gICAgcmVzb3VyY2VzOlsgJyonIF1cbiAgfSkpO1xuXG4gIC8vYWRkIHBlcm1pc3Npb24gdG8gcmVhZCBhbmQgd3JpdGUgZnJvbSBidWNrZXRzXG4gIGJsb2dCdWNrZXQuZ3JhbnRSZWFkKHByZWRpY3Rpb25BY2N1cmFjeSlcblxuICAvL2NyZWF0ZSBhIHRhc2sgdG8gaW52b2tlIHRoZSBsYW1iZGEgdG8gcGVyZm9ybSB0aGUgcHJlZGljdGlvblxuICBjb25zdCBwZXJmb3JtWGdib29zdFByZWRjdGlvbiA9IG5ldyB0YXNrcy5MYW1iZGFJbnZva2UodGhpcywgJ1BlcmZvcm0gWGdib29zdCBQcmVkaWN0aW9uJywge1xuICAgIGxhbWJkYUZ1bmN0aW9uOiBwcmVkaWN0aW9uQWNjdXJhY3ksXG4gICAgLy8gTGFtYmRhJ3MgcmVzdWx0IGlzIGluIHRoZSBhdHRyaWJ1dGUgYFBheWxvYWRgXG4gICAgcmVzdWx0UGF0aDogJyQucHJlZGljdGlvbi54Z2Jvb3N0cmVzdWx0JyxcbiAgfSk7XG5cbiAgY29uc3QgcGVyZm9ybUxpbmVhclByZWRjdGlvbiA9IG5ldyB0YXNrcy5MYW1iZGFJbnZva2UodGhpcywgJ1BlcmZvcm0gTGluZWFyIFByZWRpY3Rpb24nLCB7XG4gICAgbGFtYmRhRnVuY3Rpb246IHByZWRpY3Rpb25BY2N1cmFjeSxcbiAgICAvLyBMYW1iZGEncyByZXN1bHQgaXMgaW4gdGhlIGF0dHJpYnV0ZSBgUGF5bG9hZGBcbiAgICByZXN1bHRQYXRoOiAnJC5wcmVkaWN0aW9uLmxscmVzdWx0JyxcbiAgfSk7XG5cbiAgLy8gY3JlYXRlIGEgY2xlYW51cCBMYW1iZGFcbiAgY29uc3QgY2xlYW51cExhbWJkYSA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcyxcImNsZWFudXBGdW5jdGlvblwiLHtcbiAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM184LFxuICAgIGZ1bmN0aW9uTmFtZTogXCJhYmFsb25lLWNsZWFudXBGdW5jdGlvblwiICsgJy0nICsgY2RrLkF3cy5BQ0NPVU5UX0lEICsgJy0nICsgY2RrLkF3cy5SRUdJT04sXG4gICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KCcuLi9mdW5jdGlvbnMvY2xlYW51cExhbWJkYScpLFxuICAgIGhhbmRsZXI6ICdpbmRleC5oYW5kbGVyJyxcbiAgfSlcblxuICAvL2FkZCBwZXJtaXNzaW9uIHRvIGludm9rZSBlbmRwb2ludHNcbiAgY2xlYW51cExhbWJkYS5hZGRUb1JvbGVQb2xpY3kobmV3IGlhbS5Qb2xpY3lTdGF0ZW1lbnQoe1xuICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICBhY3Rpb25zOiBbXG4gICAgICAnc2FnZW1ha2VyOionXG4gICAgXSxcbiAgICByZXNvdXJjZXM6WyAnKicgXVxuICB9KSk7XG5cbiAgLy8gY3JlYXRlIGEgdGFzayBpbiBzdGVwZnVuY3Rpb25zIHRvIGludm9rZSB0aGUgY2xlYW4gdXAgbGFtYmRhIGZvciB4Z2Jvb3N0IGVuZHBvaW50XG4gIGNvbnN0IHhnYm9vc3RDbGVhbnVwVGFzayA9IG5ldyB0YXNrcy5MYW1iZGFJbnZva2UodGhpcywgJ0RlbGV0ZSB4Z2Jvb3N0IEVuZHBvaW50Jywge1xuICAgIGxhbWJkYUZ1bmN0aW9uOiBjbGVhbnVwTGFtYmRhLFxuICAgIHJlc3VsdFBhdGg6ICckLm51bGwnXG4gIH0pO1xuXG4gIC8vIGNyZWF0ZSBhIHRhc2sgaW4gc3RlcGZ1bmN0aW9ucyB0byBpbnZva2UgdGhlIGNsZWFuIHVwIGxhbWJkYSBmb3IgTGluZWFyIGVuZHBvaW50XG4gIGNvbnN0IExpbmVhckNsZWFudXBUYXNrID0gbmV3IHRhc2tzLkxhbWJkYUludm9rZSh0aGlzLCAnRGVsZXRlIExpbmVhciBFbmRwb2ludCcsIHtcbiAgICBsYW1iZGFGdW5jdGlvbjogY2xlYW51cExhbWJkYSxcbiAgICByZXN1bHRQYXRoOiAnJC5udWxsJ1xuICB9KTtcbiAgICAgICAgXG4gIC8vIFdhaXQgdW50aWwgaXQncyB0aGUgdGltZSBtZW50aW9uZWQgaW4gdGhlIHRoZSBzdGF0ZSBvYmplY3QncyBcInRyaWdnZXJUaW1lXCJcbiAgLy8gZmllbGQuXG4gIGNvbnN0IHhnYm9vc3RXYWl0ID0gbmV3IHN0ZXBGdW5jdGlvbi5XYWl0KHRoaXMsICdXYWl0IEZvciB4Z2Jvb3N0IGVuZHBvaW50Jywge1xuICAgIHRpbWU6IHN0ZXBGdW5jdGlvbi5XYWl0VGltZS5kdXJhdGlvbihjZGsuRHVyYXRpb24ubWludXRlcygxKSlcbiAgfSk7XG5cbiAgLy9jaGVja2luZyBpZiB0aGUgZW5kcG9pbnQgaXMgcmVhZHlcbiAgY29uc3QgaXNYZ2Jvb3N0RW5kcG9pbnRSZWFkeSA9IG5ldyBzdGVwRnVuY3Rpb24uQ2hvaWNlKHRoaXMsICdYZ2Jvb3N0IEVuZHBvaW50IFJlYWR5PycpO1xuICBpc1hnYm9vc3RFbmRwb2ludFJlYWR5LndoZW4oc3RlcEZ1bmN0aW9uLkNvbmRpdGlvbi5ub3QoXG4gICAgc3RlcEZ1bmN0aW9uLkNvbmRpdGlvbi5zdHJpbmdFcXVhbHMoJyQuZW5kcG9pbnRzX3N0YXR1cy54Z2Jvb3N0cmVzdWx0LlBheWxvYWQuZW5kcG9pbnRfc3RhdHVzJywgJ0luU2VydmljZScpLFxuICApLCB4Z2Jvb3N0V2FpdCk7XG4gIGlzWGdib29zdEVuZHBvaW50UmVhZHkub3RoZXJ3aXNlKHBlcmZvcm1YZ2Jvb3N0UHJlZGN0aW9uLm5leHQoeGdib29zdENsZWFudXBUYXNrKSk7XG4gIC8vIFNldCB0aGUgbmV4dCBzdGF0ZVxuICB4Z2Jvb3N0V2FpdC5uZXh0KGRlc2NyaWJlWGdib29zdEVuZHBvaW50KTtcbiAgXG4gIC8vIFdhaXQgdW50aWwgaXQncyB0aGUgdGltZSBtZW50aW9uZWQgaW4gdGhlIHRoZSBzdGF0ZSBvYmplY3QncyBcInRyaWdnZXJUaW1lXCJcbiAgLy8gZmllbGQuXG4gIGNvbnN0IGxpbmVhcldhaXQgPSBuZXcgc3RlcEZ1bmN0aW9uLldhaXQodGhpcywgJ1dhaXQgRm9yIExpbmVhciBlbmRwb2ludCcsIHtcbiAgICB0aW1lOiBzdGVwRnVuY3Rpb24uV2FpdFRpbWUuZHVyYXRpb24oY2RrLkR1cmF0aW9uLm1pbnV0ZXMoMSkpXG4gIH0pO1xuXG4gIC8vY2hlY2tpbmcgaWYgdGhlIGVuZHBvaW50IGlzIHJlYWR5XG4gIGNvbnN0IGlzTGluZWFyRW5kcG9pbnRSZWFkeSA9IG5ldyBzdGVwRnVuY3Rpb24uQ2hvaWNlKHRoaXMsICdMaW5lYXIgRW5kcG9pbnQgUmVhZHk/Jyk7XG4gIGlzTGluZWFyRW5kcG9pbnRSZWFkeS53aGVuKHN0ZXBGdW5jdGlvbi5Db25kaXRpb24ubm90KFxuICAgIHN0ZXBGdW5jdGlvbi5Db25kaXRpb24uc3RyaW5nRXF1YWxzKCckLmVuZHBvaW50c19zdGF0dXMubGxyZXN1bHQuUGF5bG9hZC5lbmRwb2ludF9zdGF0dXMnLCAnSW5TZXJ2aWNlJyksXG4gICksIGxpbmVhcldhaXQpO1xuICBpc0xpbmVhckVuZHBvaW50UmVhZHkub3RoZXJ3aXNlKHBlcmZvcm1MaW5lYXJQcmVkY3Rpb24ubmV4dChMaW5lYXJDbGVhbnVwVGFzaykpO1xuICBcbiAgLy8gU2V0IHRoZSBuZXh0IHN0YXRlXG4gIGxpbmVhcldhaXQubmV4dChkZXNjcmliZUxpbmVhckVuZHBvaW50KTtcblxuICAvL3hnYm9vc3Qgc3VjY2VlcyBzdGF0ZVxuICBjb25zdCBYZ2Jvb3N0V2lucyA9IG5ldyBzdGVwRnVuY3Rpb24uU3VjY2VlZCh0aGlzLCAnWGdib29zdCBoYXMgYmV0dGVyIGFjY3VyYWN5IScpO1xuXG4gIC8vTGluZWFyIHN1Y2VzcyBzdGF0ZVxuICBjb25zdCBMaW5lYXJXaW5zID0gbmV3IHN0ZXBGdW5jdGlvbi5TdWNjZWVkKHRoaXMsICdMaW5lYXIgaGFzIGJldHRlciBhY2N1cmFjeSEnKTtcblxuICAvL3BlcmZvcm0gdHJhaW5pbmcgZm9yIGJvdGggYWxvZ2lydGhtcyBhdCB0aGUgc2FtZSB0aW1lXG4gIGNvbnN0IHBhcmFsbGVsID0gbmV3IHN0ZXBGdW5jdGlvbi5QYXJhbGxlbCh0aGlzLCAnRG8gdGhlIHdvcmsgaW4gcGFyYWxsZWwnKTtcbiAgLy8geGdib29zdCBicmFuY2hcbiAgcGFyYWxsZWwuYnJhbmNoKHNhZ2VtYWtlclhnYm9vc3RUcmFpbmpvYlxuICAgIC5uZXh0KHNhdmVYZ2Jvb3N0TW9kZWwpXG4gICAgLm5leHQoY3JlYXRlWGdib29zdEVuZFBvaW50Q29uZmlnKVxuICAgIC5uZXh0KGNyZWF0ZVhnYm9vc3RFbmRQb2ludClcbiAgICAubmV4dChkZXNjcmliZVhnYm9vc3RFbmRwb2ludClcbiAgICAubmV4dChpc1hnYm9vc3RFbmRwb2ludFJlYWR5KSk7XG4gIC8vIGxpbmVhciBsZWFybmVyIGJyYW5jaFxuICBwYXJhbGxlbC5icmFuY2goc2FnZW1ha2VyTGluZWFyVHJhaW5qb2JcbiAgICAubmV4dChzYXZlTGluZWFyTW9kZWwpXG4gICAgLm5leHQoY3JlYXRlTGluZWFyRW5kUG9pbnRDb25maWcpXG4gICAgLm5leHQoY3JlYXRlTGluZWFyRW5kUG9pbnQpXG4gICAgLm5leHQoZGVzY3JpYmVMaW5lYXJFbmRwb2ludClcbiAgICAubmV4dChpc0xpbmVhckVuZHBvaW50UmVhZHkpKTtcblxuICBcbiAgLy8gY3JlYXRlIGEgY29tcGFyaXNvbiBMYW1iZGFcbiAgY29uc3QgY29tcGFyaXNvbkxhbWJkYSA9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcyxcImNvbXBhcmlzb25GdW5jdGlvblwiLHtcbiAgICBydW50aW1lOiBsYW1iZGEuUnVudGltZS5QWVRIT05fM184LFxuICAgIGZ1bmN0aW9uTmFtZTogXCJhYmFsb25lLWNvbXBhcmlzb25GdW5jdGlvblwiICsgJy0nICsgY2RrLkF3cy5BQ0NPVU5UX0lEICsgJy0nICsgY2RrLkF3cy5SRUdJT04sXG4gICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KCcuLi9mdW5jdGlvbnMvY29tcGFyaXNvbkxhbWJkYScpLFxuICAgIGhhbmRsZXI6ICdpbmRleC5oYW5kbGVyJyxcbiAgfSlcbiAgXG4gIC8vIGNyZWF0ZSBhIHRhc2sgaW4gdGhlIHN0ZXAgZnVuY3Rpb25zIHRvIGludm9rZSB0aGUgY29tcGFyaXNvbiBMYW1iZGFcbiAgY29uc3QgQ29tcGFyaXNvblRhc2sgPSBuZXcgdGFza3MuTGFtYmRhSW52b2tlKHRoaXMsICdDb21wYXJlIHBlcmZvcm1hY2UnLCB7XG4gICAgbGFtYmRhRnVuY3Rpb246IGNvbXBhcmlzb25MYW1iZGEsXG4gICAgcmVzdWx0UGF0aDogJyRbMF0ud2lubmluZ0FsZ29yaXRobScsXG4gICAgb3V0cHV0UGF0aDogJyRbMF0ud2lubmluZ0FsZ29yaXRobSdcbiAgfSk7XG5cblxuICAvL21ha2luZyBhIGNob2ljZSB3aGljaCBwZXJmb3JtZWQgYmV0dGVyXG4gIGNvbnN0IGNob2ljZSA9IG5ldyBzdGVwRnVuY3Rpb24uQ2hvaWNlKHRoaXMsICd3aGljaCBtb2RlbCBoYWQgYmV0dGVyIHJlc3VsdHMgPycpO1xuICBjaG9pY2Uud2hlbihzdGVwRnVuY3Rpb24uQ29uZGl0aW9uLnN0cmluZ0VxdWFscyhcbiAgICAnJC5QYXlsb2FkLndpbm5lckFsZ29yaXRobScsXG4gICAgJ3hnYm9vc3QnXG4gICksIFhnYm9vc3RXaW5zKTtcbiAgY2hvaWNlLm90aGVyd2lzZShMaW5lYXJXaW5zKTtcblxuXG4gIC8qIENyZWF0aW5nIHRoZSBkZWZpbml0aW9uIG9mIHRoZSBzdGVwIGZ1bmN0aW9uIGJ5XG4gIGNoYWluaW5nIHN0ZXBzIGZvciB0aGUgc3RlcCBmdW5jdGlvbiAqL1xuICBjb25zdCBkZWZpbml0aW9uPSBzdWJtaXRKb2JcbiAgICAubmV4dChwcm9jZXNzaW5nSm9iVGFzaylcbiAgICAubmV4dChwYXJhbGxlbClcbiAgICAubmV4dChDb21wYXJpc29uVGFzaylcbiAgICAubmV4dChjaG9pY2UpXG5cbiAgLy8gY3JlYXRpbmcgdGhlIHN0ZXBmdW5jdGlvbnMgcmVzb3VyY2VcbiAgY29uc3QgYmxvZ1N0ZXBGdW5jdGlvbj0gbmV3IHN0ZXBGdW5jdGlvbi5TdGF0ZU1hY2hpbmUodGhpcyxcImFiYWxvbmVTdGVwRnVuY3Rpb25cIix7XG4gICAgZGVmaW5pdGlvbixcbiAgICByb2xlOiBzdGVwRnVuY3Rpb25zUm9sZSxcbiAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24ubWludXRlcyg2MClcbiAgfSlcbiAgICBcbiAgLypMYW1iZGEgdG8gaW52b2tlIHRoZSBzdGVwIGZ1bmN0aW9uXG4gIHRoaXMgbGFtYmRhIGlzIGludm9rZWQgb25jZSB0aGUgZGF0YXNldCBpcyBkaXZpZGVkKi9cbiAgY29uc3Qgc3RhdGVJbnZva2VMYW1iZGE9IG5ldyBsYW1iZGEuRnVuY3Rpb24odGhpcyxcIkludm9rZVN0YXRlTWFjaGluZVwiLHtcbiAgICAgICAgcnVudGltZTogbGFtYmRhLlJ1bnRpbWUuUFlUSE9OXzNfOCxcbiAgICAgICAgZnVuY3Rpb25OYW1lOiBcImFiYWxvbmUtaW52b2tlU3RhdGVNYWNoaW5lXCIgKyAnLScgKyBjZGsuQXdzLkFDQ09VTlRfSUQgKyAnLScgKyBjZGsuQXdzLlJFR0lPTixcbiAgICAgICAgY29kZTogbGFtYmRhLkNvZGUuZnJvbUFzc2V0KCcuLi9mdW5jdGlvbnMvaW52b2tlU3RhdGVMYW1iZGEnKSxcbiAgICAgICAgaGFuZGxlcjogJ2luZGV4LmhhbmRsZXInLFxuICAgICAgICBlbnZpcm9ubWVudDp7XG4gICAgICAgICAgc3RhdGVNYWNoaW5lQXJuOiBibG9nU3RlcEZ1bmN0aW9uLnN0YXRlTWFjaGluZUFybixcbiAgICAgICAgICBhY2NvdW50SWQ6IGNkay5Bd3MuQUNDT1VOVF9JRFxuICAgICAgICB9XG4gICAgICB9KVxuXG4gIC8vIEludm9rZSBMYW1iZGEgdG8gc3RhcnQgc3RlcCBmdW5jdGlvbiB3aGVuIG9iamVjdCBhcmUgdXBsb2FkZWRcbiAgYmxvZ0J1Y2tldC5hZGRFdmVudE5vdGlmaWNhdGlvbihzMy5FdmVudFR5cGUuT0JKRUNUX0NSRUFURURfUFVULG5ldyBzM1RyaWdnZXIuTGFtYmRhRGVzdGluYXRpb24oc3RhdGVJbnZva2VMYW1iZGEpLHsgcHJlZml4OiAnSW5wdXRzLyd9KVxuICBibG9nU3RlcEZ1bmN0aW9uLmdyYW50U3RhcnRFeGVjdXRpb24oc3RhdGVJbnZva2VMYW1iZGEpO1xuICB9XG59XG4iXX0=