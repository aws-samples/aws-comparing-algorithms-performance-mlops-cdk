from __future__ import print_function
import json
import os
import boto3
import uuid
import random
import math

sagemakerclient = boto3.client('sagemaker-runtime')
s3client=boto3.client('s3')

def handler(event, context):
  bucket_name=os.environ['bucket']
  prediction_trials=3
  if "xgboostresult" in event["training"].keys():
      prefix='xgboost_dataset'
      response = s3client.list_objects_v2(Bucket = bucket_name)
      file_keys = [obj['Key'] for obj in response['Contents'] if (obj['Key'].find('Xgboost/test')!=-1)]
      file_key=file_keys[0]
      location='/tmp/' + prefix
      try:
          os.mkdir(location)
      except FileExistsError:
        print("Directory already created!")
      # downloading the testing samples file for linear model
      try:
          s3client.download_file(bucket_name,file_key, location + '/' + 'testing_sample.csv')
      except Exception as e:
          print('Unable to download file!')
      file_test=location + '/' + 'testing_sample.csv'
      test_data = [l for l in open(file_test, 'r')]
      sum=0
      successful_predictions=prediction_trials
      for _ in range(1,prediction_trials+1):
        #selecting a random sample to perform prediction
        sample=random.choice(test_data).split(' ')
        actual_age=sample[0]
        payload=sample[1:] #removing actual age from the sample
        payload=' '.join(map(str, payload))
        try:
            response=sagemakerclient.invoke_endpoint(
                    EndpointName=event["input"]["xgb_endpoint_name"],
                    ContentType='libsvm',
                    Body=payload
            )
            result=json.loads(response['Body'].read().decode())
            accuracy=str(round(100-((abs(float(result)-float(actual_age))/float(actual_age))*100),2))
            sum=sum+float(accuracy)
        except Exception as e:
            print(e)
            successful_predictions-=1
      xgboost_avg_final_accuarcy=sum/successful_predictions
      return {
          'prediction_result': xgboost_avg_final_accuarcy,
          'endpoint_name': event["input"]["xgb_endpoint_name"]
      }
  elif "llresult" in event["training"].keys():
      prefix='ln_dataset'
      response = s3client.list_objects_v2(Bucket = bucket_name)
      file_keys = [obj['Key'] for obj in response['Contents'] if (obj['Key'].find('Linear/test')!=-1)]
      file_key=file_keys[0]
      location='/tmp/' + prefix
      try:
          os.mkdir(location)
      except FileExistsError:
        print("Directory already created!")
      # downloading the testing samples file for linear model
      try:
          s3client.download_file(bucket_name,file_key, location + '/' + 'testing_sample.csv')
      except Exception as e:
          print('Unable to download file!')
      file_test=location + '/' + 'testing_sample.csv'
      test_data = [l for l in open(file_test, 'r')]
      sum=0
      successful_predictions=prediction_trials
      for _ in range(1,prediction_trials+1):
        #selecting a random sample to perform prediction
        sample=random.choice(test_data).split(',')
        actual_age=sample[0]
        payload=sample[1:] #removing actual age from the sample
        payload=','.join(map(str, payload))
        try:
            response=sagemakerclient.invoke_endpoint(
                    EndpointName=event["input"]["ll_endpoint_name"],
                    ContentType='text/csv',
                    Body=payload
            )
            result=json.loads(response['Body'].read().decode())
            linear_result=result['predictions'][0]['score']
            accuracy=str(round(100-((abs(float(linear_result)-float(actual_age))/float(actual_age))*100),2))
            sum=sum+float(accuracy)
        except Exception as e:
            print(e)
            successful_predictions-=1
      linear_avg_final_accuarcy=sum/successful_predictions
      return {
          'prediction_result': linear_avg_final_accuarcy,
          'endpoint_name': event["input"]["ll_endpoint_name"]
      }
  else:
      return {
          'message': 'something wrong has happened!'
      }

