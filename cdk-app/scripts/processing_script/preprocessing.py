from __future__ import print_function
from __future__ import unicode_literals

import argparse
import os
import pyspark
from pyspark.sql import SparkSession
from pyspark.sql.functions import *
from pyspark.sql.types import (
    DoubleType,
    StringType,
    StructField,
    StructType,
    IntegerType
)
import boto3

client = boto3.client('s3')

def main():
    parser = argparse.ArgumentParser(description="app inputs and outputs")
    parser.add_argument("--s3_input_bucket", type=str, help="s3 input bucket")
    parser.add_argument("--s3_input_key_prefix", type=str, help="s3 input key prefix")
    parser.add_argument("--s3_output_bucket", type=str, help="s3 output bucket")
    args = parser.parse_args()

    # listing all old files if any to delete them and create a new dataset
    response = client.list_objects_v2(Bucket = args.s3_output_bucket)
    file_keys = [ obj['Key'] for obj in response['Contents'] if (obj['Key'].find('Xgboost')!=-1 or obj['Key'].find('Linear')!=-1 or obj['Key'].find('folder')!=-1)]
    #print("keys found are: " + str(file_keys))
    #delete any old files before running the job
    if len(file_keys)!=0:
        for key in file_keys:
            client.delete_object(Bucket=args.s3_output_bucket, Key=key)

    spark = SparkSession.builder.appName("PySparkApp").getOrCreate()

    # This is needed to save RDDs which is the only way to write nested Dataframes into CSV format
    spark.sparkContext._jsc.hadoopConfiguration().set("mapred.output.committer.class",
                                                    "org.apache.hadoop.mapred.FileOutputCommitter")
    spark.sparkContext._jsc.hadoopConfiguration().set("mapreduce.fileoutputcommitter.marksuccessfuljobs", "false")

    # Defining the schema corresponding to the input data. The input data does not contain the headers
    schema = StructType([StructField("rings", IntegerType(), True),
                        StructField("sex", StringType(), True), 
                        StructField("length", StringType(), True),
                        StructField("diameter", StringType(), True),
                        StructField("height", StringType(), True),
                        StructField("whole_weight", StringType(), True),
                        StructField("shucked_weight", StringType(), True),
                        StructField("viscera_weight", StringType(), True), 
                        StructField("shell_weight", StringType(), True)])

    # Downloading the data from S3 into a Dataframe
    total_df = spark.read.csv(('s3://' + os.path.join(args.s3_input_bucket,args.s3_input_key_prefix ,
                                                '*')), header=False, schema=schema, sep=' ')

    # Split the overall dataset into 70-15-15 training , validation and testing
    (xg_train_df, xg_validation_df, xg_test_df) = total_df.randomSplit([0.7, 0.15,0.15])

    # Convert the train dataframe to RDD to save in CSV format and upload to S3
    xg_train_df.coalesce(1).write.csv(('s3://' + os.path.join(args.s3_output_bucket, 'Xgboost', 'train')),sep=' ')

    # Convert the validation dataframe to RDD to save in CSV format and upload to S3
    xg_validation_df.coalesce(1).write.csv(('s3://' + os.path.join(args.s3_output_bucket, 'Xgboost', 'validation')),sep=' ')

    # Convert the validation dataframe to RDD to save in CSV format and upload to S3
    xg_test_df.coalesce(1).write.csv(('s3://' + os.path.join(args.s3_output_bucket, 'Xgboost', 'test')),sep=' ')
    


    #lambda function to split the <feature_number>:<feature_value> format into double type
    chop_value = udf(lambda x: x.split(":")[1], StringType())


    #looping on all feature to split except the rings
    features=['sex','length','diameter','height','whole_weight','shucked_weight','viscera_weight','shell_weight']

    for feature in features:
        total_df=total_df.withColumn(feature,chop_value(total_df[feature]))

    # Split the overall dataset into 70-15-15 training , validation and testing
    (ll_train_df, ll_validation_df, ll_test_df) = total_df.randomSplit([0.7, 0.15,0.15])



    # Convert the train dataframe to RDD to save in CSV format and upload to S3
    ll_train_df.coalesce(1).write.csv('s3://' + os.path.join(args.s3_output_bucket, 'Linear', 'train'))

    # Convert the validation dataframe to RDD to save in CSV format and upload to S3
    ll_validation_df.coalesce(1).write.csv('s3://' + os.path.join(args.s3_output_bucket, 'Linear', 'validation'))

    # Convert the validation dataframe to RDD to save in CSV format and upload to S3
    ll_test_df.coalesce(1).write.csv('s3://' + os.path.join(args.s3_output_bucket, 'Linear', 'test'))

    # Delete any *_$folder$ files created
    response = client.list_objects_v2(Bucket = args.s3_output_bucket)
    file_keys = [ obj['Key'] for obj in response['Contents'] if (obj['Key'].find('folder')!=-1)]
    #print("keys found are: " + str(file_keys))
    #delete any old files before running the job
    if len(file_keys)!=0:
        for key in file_keys:
            client.delete_object(Bucket=args.s3_output_bucket, Key=key)

if __name__ == "__main__":
    main()