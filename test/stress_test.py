import socketio
import threading
import time
import json
import os
import argparse

# Default settings
SERVER_URL = "ws://localhost:5000"
CONVERSATION_ID = "6810bd8de0906017ec1040cc"
MESSAGES_PER_CLIENT = 10
DELAY_BETWEEN_MESSAGES = 1
TIMEOUT = 60  # seconds
CONNECTION = 200

# Global statistics
TOTAL_SENT = 0
TOTAL_RECEIVED = 0
TOTAL_ERRORS = 0
LATENCIES = []
SEND_TIMESTAMPS = {}
LOCK = threading.Lock()
START_TIME = 0

def load_tokens(filename="user_tokens.json"):
    try:
        if os.path.exists(filename):
            with open(filename, "r") as file:
                data = json.load(file)
                if isinstance(data, list):
                    if isinstance(data[0], str):
                        return data
                    elif isinstance(data[0], dict) and "token" in data[0]:
                        return [user["token"] for user in data]
        if os.path.exists("tokens_only.json"):
            with open("tokens_only.json", "r") as file:
                return json.load(file)
    except Exception as e:
        print(f"Error loading tokens: {str(e)}")
    print("No valid token file found. Please run register_accounts.py first.")
    return []

def create_client(token, index, conversation_id):
    global TOTAL_SENT, TOTAL_RECEIVED, TOTAL_ERRORS, LATENCIES, SEND_TIMESTAMPS, LOCK

    sio = socketio.Client(logger=False, engineio_logger=False)
    messages_sent = 0
    messages_received = 0
    last_activity_time = 0
    disconnect_timer = None
    
    def check_inactivity():
        global TIMEOUT
        nonlocal last_activity_time
        if time.time() - last_activity_time >= TIMEOUT:
            print(f"[Client {index}] No activity for {TIMEOUT} seconds, disconnecting")
            sio.disconnect()
        else:
            # Schedule another check in 1 second
            threading.Timer(1, check_inactivity).start()

    def send_message_loop(count=0):
        nonlocal messages_sent, last_activity_time
        global TOTAL_SENT
        if count >= MESSAGES_PER_CLIENT:
            last_activity_time = time.time()  # Start counting inactivity after last message sent
            check_inactivity()  # Start the inactivity checker
            return
            
        message_id = f"{index}_{count}"
        message_payload = {
            "data": {
                "conversationId": conversation_id,
                "content": f"Msg {count+1} from client {index}",
                "messageId": message_id
            }
        }
        with LOCK:
            SEND_TIMESTAMPS[message_id] = time.time()
        sio.emit("send_message", message_payload)
        messages_sent += 1
        last_activity_time = time.time()  # Update activity time when sending
        with LOCK:
            TOTAL_SENT += 1
        threading.Timer(DELAY_BETWEEN_MESSAGES, send_message_loop, args=(count + 1,)).start()

    @sio.event
    def connect():
        print(f"[Client {index}] Connected")
        sio.emit("join_conversation", conversation_id)
        print(f"[Client {index}] Joined conversation: {conversation_id}")
        send_message_loop()

    @sio.event
    def disconnect():
        print(f"[Client {index}] Disconnected")

    @sio.event
    def connect_error(data):
        global TOTAL_ERRORS
        print(f"[Client {index}] Connection error: {data}")
        with LOCK:
            TOTAL_ERRORS += 1

    @sio.on("new_message")
    def on_new_message(data):
        nonlocal messages_received, last_activity_time
        global TOTAL_RECEIVED
        last_activity_time = time.time()  # Update activity time when receiving
        
        latency = 0
        message = data.get("message", {})
        message_id = message.get("messageId")
        if message_id:
            with LOCK:
                sent_time = SEND_TIMESTAMPS.pop(message_id, None)
                if sent_time:
                    latency = time.time() - sent_time
                    LATENCIES.append(latency)
        messages_received += 1
        with LOCK:
            TOTAL_RECEIVED += 1
        # print(f"[Client {index}] Received: {message.get('content')}")

    @sio.on("joined_conversation")
    def on_joined_conversation(data):
        nonlocal last_activity_time
        last_activity_time = time.time()  # Update activity time
        # print(f"[Client {index}] Successfully joined conversation: {data}")

    @sio.on("error")
    def on_error(data):
        print(f"[Client {index}] Socket Error: {data}")

    try:
        sio.connect(f"{SERVER_URL}?token={token}", transports=["websocket"], wait=True)
        # Let the inactivity checker handle disconnection instead of using sleep
        sio.wait()  # Wait until disconnected
        print(f"[Client {index}] Sent: {messages_sent}, Received: {messages_received}")
    except Exception as e:
        print(f"[Client {index}] Error: {e}")

