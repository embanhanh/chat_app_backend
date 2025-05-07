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
import matplotlib
matplotlib.use('Agg') # Sử dụng backend 'Agg' để tránh lỗi GUI trong môi trường không có X server

# Default settings
DEFAULT_SERVER_URL = "ws://localhost" # Cập nhật cổng nếu cần
DEFAULT_CONVERSATION_ID = "6810a51046d0da178e288364" # ID ví dụ
DEFAULT_MESSAGES_PER_CLIENT = 10
DEFAULT_MAX_FORWARDS_PER_CLIENT = 5 # Số lần tối đa một client sẽ forward tin nhắn
DEFAULT_DELAY_BETWEEN_MESSAGES = 1 # Giảm delay để test nhanh hơn
DEFAULT_TIMEOUT = 10  # Giảm timeout để thấy hiệu ứng nhanh hơn (giây)
DEFAULT_CLIENT_COUNT = 10 # Số client mặc định

# Global statistics
TOTAL_SENT = 0
TOTAL_RECEIVED = 0
TOTAL_ERRORS = 0
TIMEOUT_CLIENT_COUNT = 0
LATENCIES = []
SEND_TIMESTAMPS = {} # {message_id: send_timestamp}
LOCK = threading.Lock() # Lock cho các biến toàn cục trên
START_TIME = 0

# Dữ liệu để vẽ biểu đồ
TIMESTAMPS_FOR_PLOTS = []
CPU_USAGE_OVER_TIME = []
MEMORY_USAGE_OVER_TIME = []
MSGS_SENT_PER_SECOND = []
MSGS_RECEIVED_PER_SECOND = []

# Biến theo dõi hiệu suất (đã có trong code gốc, giữ lại và tích hợp)
CONVERSATION_SIZES = {}
LATENCY_BY_CONVERSATION = {} # {conversation_size: [latencies_in_ms]}
ERRORS_BY_TYPE = {} # {error_string: count}
START_MONITORING = False

# Biến tạm để tính toán rate trong monitor_system_resources
LAST_SAMPLED_TOTAL_SENT = 0
LAST_SAMPLED_TOTAL_RECEIVED = 0

def load_tokens(filename="user_tokens.json"):
    try:
        if os.path.exists(filename):
            with open(filename, "r") as file:
                data = json.load(file)
                if isinstance(data, list):
                    if not data: return []
                    if isinstance(data[0], str):
                        return data
                    elif isinstance(data[0], dict) and "token" in data[0]:
                        return [user["token"] for user in data]
        # Fallback to tokens_only.json if user_tokens.json is not in the expected format or not found
        if os.path.exists("tokens_only.json"):
            with open("tokens_only.json", "r") as file:
                return json.load(file)
    except Exception as e:
        print(f"Lỗi khi tải tokens: {str(e)}")
    print("Không tìm thấy file token hợp lệ. Vui lòng chạy register_accounts.py trước.")
    return []

def monitor_system_resources():
    global CPU_USAGE_OVER_TIME, MEMORY_USAGE_OVER_TIME, START_MONITORING
    global LAST_SAMPLED_TOTAL_SENT, LAST_SAMPLED_TOTAL_RECEIVED, TOTAL_SENT, TOTAL_RECEIVED
    global TIMESTAMPS_FOR_PLOTS, MSGS_SENT_PER_SECOND, MSGS_RECEIVED_PER_SECOND, LOCK, START_TIME

    while START_MONITORING:
        # Thu thập dữ liệu CPU và RAM
        cpu_percent = psutil.cpu_percent(interval=None) # interval=None để không block
        memory_info = psutil.virtual_memory()
        memory_percent = memory_info.percent
        
        current_time_relative = time.time() - START_TIME
        
        with LOCK: # Đảm bảo truy cập an toàn đến các biến toàn cục
            CPU_USAGE_OVER_TIME.append(cpu_percent)
            MEMORY_USAGE_OVER_TIME.append(memory_percent)
            TIMESTAMPS_FOR_PLOTS.append(current_time_relative)

            current_total_sent = TOTAL_SENT
            current_total_received = TOTAL_RECEIVED
        
        sent_in_interval = current_total_sent - LAST_SAMPLED_TOTAL_SENT
        received_in_interval = current_total_received - LAST_SAMPLED_TOTAL_RECEIVED
        
        MSGS_SENT_PER_SECOND.append(sent_in_interval) # Giả sử vòng lặp chạy mỗi giây
        MSGS_RECEIVED_PER_SECOND.append(received_in_interval)
        
        LAST_SAMPLED_TOTAL_SENT = current_total_sent
        LAST_SAMPLED_TOTAL_RECEIVED = current_total_received
        
        time.sleep(1) # Cập nhật mỗi giây

