import socketio
import threading
import time
import json
import os
import argparse
import psutil
import statistics
import datetime
import matplotlib.pyplot as plt

# Default settings
SERVER_URL = "ws://localhost"
CONVERSATION_ID = "6810a51046d0da178e288364"
MESSAGES_PER_CLIENT = 10
DELAY_BETWEEN_MESSAGES = 0.1
TIMEOUT = 10  # seconds
CONNECTION = 10

# Global statistics
TOTAL_SENT = 0
TOTAL_RECEIVED = 0
TOTAL_ERRORS = 0
LATENCIES = []
SEND_TIMESTAMPS = {}
LOCK = threading.Lock()
START_TIME = 0

# Thêm biến theo dõi hiệu suất
CONVERSATION_SIZES = {}  # Lưu số người trong mỗi cuộc trò chuyện
LATENCY_BY_CONVERSATION = {}  # Lưu độ trễ theo từng cuộc trò chuyện
CPU_USAGE = []  # Lưu sử dụng CPU
MEMORY_USAGE = []  # Lưu sử dụng RAM
ERRORS_BY_TYPE = {}  # Lưu số lỗi theo loại
START_MONITORING = False  # Có bắt đầu theo dõi hiệu suất chưa

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

def monitor_system_resources():
    """Theo dõi tài nguyên hệ thống và lưu vào biến toàn cục"""
    global CPU_USAGE, MEMORY_USAGE, START_MONITORING
    
    while START_MONITORING:
        # Thu thập dữ liệu CPU và RAM
        cpu_percent = psutil.cpu_percent(interval=1)
        memory_info = psutil.virtual_memory()
        memory_percent = memory_info.percent
        
        CPU_USAGE.append(cpu_percent)
        MEMORY_USAGE.append(memory_percent)
        
        time.sleep(1)  # Cập nhật mỗi giây

def get_conversation_info(conversation_id, token):
    """Lấy thông tin về cuộc trò chuyện từ server"""
    try:
        import requests
        
        headers = {"Authorization": f"Bearer {token}"}
        url = f"{SERVER_URL.replace('ws://', 'http://').replace('wss://', 'https://')}/api/conversations/{conversation_id}"
        print(f"Đang lấy thông tin cuộc trò chuyện từ: {url}")
        
        response = requests.get(url, headers=headers)
        
        print(f"API Response status: {response.status_code}")
        if response.status_code == 200:
            data = response.json()
            participants = data.get("participants", [])
            size = len(participants)
            print(f"Đã tìm thấy {size} người tham gia trong cuộc trò chuyện")
            CONVERSATION_SIZES[conversation_id] = size
            return size
        else:
            print(f"Lỗi API: {response.text}")
        
        return 0
    except Exception as e:
        print(f"Lỗi khi lấy thông tin cuộc trò chuyện: {str(e)}")
        return 0

def create_client(token, index, conversation_id):
    global TOTAL_SENT, TOTAL_RECEIVED, TOTAL_ERRORS, LATENCIES, SEND_TIMESTAMPS, LOCK, LATENCY_BY_CONVERSATION

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
        join_payload = {
        "data": {
            "conversationId": conversation_id
            }
        }
        sio.emit("join_conversation", join_payload)
        print(f"[Client {index}] Joined conversation: {conversation_id}")
        # Thêm độ trễ nhỏ để đảm bảo server đã xử lý yêu cầu join_conversation
        def delayed_start():
            send_message_loop()
        
        # Đợi 0.5 giây trước khi bắt đầu gửi tin nhắn
        threading.Timer(0.5, delayed_start).start()

    @sio.event
    def disconnect():
        print(f"[Client {index}] Disconnected")

    @sio.event
    def connect_error(data):
        global TOTAL_ERRORS, ERRORS_BY_TYPE
        print(f"[Client {index}] Connection error: {data}")
        with LOCK:
            TOTAL_ERRORS += 1
            error_type = str(data)
            ERRORS_BY_TYPE[error_type] = ERRORS_BY_TYPE.get(error_type, 0) + 1

    @sio.on("new_message")
    def on_new_message(data):
        nonlocal messages_received, last_activity_time
        global TOTAL_RECEIVED, LATENCY_BY_CONVERSATION
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
                    
                    # Lưu độ trễ theo kích thước cuộc trò chuyện
                    conv_id = message.get("conversationId", conversation_id)
                    conv_size = CONVERSATION_SIZES.get(conv_id, "unknown")
                    
                    if conv_size not in LATENCY_BY_CONVERSATION:
                        LATENCY_BY_CONVERSATION[conv_size] = []
                        
                    LATENCY_BY_CONVERSATION[conv_size].append(latency * 1000)  # Chuyển sang ms
                    print(f"[Debug] Độ trễ: {latency * 1000:.2f}ms, Kích thước cuộc trò chuyện: {conv_size}")
                    
        messages_received += 1
        with LOCK:
            TOTAL_RECEIVED += 1
        # print(f"[Client {index}] Received: {message.get('content')}")

    @sio.on("join_conversation")
    def on_joined_conversation(data):
        nonlocal last_activity_time
        last_activity_time = time.time()  # Update activity time
        # print(f"[Client {index}] Successfully joined conversation: {data}")

    @sio.on("error")
    def on_error(data):
        global TOTAL_ERRORS, ERRORS_BY_TYPE
        print(f"[Client {index}] Socket Error: {data}")
        with LOCK:
            TOTAL_ERRORS += 1
            error_type = str(data)
            ERRORS_BY_TYPE[error_type] = ERRORS_BY_TYPE.get(error_type, 0) + 1

    try:
        sio.connect(f"{SERVER_URL}?token={token}", transports=["websocket"], wait=True)
        # Let the inactivity checker handle disconnection instead of using sleep
        sio.wait()  # Wait until disconnected
        print(f"[Client {index}] Sent: {messages_sent}, Received: {messages_received}")
    except Exception as e:
        print(f"[Client {index}] Error: {e}")
        with LOCK:
            TOTAL_ERRORS += 1
            error_type = str(e)
            ERRORS_BY_TYPE[error_type] = ERRORS_BY_TYPE.get(error_type, 0) + 1

