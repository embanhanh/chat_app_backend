# python register_accounts.py --count 10 --base-url http://localhost:5000/api --output user_tokens.json

import requests
import json
import random
import string
import os
import argparse

def generate_random_username(min_length=3, max_length=10):
    """Generate a random username of specified length."""
    length = random.randint(min_length, max_length)
    # Start with a letter
    username = random.choice(string.ascii_lowercase)
    # Add remaining characters (can be letters or numbers)
    username += ''.join(random.choice(string.ascii_lowercase + string.digits) for _ in range(length-1))
    return username

def generate_random_email(username):
    """Generate a random email using the username."""
    domains = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "example.com"]
    domain = random.choice(domains)
    return f"{username}@{domain}"

def register_user(base_url, username, email, password):
    """Register a new user and return the response."""
    url = f"{base_url}/auth/register"
    payload = {
        "username": username,
        "email": email,
        "password": password
    }
    headers = {
        "Content-Type": "application/json"
    }
    
    response = requests.post(url, json=payload, headers=headers)
    return response

def save_tokens_to_file(tokens, filename="user_tokens.json"):
    """Save the tokens to a JSON file."""
    with open(filename, "w") as file:
        json.dump(tokens, file, indent=2)
    print(f"Tokens saved to {filename}")

def main():
    parser = argparse.ArgumentParser(description="Register multiple accounts and save tokens")
    parser.add_argument("--count", type=int, default=5, help="Number of accounts to register")
    parser.add_argument("--base-url", type=str, default="http://localhost:5000/api", help="Base URL of the API")
    parser.add_argument("--password", type=str, default="123456", help="Password for all accounts")
    parser.add_argument("--output", type=str, default="user_tokens.json", help="Output file for tokens")
    
    args = parser.parse_args()
    
    print(f"Registering {args.count} accounts...")
    
    # Store successful registrations
    registered_users = []
    
    for i in range(args.count):
        # Generate unique username and email
        while True:
            username = generate_random_username()
            email = generate_random_email(username)
            
            # Try registering
            try:
                response = register_user(args.base_url, username, email, args.password)
                
                # Check if registration was successful
                if response.status_code == 201:
                    data = response.json()
                    token = data.get("token")
                    user_id = data.get("user", {}).get("_id")
                    
                    print(f"[{i+1}/{args.count}] Successfully registered: {username} ({email})")
                    registered_users.append({
                        "id": user_id,
                        "username": username,
                        "email": email,
                        "token": token
                    })
                    break
                else:
                    # If username or email already exists, try again with new values
                    error_msg = response.json().get("message", "Unknown error")
                    if "duplicate key" in error_msg:
                        print(f"Username or email already exists, trying another...")
                        continue
                    else:
                        print(f"Registration failed: {error_msg}")
                        break
                        
            except Exception as e:
                print(f"Error during registration: {str(e)}")
                break
    
    # Save all tokens to file
    if registered_users:
        save_tokens_to_file(registered_users, args.output)
        
        # Also create a file with just the tokens for easy use
        tokens_only = [user["token"] for user in registered_users]
        with open("tokens_only.json", "w") as f:
            json.dump(tokens_only, f, indent=2)
        print(f"Token list saved to tokens_only.json")
        
        # Export to CSV for easy viewing in spreadsheet software
        import csv
        with open("tokens.csv", "w", newline="") as csvfile:
            fieldnames = ["id", "username", "email", "token"]
            writer = csv.DictWriter(csvfile, fieldnames=fieldnames)
            writer.writeheader()
            for user in registered_users:
                writer.writerow(user)
        print(f"Token list saved to tokens.csv")
    else:
        print("No users were registered successfully")

if __name__ == "__main__":
    main()