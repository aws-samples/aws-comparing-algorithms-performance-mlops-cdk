import json
import os
import maps

def handler(event, context):
  region=os.environ['region']
  xgb_container = maps.xgb_map[region]+'/sagemaker-xgboost:1.0-1-cpu-py3'
  linear_container= maps.ll_map[region]+'/linear-learner:1'
  sagemaker_processing_container=maps.sagemaker_spark_image_map[region]
  return {
    'sagemaker_spark_image': sagemaker_processing_container,
    'xgb_image': xgb_container,
    'linear_image': linear_container
  }




