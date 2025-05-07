import json
import csv
import os
import sys

def convert_tokens_to_csv(input_file="tokens_only.json", output_file="tokens_simple.csv"):
    """
    Convert a JSON file containing just tokens to a simple CSV file.
    Each token will be on its own line in the CSV file.
    """
    # Check if input file exists
    if not os.path.exists(input_file):
        print(f"Error: Input file '{input_file}' not found.")
        return False
    
    try:
        # Read tokens from JSON file
        with open(input_file, 'r') as json_file:
            tokens = json.load(json_file)
        
        # Check if tokens is a list
        if not isinstance(tokens, list):
            print(f"Error: Expected a list of tokens in '{input_file}'.")
            return False
        
        # Write tokens to CSV file
        with open(output_file, 'w', newline='') as csv_file:
            writer = csv.writer(csv_file)
            writer.writerow(["token"])  # Header
            for token in tokens:
                writer.writerow([token])
        
        print(f"Successfully converted {len(tokens)} tokens from '{input_file}' to '{output_file}'.")
        return True
    
    except json.JSONDecodeError:
        print(f"Error: '{input_file}' is not a valid JSON file.")
    except Exception as e:
        print(f"Error: {str(e)}")
    
    return False

if __name__ == "__main__":
    # Get input and output file names from command line arguments
    input_file = "tokens_only.json"
    output_file = "tokens.csv"
    
    if len(sys.argv) > 1:
        input_file = sys.argv[1]
    if len(sys.argv) > 2:
        output_file = sys.argv[2]
    
    convert_tokens_to_csv(input_file, output_file)