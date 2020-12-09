from __future__ import print_function
import subprocess
import sys

#check if module requests is present and install if it is not
try:
    import requests
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", 'requests'])
    import requests


# Load the dataset
source_data = 'abalone_dataset.csv'

with open(source_data, 'wb') as file:
    print("Downloading dataset file, this might take couple of minutes...")
    response=requests.get("https://www.csie.ntu.edu.tw/~cjlin/libsvmtools/datasets/regression/abalone", stream=True)
    total_length = response.headers.get('content-length')
    if total_length is None: # no content length header
        file.write(response.content)
    else:
        dl = 0
        total_length = int(total_length)
        for data in response.iter_content(chunk_size=4096):
            dl += len(data)
            file.write(data)
            done = int(50 * dl / total_length)
            sys.stdout.write("\r[%s%s]" % ('=' * done, ' ' * (50-done)) )    
            sys.stdout.flush()
        sys.stdout.write("\n")
#divide the data into two files
data=[l for l in open(source_data,'r')]
middle_point=len(data)//2

output_files= ['dataset1.csv','dataset2.csv']
output_data=[data[:middle_point], data[middle_point:]]
for index,outfile in enumerate(output_files):
    with open(outfile, 'w') as to_write:
        for line in output_data[index]:
            to_write.write(line)
        #printing the success of file creation
    print(f"Half of the data saved successfully to {outfile}")