def main():
    global MESSAGES_PER_CLIENT, DELAY_BETWEEN_MESSAGES, SERVER_URL, CONVERSATION_ID, START_TIME

    parser = argparse.ArgumentParser(description="WebSocket stress test")
    parser.add_argument("--url", default=SERVER_URL, help="WebSocket server URL")
    parser.add_argument("--conversation", default=CONVERSATION_ID, help="Conversation ID to use")
    parser.add_argument("--messages", type=int, default=MESSAGES_PER_CLIENT, help="Messages per client")
    parser.add_argument("--delay", type=float, default=DELAY_BETWEEN_MESSAGES, help="Delay between messages (seconds)")
    parser.add_argument("--token-file", default="user_tokens.json", help="File containing tokens")
    parser.add_argument("--clients", type=int, default=0, help="Number of clients (0 means use all available tokens)")

    args = parser.parse_args()
    SERVER_URL = args.url
    CONVERSATION_ID = args.conversation
    MESSAGES_PER_CLIENT = args.messages
    DELAY_BETWEEN_MESSAGES = args.delay

    tokens = load_tokens(args.token_file)
    if not tokens:
        print("No tokens available. Please run register_accounts.py first.")
        return

    num_clients = args.clients if args.clients > 0 else len(tokens)
    num_clients = min(num_clients, len(tokens), CONNECTION)  # Limit to available tokens or CONNECTION

    print(f"\n=== Starting WebSocket Stress Test ===")
    print(f"Server URL: {SERVER_URL}")
    print(f"Conversation ID: {CONVERSATION_ID}")
    print(f"Number of clients: {num_clients}")
    print(f"Messages per client: {MESSAGES_PER_CLIENT}")
    print(f"Delay between messages: {DELAY_BETWEEN_MESSAGES}s")
    print("=====================================\n")

    START_TIME = time.time()
    threads = []
    for i in range(num_clients):
        if i >= CONNECTION:  # Limit to CONNECTION clients for testing
            break
        t = threading.Thread(target=create_client, args=(tokens[i], i, CONVERSATION_ID))
        threads.append(t)
        t.start()

    for t in threads:
        t.join()

    duration = time.time() - START_TIME - TIMEOUT  # Subtract the inactivity check time
    avg_latency = sum(LATENCIES) / len(LATENCIES) if LATENCIES else 0
    min_latency = min(LATENCIES) if LATENCIES else 0
    max_latency = max(LATENCIES) if LATENCIES else 0
    send_rate = TOTAL_SENT / duration if duration > 0 else 0
    recv_rate = TOTAL_RECEIVED / duration if duration > 0 else 0

    print("\n=== Test Results ===")
    print(f"Total messages sent:     {TOTAL_SENT}")
    print(f"Total messages received: {TOTAL_RECEIVED}")
    print(f"Total connection errors: {TOTAL_ERRORS}")
    print(f"Total test duration:     {duration:.2f} seconds")
    print(f"Send rate:               {send_rate:.2f} msg/s")
    print(f"Receive rate:            {recv_rate:.2f} msg/s")
    # print(f"Latency (avg/min/max):   {avg_latency*1000:.2f} / {min_latency*1000:.2f} / {max_latency*1000:.2f} ms")
    print("Stress test completed.")

if __name__ == "__main__":
    main()
