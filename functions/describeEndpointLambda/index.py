from __future__ import print_function
import json
import os
import boto3
import time

sagemakerclient = boto3.client('sagemaker')


def handler(event, context):
  if "xgboostresult" in event["training"].keys():
    try:
        response = sagemakerclient.describe_endpoint(
            EndpointName=event["input"]["xgb_endpoint_name"]
        )
    except Exception as e:
        print(e)
    endpoint_status=response['EndpointStatus']
    return {
        'endpoint_status': endpoint_status
    }
  elif "llresult" in event["training"].keys():
    try:
        response = sagemakerclient.describe_endpoint(
            EndpointName=event["input"]["ll_endpoint_name"]
        )
    except Exception as e:
        print(e)
    endpoint_status=response['EndpointStatus']
    return {
        'endpoint_status': endpoint_status
    }
  else:
      return {
          'message': 'something wrong has happened!'
      }


