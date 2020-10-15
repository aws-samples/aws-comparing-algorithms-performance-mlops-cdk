import json

def handler(event, context):
  print("received event: "+ json.dumps(event))
  xgboostresult=float(event[0]['prediction']['xgboostresult']['Payload']['prediction_result'])
  llresult=float(event[1]['prediction']['llresult']['Payload']['prediction_result'])
  if xgboostresult >= llresult :
      return {
          'winnerAlgorithm': 'xgboost',
          'xgboostresult': str(xgboostresult),
          'llresult': str(llresult)
      }
  else:
      return {
          'winnerAlgorithm': 'linear',
          'xgboostresult': str(xgboostresult),
          'llresult': str(llresult)
      }

