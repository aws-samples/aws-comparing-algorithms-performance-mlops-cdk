import json
import os
import boto3
import uuid

client = boto3.client('stepfunctions')

def handler(event, context):
  account_id=os.environ['accountId']
  input={
    'input': {
    'processing_jobname': 'dataset-processing-{}'.format(uuid.uuid1().hex),
    'xgb_jobname': 'xgb-regression-{}'.format(uuid.uuid1().hex), 
    'xgb_model_name': 'xgb-regression-{}'.format(uuid.uuid1().hex),
    'xgb_endpoint_name': 'xgb-regression-{}'.format(uuid.uuid1().hex),
    'll_jobname': 'll-regression-{}'.format(uuid.uuid1().hex),
    'll_model_name': 'll-regression-{}'.format(uuid.uuid1().hex),
    'll_endpoint_name': 'll-regression-{}'.format(uuid.uuid1().hex),
    'prod_endpoint_name': 'abaloneBlog-'+ account_id +'-regression-endpoint',
    }
  }
  sfn_arn=os.environ['stateMachineArn']
  client.start_execution(
    stateMachineArn=sfn_arn,
    input=json.dumps(input)
  )