def get_conversation_info(conversation_id, token, server_url_http):
    """Lấy thông tin về cuộc trò chuyện từ server"""
    try:
        import requests
        headers = {"Authorization": f"Bearer {token}"}
        url = f"{server_url_http}/api/conversations/{conversation_id}"
        # print(f"Đang lấy thông tin cuộc trò chuyện từ: {url}")
        
        response = requests.get(url, headers=headers, timeout=10)
        
        # print(f"API Response status: {response.status_code}")
        if response.status_code == 200:
            data = response.json()
            participants = data.get("participants", [])
            size = len(participants)
            # print(f"Đã tìm thấy {size} người tham gia trong cuộc trò chuyện")
            CONVERSATION_SIZES[conversation_id] = size
            return size
        else:
            print(f"Lỗi API khi lấy thông tin cuộc trò chuyện ({conversation_id}): {response.status_code} - {response.text}")
    except requests.exceptions.RequestException as e:
        print(f"Lỗi mạng khi lấy thông tin cuộc trò chuyện ({conversation_id}): {str(e)}")
    except Exception as e:
        print(f"Lỗi không xác định khi lấy thông tin cuộc trò chuyện ({conversation_id}): {str(e)}")
    return 0


def create_client(token, client_idx, conversation_id_to_join, server_url_ws, cli_args):
    global TOTAL_SENT, TOTAL_RECEIVED, TOTAL_ERRORS, TIMEOUT_CLIENT_COUNT
    global LATENCIES, SEND_TIMESTAMPS, LOCK, LATENCY_BY_CONVERSATION, ERRORS_BY_TYPE

    sio = socketio.Client(logger=False, engineio_logger=False, ssl_verify=False) # ssl_verify=False nếu dùng wss với cert tự ký

    client_state = {
        'id': client_idx,
        'messages_sent_initial': 0,
        'messages_sent_forwarded': 0,
        'messages_received': 0,
        'last_message_sent_time': None, # Thời điểm client này gửi tin nhắn cuối cùng
        'last_message_received_time': time.time(), # Khởi tạo để tránh timeout ngay lập tức
        'is_timed_out': False,
        'timeout_monitor_timer': None,
        'has_started_sending': False, # Kích hoạt giám sát timeout chỉ sau khi gửi tin đầu tiên
        'sio_instance': sio
    }

    def schedule_timeout_monitor():
        if client_state['is_timed_out'] or not client_state['sio_instance'].connected:
            return

        # Hủy timer cũ nếu có để tránh chồng chéo
        if client_state['timeout_monitor_timer'] and client_state['timeout_monitor_timer'].is_alive():
            client_state['timeout_monitor_timer'].cancel()
            
        client_state['timeout_monitor_timer'] = threading.Timer(1.0, run_timeout_check) # Kiểm tra mỗi giây
        client_state['timeout_monitor_timer'].daemon = True
        client_state['timeout_monitor_timer'].start()

    def run_timeout_check():
        nonlocal client_state # Đảm bảo client_state được cập nhật
        global TIMEOUT_CLIENT_COUNT, LOCK

        if client_state['is_timed_out'] or not client_state['sio_instance'].connected:
            return

        # Chỉ kiểm tra timeout nếu client đã gửi gì đó và đang chờ phản hồi (hoặc tin nhắn mới)
        if client_state['has_started_sending'] and client_state['last_message_sent_time'] is not None:
            time_since_last_send = time.time() - client_state['last_message_sent_time']
            
            # Điều kiện timeout: Đã gửi tin nhắn, và ( (không nhận được gì kể từ lúc gửi đó) HOẶC (lần nhận cuối cùng quá xa so với lần gửi cuối) )
            # và thời gian chờ đã vượt quá TIMEOUT.
            # Chính xác hơn: nếu sau khi gửi, không nhận được tin nhắn nào trong khoảng TIMEOUT.
            if time_since_last_send > cli_args.timeout:
                # Kiểm tra xem có tin nhắn nào được nhận *sau* lần gửi cuối cùng không
                if client_state['last_message_received_time'] < client_state['last_message_sent_time']:
                    print(f"[Client {client_state['id']}] Timeout: Không nhận được tin nhắn mới trong {cli_args.timeout}s sau khi gửi. Ngắt kết nối.")
                    client_state['is_timed_out'] = True
                    with LOCK:
                        TIMEOUT_CLIENT_COUNT += 1
                    client_state['sio_instance'].disconnect()
                    return # Dừng timer và thoát

        # Lên lịch kiểm tra tiếp theo nếu vẫn còn kết nối và chưa timeout
        if client_state['sio_instance'].connected and not client_state['is_timed_out']:
            schedule_timeout_monitor()


    def send_message_internal(content, type_prefix="msg"):
        nonlocal client_state # Đảm bảo client_state được cập nhật
        global TOTAL_SENT, SEND_TIMESTAMPS, LOCK
        
        if not client_state['sio_instance'].connected or client_state['is_timed_out']:
            return

        msg_counter = client_state['messages_sent_initial'] if type_prefix == "init" else client_state['messages_sent_forwarded']
        message_id = f"{type_prefix}_{client_state['id']}_{msg_counter}"
        
        message_payload = {
            "data": {
                "conversationId": conversation_id_to_join,
                "content": content,
                "messageId": message_id
            }
        }
        
        with LOCK:
            SEND_TIMESTAMPS[message_id] = time.time()
        
        # print(f"[Client {client_state['id']}] Sending {type_prefix}: {content}")
        client_state['sio_instance'].emit("send_message", message_payload)
        
        client_state['last_message_sent_time'] = time.time()
        client_state['has_started_sending'] = True

        if type_prefix == "init":
            client_state['messages_sent_initial'] += 1
        elif type_prefix == "fwd":
            client_state['messages_sent_forwarded'] += 1
        
        with LOCK:
            TOTAL_SENT += 1
        
        # Kích hoạt/làm mới bộ đếm thời gian timeout sau mỗi lần gửi
        if client_state['sio_instance'].connected and not client_state['is_timed_out']:
             schedule_timeout_monitor()


    def send_initial_messages_loop(count=0):
        nonlocal client_state # Đảm bảo client_state được cập nhật
        
        if count >= cli_args.messages or not client_state['sio_instance'].connected or client_state['is_timed_out']:
            # Kết thúc gửi tin nhắn ban đầu, bộ giám sát timeout sẽ xử lý phần còn lại
            # print(f"[Client {client_state['id']}] Finished initial burst of messages.")
            return

        content = f"Msg {count+1} from client {client_state['id']}"
        send_message_internal(content, type_prefix="init")
        
        if client_state['sio_instance'].connected and not client_state['is_timed_out']:
            threading.Timer(cli_args.delay, send_initial_messages_loop, args=(count + 1,)).start()

    @sio.event
    def connect():
        print(f"[Client {client_state['id']}] Đã kết nối tới server.")
        join_payload = {"data": {"conversationId": conversation_id_to_join}}
        sio.emit("join_conversation", join_payload)
        # print(f"[Client {client_state['id']}] Đã tham gia cuộc trò chuyện: {conversation_id_to_join}")
        
        client_state['last_message_received_time'] = time.time() # Reset khi kết nối thành công

        # Bắt đầu gửi tin nhắn sau một khoảng trễ nhỏ
        threading.Timer(0.5, send_initial_messages_loop).start()
        # Bắt đầu giám sát timeout (sẽ chỉ thực sự hoạt động sau khi has_started_sending=True)
        schedule_timeout_monitor()


    @sio.event
    def disconnect():
        print(f"[Client {client_state['id']}] Đã ngắt kết nối.")
        if client_state['timeout_monitor_timer'] and client_state['timeout_monitor_timer'].is_alive():
            client_state['timeout_monitor_timer'].cancel()

    @sio.event
    def connect_error(data):
        global TOTAL_ERRORS, ERRORS_BY_TYPE, LOCK
        error_msg = str(data) if data else "Unknown connection error"
        print(f"[Client {client_state['id']}] Lỗi kết nối: {error_msg}")
        with LOCK:
            TOTAL_ERRORS += 1
            ERRORS_BY_TYPE[error_msg] = ERRORS_BY_TYPE.get(error_msg, 0) + 1
        if client_state['timeout_monitor_timer'] and client_state['timeout_monitor_timer'].is_alive():
            client_state['timeout_monitor_timer'].cancel()


    @sio.on("new_message")
    def on_new_message(data):
        nonlocal client_state # Đảm bảo client_state được cập nhật
        global TOTAL_RECEIVED, LATENCIES, SEND_TIMESTAMPS, LOCK, LATENCY_BY_CONVERSATION
        
        client_state['last_message_received_time'] = time.time()
        # Khi nhận được tin nhắn, client không còn ở trạng thái "chờ" phản hồi cho tin nhắn đã gửi trước đó nữa.
        # Điều này quan trọng cho logic timeout: timeout chỉ xảy ra nếu *sau khi gửi* mà *không nhận được gì*.
        client_state['last_message_sent_time'] = None # Reset cờ chờ timeout cho lần gửi trước

        latency = 0
        message_data = data.get("message", {})
        message_id = message_data.get("messageId")
        sender_id = message_data.get("sender", {}).get("_id") # Giả sử server trả về sender ID

        # Bỏ qua tin nhắn do chính mình gửi (nếu server có echo lại)
        # Cần kiểm tra cấu trúc user_id của bạn. Đây là một phỏng đoán.
        # if sender_id == my_user_id_from_token: # my_user_id_from_token cần được lấy từ token
        #     return

        if message_id:
            with LOCK:
                sent_time = SEND_TIMESTAMPS.pop(message_id, None)
                if sent_time:
                    latency = time.time() - sent_time
                    LATENCIES.append(latency)
                    
                    # Lưu độ trễ theo kích thước cuộc trò chuyện
                    conv_id_from_msg = message_data.get("conversationId", conversation_id_to_join)
                    conv_size = CONVERSATION_SIZES.get(conv_id_from_msg, "unknown")
                    
                    if conv_size not in LATENCY_BY_CONVERSATION:
                        LATENCY_BY_CONVERSATION[conv_size] = []
                    LATENCY_BY_CONVERSATION[conv_size].append(latency * 1000) # Chuyển sang ms

        client_state['messages_received'] += 1
        with LOCK:
            TOTAL_RECEIVED += 1
        # print(f"[Client {client_state['id']}] Received: {message_data.get('content')} (Latency: {latency*1000:.2f}ms)")

        # Logic forward tin nhắn: "khi nhận được tin nhắn thì gửi tiếp"
        if client_state['messages_sent_forwarded'] < cli_args.max_forwards and \
           client_state['sio_instance'].connected and not client_state['is_timed_out']:
            
            forward_content = f"Client {client_state['id']} forwards after receiving. Count: {client_state['messages_sent_forwarded'] + 1}"
            send_message_internal(forward_content, type_prefix="fwd")
            # print(f"[Client {client_state['id']}] Forwarded a message.")


    @sio.on("joined_conversation") # Xử lý phản hồi từ server sau khi join
    def on_joined_conversation(data):
        # print(f"[Client {client_state['id']}] Xác nhận đã tham gia cuộc trò chuyện: {data}")
        client_state['last_message_received_time'] = time.time() # Coi như một hoạt động

    @sio.on("error") # Các lỗi chung từ socket
    def on_error(data):
        global TOTAL_ERRORS, ERRORS_BY_TYPE, LOCK
        error_msg = str(data) if data else "Unknown socket error"
        print(f"[Client {client_state['id']}] Lỗi Socket: {error_msg}")
        with LOCK:
            TOTAL_ERRORS += 1
            ERRORS_BY_TYPE[error_msg] = ERRORS_BY_TYPE.get(error_msg, 0) + 1

    try:
        # print(f"[Client {client_state['id']}] Đang kết nối tới {server_url_ws} với token...")
        sio.connect(f"{server_url_ws}?token={token}", transports=["websocket"], wait_timeout=10)
        
        # sio.wait() sẽ block cho đến khi disconnect.
        # Logic timeout được xử lý bởi run_timeout_check và sio.disconnect()
        if sio.connected:
            sio.wait() 
        else:
            # Nếu không kết nối được ngay từ đầu
            print(f"[Client {client_state['id']}] Không thể kết nối ban đầu.")
            with LOCK:
                TOTAL_ERRORS +=1
                ERRORS_BY_TYPE["Initial Connection Failed"] = ERRORS_BY_TYPE.get("Initial Connection Failed",0) + 1


    except socketio.exceptions.ConnectionError as e:
        print(f"[Client {client_state['id']}] Lỗi ConnectionError khi kết nối: {e}")
        with LOCK:
            TOTAL_ERRORS += 1
            ERRORS_BY_TYPE[f"ConnectionError: {e}"] = ERRORS_BY_TYPE.get(f"ConnectionError: {e}", 0) + 1
    except Exception as e:
        print(f"[Client {client_state['id']}] Lỗi không xác định trong client: {e}")
        with LOCK:
            TOTAL_ERRORS += 1
            ERRORS_BY_TYPE[f"Generic Client Error: {e}"] = ERRORS_BY_TYPE.get(f"Generic Client Error: {e}", 0) + 1
    finally:
        if client_state['timeout_monitor_timer'] and client_state['timeout_monitor_timer'].is_alive():
            client_state['timeout_monitor_timer'].cancel()
        if client_state['sio_instance'].connected: # Đảm bảo ngắt kết nối nếu chưa
            client_state['sio_instance'].disconnect()
        # print(f"[Client {client_state['id']}] Đã hoàn thành. SentInitial: {client_state['messages_sent_initial']}, SentForwarded: {client_state['messages_sent_forwarded']}, Received: {client_state['messages_received']}, TimedOut: {client_state['is_timed_out']}")


