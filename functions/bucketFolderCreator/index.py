from __future__ import print_function
import json
import os
import boto3
import cfnresponse

client = boto3.client('s3')

def handler(event, context):
  ''' This function is a custom resource triggered once the s3 bucket created
  to create the folder structure within the bucket'''
  # printing out received event
  print('received event:')
  print(json.dumps(event))
  # getting bucket name from lambda environment variables
  bucket_name=os.environ['bucket']
  responseData = {}
  #check if the event is for the create of the stack then create the folders
  if event['RequestType']=="Create":
    # create the folder structure
    folders=['Inputs']
    try:
      for folder in folders:
          client.put_object(
                  Bucket=bucket_name,
                  Key=folder+'/'
              )
    except Exception as e:
          print(e)
          responseData['Message'] = 'Somthing went Wrong!'
          cfnresponse.send(event, context, cfnresponse.FAILED, responseData)
    responseData['Message'] = 'Created folders successfully!'
    cfnresponse.send(event, context, cfnresponse.SUCCESS, responseData)
  #check if the event is to delete the resource then acknowledge that event.
  elif event['RequestType']=="Delete":
    try:
      responseData['Message'] = 'delete event received'
      response = client.list_objects_v2(Bucket = bucket_name)
      if 'Contents' in response:
        file_paths = [ { 'Key': obj['Key']} for obj in response['Contents']]
        response = client.delete_objects(
        Bucket=bucket_name,
        Delete={
            'Objects': file_paths
        })
      cfnresponse.send(event, context, cfnresponse.SUCCESS, responseData)
    except Exception as e:
        print(e)
        responseData['Message'] = 'Somthing went Wrong!'
        cfnresponse.send(event, context, cfnresponse.FAILED, responseData)
  #check if the event is to update then do nothing.
  else:
    responseData['Message'] = 'No action is required!'
    cfnresponse.send(event, context, cfnresponse.SUCCESS, responseData)
  return responseData['Message']
