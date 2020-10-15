import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as s3 from '@aws-cdk/aws-s3';
import * as stepFunction from '@aws-cdk/aws-stepfunctions';
import * as tasks from '@aws-cdk/aws-stepfunctions-tasks';
import * as lambda from '@aws-cdk/aws-lambda';
import * as cloudformation from '@aws-cdk/aws-cloudformation';
import * as s3Trigger from '@aws-cdk/aws-s3-notifications';
import * as iam from '@aws-cdk/aws-iam';
import * as s3deploy from '@aws-cdk/aws-s3-deployment';


export class BlogResourcesStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here

    //creating bucket for the blog
    const blogBucket=new s3.Bucket(this,'abaloneBlogBucket',{
      bucketName: 'abalone-blog' + '-' + cdk.Aws.ACCOUNT_ID + '-' + cdk.Aws.REGION,
      removalPolicy: cdk.RemovalPolicy.DESTROY
    });

    // Lambda as a custom resource to create the folder structure within the bucket
    const bucketFolderCreator= new lambda.Function(this,"folderCreatorFunction",{
      runtime: lambda.Runtime.PYTHON_3_8,
      functionName: "abalone-bucketFolderCreator" + '-' + cdk.Aws.ACCOUNT_ID + '-' + cdk.Aws.REGION,
      code: lambda.Code.fromAsset('functions/bucketFolderCreator'),
      handler: 'index.handler',
      environment:{
        bucket: blogBucket.bucketName
      }
    });

    //allow bucketFolderCreator lambda permission to read and write over the bucket
    blogBucket.grantReadWrite(bucketFolderCreator);

    //Create custom resource to invoke the lambda function to create the folders
    const invokeLambdaBucketCreator= new cloudformation.CustomResource(this,"InvokeBucketFolderCreator1",{
      provider: cloudformation.CustomResourceProvider.fromLambda(bucketFolderCreator)
    });
    
    const s3AssetForSagemakerProcessing= new s3deploy.BucketDeployment(this, 'DeploySagemakerProcessingScript', {
      sources: [s3deploy.Source.asset('scripts/processing_script')],
      destinationBucket: blogBucket,
      destinationKeyPrefix: 'Scripts'
    });
    

    //step functions definition section
    //Create stepfunctions role
    const stepFunctionsRole=new iam.Role(this, "stepFunctionsRole",{
      assumedBy: new iam.CompositePrincipal(
        new iam.ServicePrincipal("states.amazonaws.com"),
        new iam.ServicePrincipal("sagemaker.amazonaws.com")
      ),
      managedPolicies:[
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchLogsFullAccess'), 
        iam.ManagedPolicy.fromAwsManagedPolicyName('AWSLambdaFullAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSageMakerFullAccess'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FullAccess')
      ]
    });


    /* collect information lambda
     that gets the algorithm images required for preprocessing and training */
    const startLambda= new lambda.Function(this,"lambdaStartingFunction",{
      runtime: lambda.Runtime.PYTHON_3_8,
      functionName: "abalone-stateFirstFunction" + '-' + cdk.Aws.ACCOUNT_ID + '-' + cdk.Aws.REGION,
      code: lambda.Code.fromAsset('functions/startLambda'),
      handler: 'index.handler',
      environment:{
        region: cdk.Aws.REGION
      }
    })

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
        "ProcessingInputs":[
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
                      "S3Uri": "s3://" + blogBucket.bucketName + "/processing_job_logs/spark_event_logs" ,
                      "LocalPath": "/opt/ml/processing/spark-events/",
                      "S3UploadMode": "Continuous"
                  }
              }
          ]
        },
        "AppSpecification":{
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
    }

    //create a state to start the preprocessing of the dataset
    const processingJobTask= new stepFunction.CustomState(this, 'Process and divide dataset',{
      stateJson: processingJobJson
    })

    //task to train using Xgboost algorithm
    const sagemakerXgboostTrainjob = new tasks.SageMakerCreateTrainingJob(this,'XgboostTraining',{
      trainingJobName: stepFunction.JsonPath.stringAt('$.input.xgb_jobname'),
      integrationPattern: stepFunction.IntegrationPattern.RUN_JOB,
      algorithmSpecification: {
        trainingImage: tasks.DockerImage.fromRegistry(stepFunction.JsonPath.stringAt('$.startLambda.Payload.xgb_image')),
        trainingInputMode: tasks.InputMode.FILE
      },
      inputDataConfig:[
        {
          channelName: "train",
          contentType: "libsvm",
          dataSource:{
              s3DataSource: {
                s3DataType: tasks.S3DataType.S3_PREFIX,
                s3DataDistributionType: tasks.S3DataDistributionType.FULLY_REPLICATED,
                s3Location: tasks.S3Location.fromBucket(blogBucket,'Xgboost/train/')
              }
          }
        },
        {
          channelName: "validation",
          contentType: "libsvm",
          dataSource:{
              s3DataSource: {
                s3DataType: tasks.S3DataType.S3_PREFIX,
                s3DataDistributionType: tasks.S3DataDistributionType.FULLY_REPLICATED,
                s3Location: tasks.S3Location.fromBucket(blogBucket,'Xgboost/validation/')
              }
          }
        }
      ],
      outputDataConfig:{
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
      hyperparameters:{
        "max_depth":"5",
        "eta":"0.2",
        "gamma":"4",
        "min_child_weight":"6",
        "subsample":"0.7",
        "silent":"0",
        "objective":"reg:linear",
        "num_round":"50"
      },
      resultPath: '$.training.xgboostresult'
    })

    //task to train using linear learner algorithm
    const sagemakerLinearTrainjob = new tasks.SageMakerCreateTrainingJob(this,'LinearTraining',{
      trainingJobName: stepFunction.JsonPath.stringAt('$.input.ll_jobname'),
      integrationPattern:stepFunction.IntegrationPattern.RUN_JOB,
      algorithmSpecification:{
        trainingImage: tasks.DockerImage.fromRegistry(stepFunction.JsonPath.stringAt('$.startLambda.Payload.linear_image')),
        trainingInputMode: tasks.InputMode.FILE
      },
      inputDataConfig:[
        {
          channelName: "train",
          contentType: "text/csv",
          dataSource:{
              s3DataSource: {
                s3DataType: tasks.S3DataType.S3_PREFIX,
                s3DataDistributionType: tasks.S3DataDistributionType.FULLY_REPLICATED,
                s3Location: tasks.S3Location.fromBucket(blogBucket,'Linear/train/')
              }
          }
        },
        {
          channelName: "validation",
          contentType: "text/csv",
          dataSource:{
              s3DataSource: {
                s3DataType: tasks.S3DataType.S3_PREFIX,
                s3DataDistributionType: tasks.S3DataDistributionType.FULLY_REPLICATED,
                s3Location: tasks.S3Location.fromBucket(blogBucket,'Linear/validation/')
              }
          }
        }
      ],
      outputDataConfig:{
        s3OutputLocation: tasks.S3Location.fromBucket(blogBucket, 'ml_models/linear/')
      },
      resourceConfig: {
        instanceCount: 1,
        instanceType: ec2.InstanceType.of(ec2.InstanceClass.M5,ec2.InstanceSize.XLARGE),
        volumeSize: cdk.Size.gibibytes(30),
      },
      stoppingCondition: {
        maxRuntime: cdk.Duration.hours(1),
      },
      hyperparameters:{
        "feature_dim": "8",
        "epochs": "10",
        "loss": "absolute_loss",
        "predictor_type": "regressor",
        "normalize_data": "True",
        "optimizer":"adam",
        "mini_batch_size": "100",
        "learning_rate": "0.0001"
      },
      resultPath: '$.training.llresult'
    })

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
    }
    
    //create a state to save the xgboost model created from the training job
    const saveXgboostModel= new stepFunction.CustomState(this, 'Save Xgboost Model',{
      stateJson: createXgboostModelJson
    })

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
        }
    
    // create a state to save the linear model created from the training job
    const createXgboostEndPointConfig= new stepFunction.CustomState(this, 'Create Xgboost Endpoint Config',{
      stateJson: createXgboostModelEndPointConfigJson
    })


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
    }
    
    // create a state to save the linear model created from the training job
    const saveLinearModel= new stepFunction.CustomState(this, 'Save Linear Model',{
      stateJson: createLinearModelJson
    })

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
    }
    
    // create a state to save the linear model created from the training job
    const createLinearEndPointConfig= new stepFunction.CustomState(this, 'Create Linear Endpoint Config',{
      stateJson: createLinearModelEndPointConfigJson
    })

    //create xgboost endpoint based on configuration
    const createXgboostEndPointJson = {
      Type: 'Task',
      Resource: "arn:aws:states:::sagemaker:createEndpoint",
      Parameters: {
        "EndpointConfigName.$": "$.input.xgb_model_name",
        "EndpointName.$": "$.input.xgb_endpoint_name"
      },
      ResultPath: null
    }
    
    // create a state to create the xgboost endpoint
    const createXgboostEndPoint= new stepFunction.CustomState(this, 'Create Xgboost Endpoint',{
      stateJson: createXgboostEndPointJson
    })

    //create linear endpoint based on configuration
    const createLinearEndPointJson = {
    Type: 'Task',
    Resource: "arn:aws:states:::sagemaker:createEndpoint",
    Parameters: {
      "EndpointConfigName.$": "$.input.ll_model_name",
      "EndpointName.$": "$.input.ll_endpoint_name"
    },
    ResultPath: null
  }
  
  // create a state to create the endpoint
  const createLinearEndPoint= new stepFunction.CustomState(this, 'Create Linear Endpoint',{
    stateJson: createLinearEndPointJson
  })

  // create a lambda to describe the endpoint and return its status
  const describeEndpointLambda = new lambda.Function(this,"describeEndpointLambda",{
    runtime: lambda.Runtime.PYTHON_3_8,
    functionName: "abalone-describeEndpointFunction" + '-' + cdk.Aws.ACCOUNT_ID + '-' + cdk.Aws.REGION,
    code: lambda.Code.fromAsset('functions/describeEndpointLambda'),
    handler: 'index.handler'
  })

  //add permission to invoke endpoints
  describeEndpointLambda.addToRolePolicy(new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: [
      'sagemaker:DescribeEndpoint'
    ],
    resources:[ '*' ]
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
  const predictionAccuracy = new lambda.Function(this,"predictionFunction",{
    runtime: lambda.Runtime.PYTHON_3_8,
    functionName: "abalone-predictionFunction" + '-' + cdk.Aws.ACCOUNT_ID + '-' + cdk.Aws.REGION,
    code: lambda.Code.fromAsset('functions/predictionLambda'),
    handler: 'index.handler',
    environment:{
      region: cdk.Aws.REGION,
      bucket: blogBucket.bucketName
    }
  })

  //add permission to invoke endpoints
  predictionAccuracy.addToRolePolicy(new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: [
      'sagemaker:InvokeEndpoint'
    ],
    resources:[ '*' ]
  }));

  //add permission to read and write from buckets
  blogBucket.grantRead(predictionAccuracy)

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
  const cleanupLambda = new lambda.Function(this,"cleanupFunction",{
    runtime: lambda.Runtime.PYTHON_3_8,
    functionName: "abalone-cleanupFunction" + '-' + cdk.Aws.ACCOUNT_ID + '-' + cdk.Aws.REGION,
    code: lambda.Code.fromAsset('functions/cleanupLambda'),
    handler: 'index.handler',
  })

  //add permission to invoke endpoints
  cleanupLambda.addToRolePolicy(new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: [
      'sagemaker:*'
    ],
    resources:[ '*' ]
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
  isXgboostEndpointReady.when(stepFunction.Condition.not(
    stepFunction.Condition.stringEquals('$.endpoints_status.xgboostresult.Payload.endpoint_status', 'InService'),
  ), xgboostWait);
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
  isLinearEndpointReady.when(stepFunction.Condition.not(
    stepFunction.Condition.stringEquals('$.endpoints_status.llresult.Payload.endpoint_status', 'InService'),
  ), linearWait);
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
  const comparisonLambda = new lambda.Function(this,"comparisonFunction",{
    runtime: lambda.Runtime.PYTHON_3_8,
    functionName: "abalone-comparisonFunction" + '-' + cdk.Aws.ACCOUNT_ID + '-' + cdk.Aws.REGION,
    code: lambda.Code.fromAsset('functions/comparisonLambda'),
    handler: 'index.handler',
  })
  
  // create a task in the step functions to invoke the comparison Lambda
  const ComparisonTask = new tasks.LambdaInvoke(this, 'Compare performace', {
    lambdaFunction: comparisonLambda,
    resultPath: '$[0].winningAlgorithm',
    outputPath: '$[0].winningAlgorithm'
  });


  //making a choice which performed better
  const choice = new stepFunction.Choice(this, 'which model had better results ?');
  choice.when(stepFunction.Condition.stringEquals(
    '$.Payload.winnerAlgorithm',
    'xgboost'
  ), XgboostWins);
  choice.otherwise(LinearWins);


  /* Creating the definition of the step function by
  chaining steps for the step function */
  const definition= submitJob
    .next(processingJobTask)
    .next(parallel)
    .next(ComparisonTask)
    .next(choice)

  // creating the stepfunctions resource
  const blogStepFunction= new stepFunction.StateMachine(this,"abaloneStepFunction",{
    definition,
    role: stepFunctionsRole,
    timeout: cdk.Duration.minutes(60)
  })
    
  /*Lambda to invoke the step function
  this lambda is invoked once the dataset is divided*/
  const stateInvokeLambda= new lambda.Function(this,"InvokeStateMachine",{
        runtime: lambda.Runtime.PYTHON_3_8,
        functionName: "abalone-invokeStateMachine" + '-' + cdk.Aws.ACCOUNT_ID + '-' + cdk.Aws.REGION,
        code: lambda.Code.fromAsset('functions/invokeStateLambda'),
        handler: 'index.handler',
        environment:{
          stateMachineArn: blogStepFunction.stateMachineArn,
          accountId: cdk.Aws.ACCOUNT_ID
        }
      })

  // Invoke Lambda to start step function when object are uploaded
  blogBucket.addEventNotification(s3.EventType.OBJECT_CREATED_PUT,new s3Trigger.LambdaDestination(stateInvokeLambda),{ prefix: 'Inputs/'})
  blogStepFunction.grantStartExecution(stateInvokeLambda);
  }
}
