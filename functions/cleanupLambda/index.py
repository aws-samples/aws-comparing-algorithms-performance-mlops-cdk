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
        sagemakerclient.delete_endpoint(
            EndpointName=event["input"]["xgb_endpoint_name"]
        )
      except Exception as e:
          print(e)
      return {
          'messgae': 'Deleted xgboost endpoint successfully!'
      }
  elif "llresult" in event["training"].keys():
      try:
        sagemakerclient.delete_endpoint(
            EndpointName=event["input"]["ll_endpoint_name"]
        )
      except Exception as e:
          print(e)
      return {
          'messgae': 'Deleted Linear endpoint successfully!'
      }
  else:
      return {
          'message': 'something wrong has happened!'
      }