def main():
    global START_TIME, START_MONITORING, DEFAULT_SERVER_URL, DEFAULT_CONVERSATION_ID
    global DEFAULT_MESSAGES_PER_CLIENT, DEFAULT_MAX_FORWARDS_PER_CLIENT 
    global DEFAULT_DELAY_BETWEEN_MESSAGES, DEFAULT_TIMEOUT, DEFAULT_CLIENT_COUNT
    
    parser = argparse.ArgumentParser(description="WebSocket Stress Test Script")
    parser.add_argument("--url", default=DEFAULT_SERVER_URL, help="WebSocket server URL (e.g., ws://localhost:3000)")
    parser.add_argument("--conversation", default=DEFAULT_CONVERSATION_ID, help="Conversation ID to use")
    parser.add_argument("--messages", type=int, default=DEFAULT_MESSAGES_PER_CLIENT, help="Initial messages per client")
    parser.add_argument("--max-forwards", type=int, default=DEFAULT_MAX_FORWARDS_PER_CLIENT, help="Max forwarded messages per client after receiving a message")
    parser.add_argument("--delay", type=float, default=DEFAULT_DELAY_BETWEEN_MESSAGES, help="Delay between initial messages (seconds)")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT, help="Timeout in seconds for waiting for a message after sending")
    parser.add_argument("--token-file", default=r"C:\React\chat_app_backend\test\tokens_only.json", help="File containing user tokens")
    parser.add_argument("--clients", type=int, default=DEFAULT_CLIENT_COUNT, help="Number of concurrent clients (0 means use all available tokens up to a limit)")
    
    args = parser.parse_args()

    tokens = load_tokens(args.token_file)
    if not tokens:
        print("Không có tokens nào được tải. Kết thúc chương trình.")
        return

    num_clients_to_run = args.clients
    if num_clients_to_run == 0: # Sử dụng tất cả token nếu --clients là 0
        num_clients_to_run = len(tokens)
    else: # Giới hạn số client theo token có sẵn
        num_clients_to_run = min(args.clients, len(tokens))

    if num_clients_to_run == 0:
        print("Không có client nào để chạy (số lượng token hoặc --clients là 0). Kết thúc.")
        return

    print(f"\n=== Bắt đầu WebSocket Stress Test ===")
    print(f"Server URL: {args.url}")
    print(f"Conversation ID: {args.conversation}")
    print(f"Số lượng client: {num_clients_to_run}")
    print(f"Tin nhắn ban đầu mỗi client: {args.messages}")
    print(f"Tin nhắn forward tối đa mỗi client: {args.max_forwards}")
    print(f"Độ trễ giữa các tin nhắn ban đầu: {args.delay}s")
    print(f"Timeout chờ tin nhắn: {args.timeout}s")
    print("=====================================\n")

    # Lấy thông tin cuộc trò chuyện (kích thước)
    server_url_http = args.url.replace('ws://', 'http://').replace('wss://', 'https://')
    if tokens: # Lấy thông tin bằng token đầu tiên
        get_conversation_info(args.conversation, tokens[0], server_url_http)

    # Bắt đầu theo dõi tài nguyên hệ thống
    START_MONITORING = True
    monitor_thread = threading.Thread(target=monitor_system_resources, daemon=True)
    monitor_thread.start()
    
    START_TIME = time.time()
    threads = []
    for i in range(num_clients_to_run):
        # Sử dụng token theo vòng nếu num_clients_to_run > len(tokens) (mặc dù đã giới hạn ở trên)
        token_for_client = tokens[i % len(tokens)] 
        t = threading.Thread(target=create_client, args=(token_for_client, i, args.conversation, args.url, args))
        threads.append(t)
        t.start()
        time.sleep(0.05) # Rải đều việc tạo client một chút

    for t in threads:
        t.join() # Chờ tất cả các client thread hoàn thành
        
    # Dừng theo dõi tài nguyên
    START_MONITORING = False
    if monitor_thread.is_alive():
        monitor_thread.join(timeout=2) # Chờ monitor thread kết thúc

    actual_duration = time.time() - START_TIME
    
    # Tính toán thống kê cuối cùng
    # Các biến global TOTAL_SENT, TOTAL_RECEIVED, TOTAL_ERRORS, TIMEOUT_CLIENT_COUNT, LATENCIES đã được cập nhật
    
    avg_latency_ms = (sum(LATENCIES) / len(LATENCIES) * 1000) if LATENCIES else 0
    min_latency_ms = (min(LATENCIES) * 1000) if LATENCIES else 0
    max_latency_ms = (max(LATENCIES) * 1000) if LATENCIES else 0
    
    send_rate = TOTAL_SENT / actual_duration if actual_duration > 0 else 0
    recv_rate = TOTAL_RECEIVED / actual_duration if actual_duration > 0 else 0

    print("\n=== Kết quả Stress Test ===")
    print(f"Thời gian thực thi tổng cộng: {actual_duration:.2f} giây")
    print(f"Tổng số tin nhắn đã gửi: {TOTAL_SENT}")
    print(f"Tổng số tin nhắn đã nhận: {TOTAL_RECEIVED}")
    if TOTAL_SENT > 0:
        success_rate = (TOTAL_RECEIVED / TOTAL_SENT * 100) if TOTAL_SENT > 0 else 0
        print(f"Tỉ lệ gửi/nhận thành công: {success_rate:.2f}% ({TOTAL_RECEIVED}/{TOTAL_SENT})")
    else:
        print("Không có tin nhắn nào được gửi.")
    
    print(f"Tổng số lỗi kết nối/socket: {TOTAL_ERRORS}")
    if ERRORS_BY_TYPE:
        print("Chi tiết lỗi:")
        for err_type, count in ERRORS_BY_TYPE.items():
            print(f"  - {err_type}: {count}")

    print(f"Số client bị timeout: {TIMEOUT_CLIENT_COUNT}")

    print("\n--- Thống kê độ trễ ---")
    if LATENCIES:
        print(f"Số mẫu độ trễ: {len(LATENCIES)}")
        print(f"Độ trễ trung bình: {avg_latency_ms:.2f} ms")
        print(f"Độ trễ tối thiểu: {min_latency_ms:.2f} ms")
        print(f"Độ trễ tối đa: {max_latency_ms:.2f} ms")
        # Thống kê độ trễ theo kích thước cuộc trò chuyện (nếu có)
        if LATENCY_BY_CONVERSATION:
            print("Độ trễ trung bình theo kích thước cuộc trò chuyện:")
            for size, lats_ms in LATENCY_BY_CONVERSATION.items():
                if lats_ms:
                    avg_lat_ms = statistics.mean(lats_ms)
                    print(f"  - Kích thước {size}: {avg_lat_ms:.2f} ms (Số mẫu: {len(lats_ms)})")
    else:
        print("Không có dữ liệu độ trễ.")

    print("\n--- Hiệu suất hệ thống (Trung bình) ---")
    avg_cpu = statistics.mean(CPU_USAGE_OVER_TIME) if CPU_USAGE_OVER_TIME else 0
    avg_ram = statistics.mean(MEMORY_USAGE_OVER_TIME) if MEMORY_USAGE_OVER_TIME else 0
    print(f"Sử dụng CPU trung bình: {avg_cpu:.1f}%")
    print(f"Sử dụng RAM trung bình: {avg_ram:.1f}%")

    print("\n--- Tốc độ xử lý tin nhắn ---")
    print(f"Tốc độ gửi trung bình: {send_rate:.2f} tin nhắn/giây")
    print(f"Tốc độ nhận trung bình: {recv_rate:.2f} tin nhắn/giây")
    
    print("\nStress test đã hoàn thành.")

    # Vẽ biểu đồ
    try:
        num_plots = 4 # CPU, RAM, Rates, Latency Histogram
        fig, axs = plt.subplots(num_plots, 1, figsize=(12, num_plots * 4))
        plot_time_axis = TIMESTAMPS_FOR_PLOTS[:len(CPU_USAGE_OVER_TIME)] # Đảm bảo trục thời gian khớp

        # 1. CPU Usage
        if plot_time_axis and CPU_USAGE_OVER_TIME:
            axs[0].plot(plot_time_axis, CPU_USAGE_OVER_TIME, label='CPU %', color='r')
            axs[0].set_title('Sử dụng CPU Theo Thời Gian')
            axs[0].set_xlabel('Thời gian (giây)')
            axs[0].set_ylabel('CPU %')
            axs[0].set_ylim(0, 100)
            axs[0].grid(True)
            axs[0].legend()

        # 2. Memory Usage
        if plot_time_axis and MEMORY_USAGE_OVER_TIME:
            axs[1].plot(plot_time_axis, MEMORY_USAGE_OVER_TIME, label='RAM %', color='b')
            axs[1].set_title('Sử dụng RAM Theo Thời Gian')
            axs[1].set_xlabel('Thời gian (giây)')
            axs[1].set_ylabel('RAM %')
            axs[1].set_ylim(0, 100)
            axs[1].grid(True)
            axs[1].legend()

        # 3. Message Rates
        plot_time_axis_rates = TIMESTAMPS_FOR_PLOTS[:len(MSGS_SENT_PER_SECOND)]
        if plot_time_axis_rates and MSGS_SENT_PER_SECOND and MSGS_RECEIVED_PER_SECOND:
            axs[2].plot(plot_time_axis_rates, MSGS_SENT_PER_SECOND, label='Tin nhắn gửi/giây', color='g', alpha=0.7)
            axs[2].plot(plot_time_axis_rates, MSGS_RECEIVED_PER_SECOND, label='Tin nhắn nhận/giây', color='m', alpha=0.7)
            axs[2].set_title('Tốc Độ Tin Nhắn Theo Thời Gian')
            axs[2].set_xlabel('Thời gian (giây)')
            axs[2].set_ylabel('Số tin nhắn / giây')
            axs[2].grid(True)
            axs[2].legend()

        # 4. Latency Distribution
        if LATENCIES:
            latencies_ms = [l * 1000 for l in LATENCIES]
            axs[3].hist(latencies_ms, bins=50, color='orange', edgecolor='black')
            axs[3].set_title(f'Phân Phối Độ Trễ Tin Nhắn (Trung bình: {avg_latency_ms:.2f} ms)')
            axs[3].set_xlabel('Độ trễ (ms)')
            axs[3].set_ylabel('Số lượng tin nhắn')
            axs[3].grid(True)

        plt.tight_layout()
        timestamp_str = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        filename = f'stress_test_report_{timestamp_str}.png'
        plt.savefig(filename)
        print(f"\nBiểu đồ kết quả đã được lưu vào file: {filename}")

    except Exception as e:
        print(f"Không thể tạo biểu đồ: {str(e)}")

if __name__ == "__main__":
    main()