def main():
    global MESSAGES_PER_CLIENT, DELAY_BETWEEN_MESSAGES, SERVER_URL, CONVERSATION_ID, START_TIME, START_MONITORING
    
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

    # Lấy thông tin cuộc trò chuyện
    if tokens:
        conversation_size = get_conversation_info(CONVERSATION_ID, tokens[0])
        print(f"Số người trong cuộc trò chuyện: {conversation_size}")
    
    # Bắt đầu theo dõi tài nguyên hệ thống
    START_MONITORING = True
    monitor_thread = threading.Thread(target=monitor_system_resources, daemon=True)
    monitor_thread.start()
    
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
        
    # Dừng theo dõi tài nguyên
    START_MONITORING = False
    if monitor_thread.is_alive():
        monitor_thread.join(timeout=1)

    duration = time.time() - START_TIME - TIMEOUT  # Subtract the inactivity check time
    avg_latency = sum(LATENCIES) / len(LATENCIES) if LATENCIES else 0
    min_latency = min(LATENCIES) if LATENCIES else 0
    max_latency = max(LATENCIES) if LATENCIES else 0
    send_rate = TOTAL_SENT / duration if duration > 0 else 0
    recv_rate = TOTAL_RECEIVED / duration if duration > 0 else 0

    # Hiển thị kết quả theo định dạng yêu cầu
    print("\n=== 5.3. Kết quả đạt được ===")
    
    print("Độ trễ:")
    if LATENCY_BY_CONVERSATION:
        for conv_size, latencies in LATENCY_BY_CONVERSATION.items():
            if latencies:
                avg_latency = statistics.mean(latencies)
                print(f"{'1-1' if conv_size == 2 else f'Nhóm'}: {avg_latency:.2f}ms{f' ({conv_size} thành viên)' if conv_size != 2 and conv_size != 'unknown' else ''}")
    else:
        # Sử dụng độ trễ tổng nếu không phân loại được theo kích thước
        if LATENCIES:
            avg_latency = statistics.mean([lat * 1000 for lat in LATENCIES])  # Chuyển sang ms
            print(f"Trung bình: {avg_latency:.2f}ms")
        else:
            print("Không có dữ liệu về độ trễ")
            
    print(f"\nDebug - LATENCIES: {len(LATENCIES)} mẫu")
    print(f"Debug - CONVERSATION_SIZES: {CONVERSATION_SIZES}")
    print(f"Debug - LATENCY_BY_CONVERSATION: {LATENCY_BY_CONVERSATION}")
    
    print("\nỔn định:")
    avg_cpu = statistics.mean(CPU_USAGE) if CPU_USAGE else 0
    avg_ram = statistics.mean(MEMORY_USAGE) if MEMORY_USAGE else 0
    print(f"{'Không lỗi' if TOTAL_ERRORS == 0 else f'Có {TOTAL_ERRORS} lỗi'}, tải CPU {avg_cpu:.1f}%, RAM < {avg_ram:.1f}%")
    
    print("\nHiệu năng:")
    print(f"Tổng số tin nhắn đã gửi: {TOTAL_SENT}")
    print(f"Tổng số tin nhắn đã nhận: {TOTAL_RECEIVED}")
    print(f"Tỉ lệ gửi thành công: {(TOTAL_RECEIVED/TOTAL_SENT*100):.2f}% ({TOTAL_RECEIVED}/{TOTAL_SENT})") if TOTAL_SENT > 0 else print("Không có tin nhắn nào được gửi")
    print(f"Thời gian kiểm tra: {duration:.2f} giây")
    print(f"Tốc độ gửi: {send_rate:.2f} msg/s")
    print(f"Tốc độ nhận: {recv_rate:.2f} msg/s")
    print(f"Độ trễ trung bình: {avg_latency:.2f} giây")
    print(f"Độ trễ tối thiểu: {min_latency:.2f} giây")
    print(f"Độ trễ tối đa: {max_latency:.2f} giây")
    print("Stress test completed.")
    
    # Vẽ biểu đồ hiệu suất (tùy chọn)
    # try:
    #     plt.figure(figsize=(10, 6))
    #     plt.subplot(2, 1, 1)
    #     plt.plot(CPU_USAGE, label='CPU %')
    #     plt.title('CPU Usage')
    #     plt.ylim(0, 100)
    #     plt.grid(True)
        
    #     plt.subplot(2, 1, 2)
    #     plt.plot(MEMORY_USAGE, label='RAM %')
    #     plt.title('Memory Usage')
    #     plt.ylim(0, 100)
    #     plt.grid(True)
        
    #     plt.tight_layout()
    #     plt.savefig(f'stress_test_result_{datetime.datetime.now().strftime("%Y%m%d_%H%M%S")}.png')
    #     print("\nBiểu đồ hiệu năng đã được lưu dưới dạng PNG.")
    # except Exception as e:
    #     print(f"Không thể tạo biểu đồ: {str(e)}")

if __name__ == "__main__":
    main()