from __future__ import print_function
import json
import os
import boto3
import uuid
import random
import math

sagemakerclient = boto3.client('sagemaker')

def handler(event, context):
  if "xgboostresult" in event["training"].keys():
      try:
        endpoint_name=event["input"]["xgb_endpoint_name"]
        sagemakerclient.delete_endpoint(
            EndpointName=endpoint_name
        )
        print(f"deleted endpoint {endpoint_name} successfully!")
      except Exception as e:
          print(e)
      return {
          'message': 'Deleted xgboost endpoint successfully!'
      }
  elif "llresult" in event["training"].keys():
      try:
        endpoint_name=event["input"]["ll_endpoint_name"]
        sagemakerclient.delete_endpoint(
            EndpointName=endpoint_name
        )
        print(f"deleted endpoint {endpoint_name} successfully!")
      except Exception as e:
          print(e)
      return {
          'message': 'Deleted Linear endpoint successfully!'
      }
  else:
      return {
          'message': 'something wrong has happened!'
      }

