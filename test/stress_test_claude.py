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
from matplotlib.ticker import MaxNLocator
from tabulate import tabulate  # Thêm thư viện này để hiển thị dữ liệu dạng bảng đẹp hơn
import numpy as np
from colorama import Fore, Style, init  # Thêm màu sắc cho console

# Khởi tạo colorama
init()

# Default settings
SERVER_URL = "ws://localhost"
CONVERSATION_ID = "6810a51046d0da178e288364"
MESSAGES_PER_CLIENT = 10
DELAY_BETWEEN_MESSAGES = 0.1
TIMEOUT = 10  # seconds
CONNECTION = 2
TOKEN_FILE = "user_tokens.json"

# Global statistics
TOTAL_SENT = 0
TOTAL_RECEIVED = 0
TOTAL_ERRORS = 0
LATENCIES = []
LATENCIES_BY_TIME = []  # Lưu độ trễ theo thời gian [(thời_gian, độ_trễ), ...]
SEND_TIMESTAMPS = {}
LOCK = threading.Lock()
START_TIME = 0

# Theo dõi hiệu suất
CONVERSATION_SIZES = {}  # Lưu số người trong mỗi cuộc trò chuyện
LATENCY_BY_CONVERSATION = {}  # Lưu độ trễ theo từng cuộc trò chuyện
CPU_USAGE = []  # Lưu sử dụng CPU [(thời_gian, phần_trăm), ...]
MEMORY_USAGE = []  # Lưu sử dụng RAM [(thời_gian, phần_trăm), ...]
MESSAGE_STATS = []  # Lưu thống kê gửi/nhận [(thời_gian, gửi, nhận), ...]
ERRORS_BY_TYPE = {}  # Lưu số lỗi theo loại
START_MONITORING = False  # Có bắt đầu theo dõi hiệu suất chưa

# Thêm biến theo dõi tiến độ test
PROGRESS = {
    "clients_connected": 0,
    "clients_joined": 0,
    "messages_sent": 0,
    "messages_received": 0,
    "test_completed": False
}

def load_tokens(filename="user_tokens.json"):
    """Tải danh sách token từ file"""
    try:
        print(f"{Fore.CYAN}[INFO]{Style.RESET_ALL} Đang tải tokens từ '{filename}'...")
        if os.path.exists(filename):
            with open(filename, "r") as file:
                data = json.load(file)
                if isinstance(data, list):
                    if isinstance(data[0], str):
                        print(f"{Fore.GREEN}[SUCCESS]{Style.RESET_ALL} Đã tải {len(data)} tokens")
                        return data
                    elif isinstance(data[0], dict) and "token" in data[0]:
                        tokens = [user["token"] for user in data]
                        print(f"{Fore.GREEN}[SUCCESS]{Style.RESET_ALL} Đã tải {len(tokens)} tokens")
                        return tokens
        if os.path.exists("tokens_only.json"):
            with open("tokens_only.json", "r") as file:
                tokens = json.load(file)
                print(f"{Fore.GREEN}[SUCCESS]{Style.RESET_ALL} Đã tải {len(tokens)} tokens từ 'tokens_only.json'")
                return tokens
    except Exception as e:
        print(f"{Fore.RED}[ERROR]{Style.RESET_ALL} Lỗi khi tải tokens: {str(e)}")
    print(f"{Fore.YELLOW}[WARNING]{Style.RESET_ALL} Không tìm thấy file tokens hợp lệ. Vui lòng chạy register_accounts.py trước.")
    return []

def monitor_system_resources():
    """Theo dõi tài nguyên hệ thống và lưu vào biến toàn cục"""
    global CPU_USAGE, MEMORY_USAGE, START_MONITORING, MESSAGE_STATS, TOTAL_SENT, TOTAL_RECEIVED
    
    # Thời gian bắt đầu theo dõi
    monitor_start = time.time()
    
    while START_MONITORING:
        current_time = time.time() - monitor_start
        
        # Thu thập dữ liệu CPU và RAM
        cpu_percent = psutil.cpu_percent(interval=0.5)
        memory_info = psutil.virtual_memory()
        memory_percent = memory_info.percent
        
        with LOCK:
            CPU_USAGE.append((current_time, cpu_percent))
            MEMORY_USAGE.append((current_time, memory_percent))
            # Lưu thống kê tin nhắn
            MESSAGE_STATS.append((current_time, TOTAL_SENT, TOTAL_RECEIVED))
        
        time.sleep(0.5)  # Cập nhật mỗi 0.5 giây

def get_conversation_info(conversation_id, token):
    """Lấy thông tin về cuộc trò chuyện từ server"""
    try:
        import requests
        print(f"{Fore.CYAN}[INFO]{Style.RESET_ALL} Đang lấy thông tin cuộc trò chuyện...")
        
        headers = {"Authorization": f"Bearer {token}"}
        url = f"{SERVER_URL.replace('ws://', 'http://').replace('wss://', 'https://')}/api/conversations/{conversation_id}"
        print(f"{Fore.CYAN}[INFO]{Style.RESET_ALL} API URL: {url}")
        
        response = requests.get(url, headers=headers)
        
        print(f"{Fore.CYAN}[INFO]{Style.RESET_ALL} API Response status: {response.status_code}")
        if response.status_code == 200:
            data = response.json()
            participants = data.get("participants", [])
            size = len(participants)
            print(f"{Fore.GREEN}[SUCCESS]{Style.RESET_ALL} Đã tìm thấy {size} người tham gia trong cuộc trò chuyện")
            CONVERSATION_SIZES[conversation_id] = size
            return size
        else:
            print(f"{Fore.RED}[ERROR]{Style.RESET_ALL} Lỗi API: {response.text}")
        
        return 0
    except Exception as e:
        print(f"{Fore.RED}[ERROR]{Style.RESET_ALL} Lỗi khi lấy thông tin cuộc trò chuyện: {str(e)}")
        return 0

def create_client(token, index, conversation_id):
    """Tạo và quản lý một client websocket"""
    global TOTAL_SENT, TOTAL_RECEIVED, TOTAL_ERRORS, LATENCIES, SEND_TIMESTAMPS, LOCK, LATENCY_BY_CONVERSATION
    global LATENCIES_BY_TIME, PROGRESS

    sio = socketio.Client(logger=False, engineio_logger=False)
    messages_sent = 0
    messages_received = 0
    last_activity_time = 0
    client_start_time = time.time()
    
    def check_inactivity():
        """Kiểm tra thời gian không hoạt động và ngắt kết nối nếu quá lâu"""
        global TIMEOUT
        nonlocal last_activity_time
        if time.time() - last_activity_time >= TIMEOUT:
            print(f"{Fore.YELLOW}[Client {index}]{Style.RESET_ALL} Không có hoạt động trong {TIMEOUT} giây, đang ngắt kết nối")
            sio.disconnect()
        else:
            # Lên lịch kiểm tra tiếp theo trong 1 giây
            threading.Timer(1, check_inactivity).start()

    def send_message_loop(count=0):
        """Vòng lặp gửi tin nhắn tuần tự với mỗi client"""
        nonlocal messages_sent, last_activity_time, client_start_time
        global TOTAL_SENT, PROGRESS
        
        if count >= MESSAGES_PER_CLIENT:
            last_activity_time = time.time()  # Bắt đầu đếm thời gian không hoạt động sau khi gửi tin nhắn cuối cùng
            check_inactivity()  # Bắt đầu kiểm tra thời gian không hoạt động
            return
            
        message_id = f"{index}_{count}"
        message_payload = {
            "data": {
                "conversationId": conversation_id,
                "content": f"Msg {count+1} from client {index}",
                "messageId": message_id
            }
        }
        
        # Lưu thời gian gửi để tính độ trễ
        current_time = time.time()
        with LOCK:
            SEND_TIMESTAMPS[message_id] = current_time
            
        # Gửi tin nhắn
        sio.emit("send_message", message_payload)
        messages_sent += 1
        last_activity_time = current_time  # Cập nhật thời gian hoạt động
        
        # Cập nhật thống kê toàn cục
        with LOCK:
            TOTAL_SENT += 1
            PROGRESS["messages_sent"] += 1
            
        print(f"{Fore.BLUE}[Client {index}]{Style.RESET_ALL} Đã gửi tin nhắn {count+1}/{MESSAGES_PER_CLIENT}")
        
        # Lên lịch gửi tin nhắn tiếp theo
        threading.Timer(DELAY_BETWEEN_MESSAGES, send_message_loop, args=(count + 1,)).start()

    @sio.event
    def connect():
        """Xử lý sự kiện kết nối thành công"""
        global PROGRESS
        print(f"{Fore.GREEN}[Client {index}]{Style.RESET_ALL} Đã kết nối thành công đến server")
        with LOCK:
            PROGRESS["clients_connected"] += 1
            
        # Tham gia vào cuộc trò chuyện
        join_payload = {
            "data": {
                "conversationId": conversation_id
            }
        }
        sio.emit("join_conversation", join_payload)

    @sio.event
    def disconnect():
        """Xử lý sự kiện ngắt kết nối"""
        print(f"{Fore.YELLOW}[Client {index}]{Style.RESET_ALL} Đã ngắt kết nối")
        print(f"{Fore.CYAN}[Client {index}]{Style.RESET_ALL} Kết quả: Gửi {messages_sent}, Nhận {messages_received}")

    @sio.event
    def connect_error(data):
        """Xử lý lỗi kết nối"""
        global TOTAL_ERRORS, ERRORS_BY_TYPE
        print(f"{Fore.RED}[Client {index}]{Style.RESET_ALL} Lỗi kết nối: {data}")
        with LOCK:
            TOTAL_ERRORS += 1
            error_type = str(data)
            ERRORS_BY_TYPE[error_type] = ERRORS_BY_TYPE.get(error_type, 0) + 1

    @sio.on("new_message")
    def on_new_message(data):
        """Xử lý tin nhắn mới nhận được"""
        nonlocal messages_received, last_activity_time
        global TOTAL_RECEIVED, LATENCY_BY_CONVERSATION, LATENCIES, LATENCIES_BY_TIME, PROGRESS
        
        last_activity_time = time.time()  # Cập nhật thời gian hoạt động
        
        try:
            # Phân tích dữ liệu tin nhắn
            message = data.get("message", {})
            message_id = message.get("messageId", "")
            content = message.get("content", "")
            
            # Tính độ trễ nếu là tin nhắn từ chính client này
            latency = 0
            current_time = time.time() - START_TIME  # Thời gian tương đối từ khi bắt đầu test
            
            if message_id and message_id.startswith(f"{index}_"):
                with LOCK:
                    sent_time = SEND_TIMESTAMPS.pop(message_id, None)
                    if sent_time:
                        latency = time.time() - sent_time
                        LATENCIES.append(latency)
                        LATENCIES_BY_TIME.append((current_time, latency * 1000))  # Lưu theo ms
                        
                        # Lưu độ trễ theo kích thước cuộc trò chuyện
                        conv_id = message.get("conversationId", conversation_id)
                        conv_size = CONVERSATION_SIZES.get(conv_id, "unknown")
                        
                        if conv_size not in LATENCY_BY_CONVERSATION:
                            LATENCY_BY_CONVERSATION[conv_size] = []
                            
                        LATENCY_BY_CONVERSATION[conv_size].append(latency * 1000)  # Chuyển sang ms
                        print(f"{Fore.CYAN}[Client {index}]{Style.RESET_ALL} Độ trễ: {latency * 1000:.2f}ms, Tin nhắn: \"{content}\"")
            
            messages_received += 1
            with LOCK:
                TOTAL_RECEIVED += 1
                PROGRESS["messages_received"] += 1
        
        except Exception as e:
            print(f"{Fore.RED}[Client {index}]{Style.RESET_ALL} Lỗi xử lý tin nhắn: {str(e)}")

    @sio.on("joined_conversation")
    def on_joined_conversation(data):
        """Xử lý sự kiện tham gia cuộc trò chuyện thành công"""
        nonlocal last_activity_time
        global PROGRESS
        
        last_activity_time = time.time()  # Cập nhật thời gian hoạt động
        print(f"{Fore.GREEN}[Client {index}]{Style.RESET_ALL} Đã tham gia cuộc trò chuyện: {conversation_id}")
        
        with LOCK:
            PROGRESS["clients_joined"] += 1
        
        # Thêm độ trễ nhỏ để đảm bảo server đã xử lý yêu cầu join_conversation
        def delayed_start():
            send_message_loop()
        
        # Đợi 0.5 giây trước khi bắt đầu gửi tin nhắn
        threading.Timer(0.5, delayed_start).start()

    @sio.on("error")
    def on_error(data):
        """Xử lý lỗi từ server"""
        global TOTAL_ERRORS, ERRORS_BY_TYPE
        print(f"{Fore.RED}[Client {index}]{Style.RESET_ALL} Lỗi Socket: {data}")
        with LOCK:
            TOTAL_ERRORS += 1
            error_type = str(data)
            ERRORS_BY_TYPE[error_type] = ERRORS_BY_TYPE.get(error_type, 0) + 1

    try:
        # Kết nối đến server
        print(f"{Fore.CYAN}[Client {index}]{Style.RESET_ALL} Đang kết nối đến {SERVER_URL}...")
        sio.connect(f"{SERVER_URL}?token={token}", transports=["websocket"], wait=True)
        sio.wait()  # Đợi cho đến khi ngắt kết nối
    except Exception as e:
        print(f"{Fore.RED}[Client {index}]{Style.RESET_ALL} Lỗi: {e}")
        with LOCK:
            TOTAL_ERRORS += 1
            error_type = str(e)
            ERRORS_BY_TYPE[error_type] = ERRORS_BY_TYPE.get(error_type, 0) + 1

def draw_charts(test_duration):
    """Vẽ biểu đồ phân tích hiệu suất"""
    try:
        print(f"{Fore.CYAN}[INFO]{Style.RESET_ALL} Đang tạo biểu đồ phân tích hiệu suất...")
        
        # Tạo thư mục để lưu biểu đồ
        charts_dir = "stress_test_charts"
        if not os.path.exists(charts_dir):
            os.makedirs(charts_dir)
            
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        
        # 1. Biểu đồ độ trễ theo thời gian
        if LATENCIES_BY_TIME:
            plt.figure(figsize=(10, 5))
            times, latencies = zip(*LATENCIES_BY_TIME)
            plt.plot(times, latencies, 'b-', marker='o', markersize=3)
            plt.grid(True, linestyle='--', alpha=0.7)
            plt.title('Độ trễ theo thời gian')
            plt.xlabel('Thời gian (giây)')
            plt.ylabel('Độ trễ (ms)')
            plt.tight_layout()
            latency_chart_path = f"{charts_dir}/latency_time_{timestamp}.png"
            plt.savefig(latency_chart_path)
            plt.close()
            print(f"{Fore.GREEN}[INFO]{Style.RESET_ALL} Đã lưu biểu đồ độ trễ: {latency_chart_path}")
        
        # 2. Biểu đồ CPU và RAM usage
        if CPU_USAGE and MEMORY_USAGE:
            plt.figure(figsize=(12, 6))
            
            # CPU Usage
            cpu_times, cpu_values = zip(*CPU_USAGE)
            ax1 = plt.subplot(2, 1, 1)
            ax1.plot(cpu_times, cpu_values, 'r-', label='CPU Usage')
            ax1.set_ylabel('CPU Usage (%)')
            ax1.set_title('Sử dụng tài nguyên hệ thống')
            ax1.grid(True, linestyle='--', alpha=0.7)
            ax1.legend(loc='upper right')
            
            # Memory Usage
            mem_times, mem_values = zip(*MEMORY_USAGE)
            ax2 = plt.subplot(2, 1, 2, sharex=ax1)
            ax2.plot(mem_times, mem_values, 'g-', label='RAM Usage')
            ax2.set_xlabel('Thời gian (giây)')
            ax2.set_ylabel('RAM Usage (%)')
            ax2.grid(True, linestyle='--', alpha=0.7)
            ax2.legend(loc='upper right')
            
            plt.tight_layout()
            resource_chart_path = f"{charts_dir}/resource_usage_{timestamp}.png"
            plt.savefig(resource_chart_path)
            plt.close()
            print(f"{Fore.GREEN}[INFO]{Style.RESET_ALL} Đã lưu biểu đồ tài nguyên: {resource_chart_path}")
        
        # 3. Biểu đồ tin nhắn gửi/nhận theo thời gian
        if MESSAGE_STATS:
            plt.figure(figsize=(10, 5))
            msg_times, sent, received = zip(*MESSAGE_STATS)
            
            plt.plot(msg_times, sent, 'b-', label='Tin nhắn đã gửi')
            plt.plot(msg_times, received, 'g-', label='Tin nhắn đã nhận')
            
            plt.title('Tốc độ gửi/nhận tin nhắn')
            plt.xlabel('Thời gian (giây)')
            plt.ylabel('Số lượng tin nhắn')
            plt.grid(True, linestyle='--', alpha=0.7)
            plt.legend(loc='upper left')
            plt.tight_layout()
            
            messages_chart_path = f"{charts_dir}/messages_{timestamp}.png"
            plt.savefig(messages_chart_path)
            plt.close()
            print(f"{Fore.GREEN}[INFO]{Style.RESET_ALL} Đã lưu biểu đồ tin nhắn: {messages_chart_path}")
        
        # 4. Biểu đồ phân phối độ trễ
        if LATENCIES:
            plt.figure(figsize=(10, 5))
            latencies_ms = [lat * 1000 for lat in LATENCIES]  # Chuyển sang ms
            plt.hist(latencies_ms, bins=20, alpha=0.7, color='blue', edgecolor='black')
            plt.axvline(statistics.mean(latencies_ms), color='red', linestyle='dashed', linewidth=1, 
                     label=f'Trung bình: {statistics.mean(latencies_ms):.2f}ms')
            
            if len(latencies_ms) > 1:
                plt.axvline(statistics.median(latencies_ms), color='green', linestyle='dashed', linewidth=1,
                         label=f'Trung vị: {statistics.median(latencies_ms):.2f}ms')
            
            plt.title('Phân phối độ trễ')
            plt.xlabel('Độ trễ (ms)')
            plt.ylabel('Số lượng')
            plt.grid(True, linestyle='--', alpha=0.7)
            plt.legend()
            plt.tight_layout()
            
            latency_dist_chart_path = f"{charts_dir}/latency_distribution_{timestamp}.png"
            plt.savefig(latency_dist_chart_path)
            plt.close()
            print(f"{Fore.GREEN}[INFO]{Style.RESET_ALL} Đã lưu biểu đồ phân phối độ trễ: {latency_dist_chart_path}")
            
        # 5. Biểu đồ tóm tắt hiệu suất
        plt.figure(figsize=(10, 8))
        # Tổng kết
        data = [
            ['Tổng tin nhắn gửi', TOTAL_SENT],
            ['Tổng tin nhắn nhận', TOTAL_RECEIVED],
            ['Tỉ lệ thành công', f"{(TOTAL_RECEIVED/TOTAL_SENT*100):.1f}%" if TOTAL_SENT > 0 else "N/A"],
            ['Thời gian test', f"{test_duration:.2f}s"],
            ['Độ trễ trung bình', f"{(statistics.mean(LATENCIES) * 1000):.2f}ms" if LATENCIES else "N/A"],
            ['Độ trễ min', f"{(min(LATENCIES) * 1000):.2f}ms" if LATENCIES else "N/A"],
            ['Độ trễ max', f"{(max(LATENCIES) * 1000):.2f}ms" if LATENCIES else "N/A"],
            ['CPU trung bình', f"{statistics.mean([cpu for _, cpu in CPU_USAGE]):.1f}%" if CPU_USAGE else "N/A"],
            ['RAM trung bình', f"{statistics.mean([mem for _, mem in MEMORY_USAGE]):.1f}%" if MEMORY_USAGE else "N/A"],
            ['Lỗi', TOTAL_ERRORS]
        ]
        
        ax = plt.subplot(111)
        ax.axis('off')
        tbl = ax.table(cellText=data, colLabels=['Thông số', 'Giá trị'], loc='center', cellLoc='center')
        tbl.auto_set_font_size(False)
        tbl.set_fontsize(12)
        tbl.scale(1, 1.5)
        
        plt.title('Tóm tắt kết quả stress test', fontsize=16, pad=20)
        plt.tight_layout()
        
        summary_chart_path = f"{charts_dir}/summary_{timestamp}.png"
        plt.savefig(summary_chart_path)
        plt.close()
        print(f"{Fore.GREEN}[INFO]{Style.RESET_ALL} Đã lưu biểu đồ tóm tắt: {summary_chart_path}")
        
        print(f"{Fore.GREEN}[SUCCESS]{Style.RESET_ALL} Đã tạo tất cả biểu đồ phân tích hiệu suất!")
        return True
        
    except Exception as e:
        print(f"{Fore.RED}[ERROR]{Style.RESET_ALL} Lỗi khi tạo biểu đồ: {str(e)}")
        return False

def display_progress_bar(total, current, prefix='', suffix='', length=50, fill='█'):
    """Hiển thị thanh tiến trình trên console"""
    percent = min(100, int(100 * current / total) if total > 0 else 0)
    filled_length = int(length * current // total) if total > 0 else 0
    bar = fill * filled_length + '-' * (length - filled_length)
    progress_line = f'\r{prefix} |{bar}| {percent}% {suffix}'
    print(progress_line, end='', flush=True)
    return progress_line

def progress_monitor():
    """Theo dõi và hiển thị tiến độ của quá trình test"""
    global PROGRESS, CONNECTION, MESSAGES_PER_CLIENT
    
    total_messages = CONNECTION * MESSAGES_PER_CLIENT
    last_line = ''
    
    while not PROGRESS["test_completed"]:
        with LOCK:
            clients_connected = PROGRESS["clients_connected"]
            clients_joined = PROGRESS["clients_joined"]
            messages_sent = PROGRESS["messages_sent"] 
            messages_received = PROGRESS["messages_received"]
        
        # Hiển thị trạng thái kết nối
        connection_status = f"Đã kết nối: {clients_connected}/{CONNECTION}, Đã tham gia: {clients_joined}/{CONNECTION}"
        print(f"\r{Fore.CYAN}[STATUS]{Style.RESET_ALL} {connection_status}", end='', flush=True)
        
        # Nếu đã kết nối đủ client, hiển thị tiến độ gửi/nhận tin nhắn
        if clients_joined == CONNECTION and total_messages > 0:
            # Xóa dòng trạng thái kết nối
            print('\r' + ' ' * len(connection_status + "[STATUS] "), end='', flush=True)
            
            # Thanh tiến trình gửi
            prefix = f"{Fore.BLUE}[SEND]{Style.RESET_ALL}"
            suffix = f"{messages_sent}/{total_messages}"
            send_bar = display_progress_bar(total_messages, messages_sent, prefix, suffix)
            print()  # Xuống dòng
            
            # Thanh tiến trình nhận
            prefix = f"{Fore.GREEN}[RECV]{Style.RESET_ALL}"
            suffix = f"{messages_received}/{total_messages}"
            recv_bar = display_progress_bar(total_messages, messages_received, prefix, suffix)
            
            # Quay lại dòng đầu tiên để cập nhật
            if last_line:
                print('\033[1A', end='')  # Di chuyển con trỏ lên 1 dòng
            last_line = recv_bar
        
        time.sleep(0.2)  # Cập nhật mỗi 0.2 giây
        
        # Kiểm tra nếu hoàn thành
        if messages_received >= total_messages and total_messages > 0:
            print('\n')  # Xuống dòng để tiếp tục hiển thị kết quả
            break

def live_stats_display():
    """Hiển thị thống kê realtime trên console"""
    global TOTAL_SENT, TOTAL_RECEIVED, LATENCIES, CPU_USAGE, MEMORY_USAGE
    
    while START_MONITORING:
        # Xóa màn hình console
        os.system('cls' if os.name == 'nt' else 'clear')
        
        current_time = time.time() - START_TIME
        
        print(f"{Fore.CYAN}{'='*20} REALTIME MONITORING {'='*20}{Style.RESET_ALL}")
        print(f"{Fore.CYAN}[TIME]{Style.RESET_ALL} Thời gian chạy: {current_time:.2f}s")
        
        with LOCK:
            sent = TOTAL_SENT
            received = TOTAL_RECEIVED
            
            # Hiển thị thông tin tin nhắn
            print(f"{Fore.BLUE}[MESSAGES]{Style.RESET_ALL} Đã gửi: {sent}, Đã nhận: {received}")
            if sent > 0:
                success_rate = (received / sent) * 100
                print(f"{Fore.BLUE}[MESSAGES]{Style.RESET_ALL} Tỉ lệ thành công: {success_rate:.2f}%")
                print(f"{Fore.BLUE}[MESSAGES]{Style.RESET_ALL} Tin nhắn/giây: {sent/current_time:.2f}")
            
            # Hiển thị thông tin độ trễ
            if LATENCIES:
                avg_latency = statistics.mean(LATENCIES) * 1000  # Convert to ms
                min_latency = min(LATENCIES) * 1000
                max_latency = max(LATENCIES) * 1000
                
                # Tính độ trễ realtime (10 mẫu gần nhất)
                recent_latencies = [lat * 1000 for lat in LATENCIES[-10:]] if len(LATENCIES) >= 10 else [lat * 1000 for lat in LATENCIES]
                recent_avg = statistics.mean(recent_latencies) if recent_latencies else 0
                
                print(f"\n{Fore.GREEN}[LATENCY]{Style.RESET_ALL} Hiện tại: {recent_avg:.2f} ms")
                print(f"{Fore.GREEN}[LATENCY]{Style.RESET_ALL} Trung bình: {avg_latency:.2f} ms")
                print(f"{Fore.GREEN}[LATENCY]{Style.RESET_ALL} Min: {min_latency:.2f} ms, Max: {max_latency:.2f} ms")
            
            # Hiển thị thông tin tài nguyên
            if CPU_USAGE and MEMORY_USAGE:
                recent_cpu = CPU_USAGE[-1][1] if CPU_USAGE else 0
                recent_mem = MEMORY_USAGE[-1][1] if MEMORY_USAGE else 0
                
                avg_cpu = statistics.mean([cpu for _, cpu in CPU_USAGE]) if CPU_USAGE else 0
                avg_mem = statistics.mean([mem for _, mem in MEMORY_USAGE]) if MEMORY_USAGE else 0
                
                print(f"\n{Fore.YELLOW}[RESOURCES]{Style.RESET_ALL} CPU hiện tại: {recent_cpu:.2f}%, Trung bình: {avg_cpu:.2f}%")
                print(f"{Fore.YELLOW}[RESOURCES]{Style.RESET_ALL} RAM hiện tại: {recent_mem:.2f}%, Trung bình: {avg_mem:.2f}%")
            
            # Hiển thị thông tin client
            print(f"\n{Fore.MAGENTA}[CLIENTS]{Style.RESET_ALL} Đã kết nối: {PROGRESS['clients_connected']}/{CONNECTION}")
            print(f"{Fore.MAGENTA}[CLIENTS]{Style.RESET_ALL} Đã tham gia: {PROGRESS['clients_joined']}/{CONNECTION}")
            
            # Hiển thị lỗi
            if TOTAL_ERRORS > 0:
                print(f"\n{Fore.RED}[ERRORS]{Style.RESET_ALL} Tổng số lỗi: {TOTAL_ERRORS}")
                for error_type, count in ERRORS_BY_TYPE.items():
                    if len(error_type) > 50:  # Cắt ngắn lỗi dài
                        error_type = error_type[:50] + "..."
                    print(f"  - {error_type}: {count}")
        
        time.sleep(1)  # Cập nhật mỗi giây

def generate_detailed_report(test_duration):
    """Tạo báo cáo chi tiết về kết quả stress test"""
    try:
        print(f"\n{Fore.CYAN}[REPORT]{Style.RESET_ALL} Tạo báo cáo chi tiết...")
        
        # Tạo thư mục reports nếu chưa tồn tại
        reports_dir = "stress_test_reports"
        if not os.path.exists(reports_dir):
            os.makedirs(reports_dir)
        
        # Tên file báo cáo
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        report_file = f"{reports_dir}/stress_test_report_{timestamp}.txt"
        
        with open(report_file, "w", encoding="utf-8") as f:
            # Tiêu đề báo cáo
            f.write("=" * 80 + "\n")
            f.write(f"WEBSOCKET STRESS TEST REPORT - {datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
            f.write("=" * 80 + "\n\n")
            
            # Thông tin cấu hình
            f.write("CONFIGURATION\n")
            f.write("-" * 80 + "\n")
            f.write(f"Server URL: {SERVER_URL}\n")
            f.write(f"Conversation ID: {CONVERSATION_ID}\n")
            f.write(f"Number of clients: {CONNECTION}\n")
            f.write(f"Messages per client: {MESSAGES_PER_CLIENT}\n")
            f.write(f"Delay between messages: {DELAY_BETWEEN_MESSAGES} seconds\n")
            f.write(f"Timeout: {TIMEOUT} seconds\n")
            f.write("\n")
            
            # Thông tin kết quả tổng quan
            f.write("SUMMARY RESULTS\n")
            f.write("-" * 80 + "\n")
            f.write(f"Test duration: {test_duration:.2f} seconds\n")
            f.write(f"Total messages sent: {TOTAL_SENT}\n")
            f.write(f"Total messages received: {TOTAL_RECEIVED}\n")
            if TOTAL_SENT > 0:
                success_rate = (TOTAL_RECEIVED / TOTAL_SENT) * 100
                f.write(f"Success rate: {success_rate:.2f}%\n")
            f.write(f"Total errors: {TOTAL_ERRORS}\n")
            f.write("\n")
            
            # Thông tin độ trễ
            f.write("LATENCY STATISTICS\n")
            f.write("-" * 80 + "\n")
            if LATENCIES:
                avg_latency = statistics.mean(LATENCIES) * 1000  # Convert to ms
                min_latency = min(LATENCIES) * 1000
                max_latency = max(LATENCIES) * 1000
                median_latency = statistics.median(LATENCIES) * 1000 if len(LATENCIES) > 1 else avg_latency
                p90_latency = np.percentile([lat * 1000 for lat in LATENCIES], 90) if len(LATENCIES) > 1 else max_latency
                p95_latency = np.percentile([lat * 1000 for lat in LATENCIES], 95) if len(LATENCIES) > 1 else max_latency
                p99_latency = np.percentile([lat * 1000 for lat in LATENCIES], 99) if len(LATENCIES) > 1 else max_latency
                
                std_dev = statistics.stdev(LATENCIES) * 1000 if len(LATENCIES) > 1 else 0
                
                f.write(f"Average latency: {avg_latency:.2f} ms\n")
                f.write(f"Minimum latency: {min_latency:.2f} ms\n")
                f.write(f"Maximum latency: {max_latency:.2f} ms\n")
                f.write(f"Median latency: {median_latency:.2f} ms\n")
                f.write(f"90th percentile: {p90_latency:.2f} ms\n")
                f.write(f"95th percentile: {p95_latency:.2f} ms\n")
                f.write(f"99th percentile: {p99_latency:.2f} ms\n")
                f.write(f"Standard deviation: {std_dev:.2f} ms\n")
                f.write(f"Total samples: {len(LATENCIES)}\n")
            else:
                f.write("No latency data available\n")
            f.write("\n")
            
            # Thông tin tài nguyên hệ thống
            f.write("SYSTEM RESOURCE USAGE\n")
            f.write("-" * 80 + "\n")
            if CPU_USAGE:
                avg_cpu = statistics.mean([cpu for _, cpu in CPU_USAGE])
                max_cpu = max([cpu for _, cpu in CPU_USAGE])
                min_cpu = min([cpu for _, cpu in CPU_USAGE])
                f.write(f"Average CPU usage: {avg_cpu:.2f}%\n")
                f.write(f"Maximum CPU usage: {max_cpu:.2f}%\n")
                f.write(f"Minimum CPU usage: {min_cpu:.2f}%\n")
            else:
                f.write("No CPU usage data available\n")
                
            if MEMORY_USAGE:
                avg_mem = statistics.mean([mem for _, mem in MEMORY_USAGE])
                max_mem = max([mem for _, mem in MEMORY_USAGE])
                min_mem = min([mem for _, mem in MEMORY_USAGE])
                f.write(f"Average memory usage: {avg_mem:.2f}%\n")
                f.write(f"Maximum memory usage: {max_mem:.2f}%\n")
                f.write(f"Minimum memory usage: {min_mem:.2f}%\n")
            else:
                f.write("No memory usage data available\n")
            f.write("\n")
            
            # Thông tin lỗi
            f.write("ERROR DETAILS\n")
            f.write("-" * 80 + "\n")
            if TOTAL_ERRORS > 0:
                f.write(f"Total errors: {TOTAL_ERRORS}\n")
                f.write("Error breakdown:\n")
                for error_type, count in ERRORS_BY_TYPE.items():
                    f.write(f"  - {error_type}: {count}\n")
            else:
                f.write("No errors recorded\n")
            f.write("\n")
            
            # Thống kê theo kích thước cuộc trò chuyện
            f.write("CONVERSATION SIZE STATISTICS\n")
            f.write("-" * 80 + "\n")
            if LATENCY_BY_CONVERSATION:
                f.write("Latency by number of participants:\n")
                for size, latencies in LATENCY_BY_CONVERSATION.items():
                    if latencies:
                        avg = statistics.mean(latencies)
                        min_lat = min(latencies)
                        max_lat = max(latencies)
                        median_lat = statistics.median(latencies) if len(latencies) > 1 else avg
                        f.write(f"  - Size: {size}, Samples: {len(latencies)}\n")
                        f.write(f"    Average: {avg:.2f} ms, Min: {min_lat:.2f} ms, Max: {max_lat:.2f} ms, Median: {median_lat:.2f} ms\n")
            else:
                f.write("No conversation size data available\n")
            f.write("\n")
            
            # Thông tin hiệu suất
            f.write("PERFORMANCE METRICS\n")
            f.write("-" * 80 + "\n")
            if test_duration > 0:
                msgs_per_sec = TOTAL_SENT / test_duration
                f.write(f"Messages sent per second: {msgs_per_sec:.2f}\n")
                if TOTAL_RECEIVED > 0:
                    throughput = TOTAL_RECEIVED / test_duration
                    f.write(f"Message throughput (received/second): {throughput:.2f}\n")
            f.write("\n")
            
            # Kết luận
            f.write("CONCLUSION\n")
            f.write("-" * 80 + "\n")
            if TOTAL_SENT > 0 and LATENCIES:
                success_rate = (TOTAL_RECEIVED / TOTAL_SENT) * 100
                avg_latency = statistics.mean(LATENCIES) * 1000
                
                if success_rate >= 99 and avg_latency < 100:
                    conclusion = "EXCELLENT: Hiệu suất rất tốt với tỉ lệ thành công cao và độ trễ thấp"
                elif success_rate >= 95 and avg_latency < 200:
                    conclusion = "GOOD: Hiệu suất tốt với tỉ lệ thành công cao và độ trễ chấp nhận được"
                elif success_rate >= 90 and avg_latency < 500:
                    conclusion = "ACCEPTABLE: Hiệu suất chấp nhận được nhưng cần cải thiện"
                else:
                    conclusion = "NEEDS IMPROVEMENT: Hiệu suất kém, cần điều tra và cải thiện"
                    
                f.write(f"{conclusion}\n")
                f.write(f"Success rate: {success_rate:.2f}%, Average latency: {avg_latency:.2f} ms\n")
            else:
                f.write("INCONCLUSIVE: Không đủ dữ liệu để đánh giá hiệu suất\n")
                
        print(f"{Fore.GREEN}[SUCCESS]{Style.RESET_ALL} Đã tạo báo cáo chi tiết: {report_file}")
        return True
        
    except Exception as e:
        print(f"{Fore.RED}[ERROR]{Style.RESET_ALL} Lỗi khi tạo báo cáo: {str(e)}")
        return False
    
def main():
    """Hàm chính để chạy stress test với phân tích hiệu suất chi tiết"""
    global MESSAGES_PER_CLIENT, DELAY_BETWEEN_MESSAGES, SERVER_URL, CONVERSATION_ID, TOKEN_FILE, TIMEOUT
    global START_TIME, START_MONITORING, PROGRESS, CONNECTION
    
    parser = argparse.ArgumentParser(description="WebSocket stress test với phân tích hiệu suất chi tiết")
    parser.add_argument("--url", default=SERVER_URL, help="WebSocket server URL (mặc định: ws://localhost)")
    parser.add_argument("--conversation", default=CONVERSATION_ID, help="ID cuộc trò chuyện")
    parser.add_argument("--messages", type=int, default=MESSAGES_PER_CLIENT, help="Số tin nhắn mỗi client gửi")
    parser.add_argument("--delay", type=float, default=DELAY_BETWEEN_MESSAGES, help="Độ trễ giữa các tin nhắn (giây)")
    parser.add_argument("--token-file", default=TOKEN_FILE, help="File chứa tokens")
    parser.add_argument("--clients", type=int, default=CONNECTION, help="Số lượng clients kết nối đồng thời")
    parser.add_argument("--no-charts", action="store_true", help="Không tạo biểu đồ phân tích")
    parser.add_argument("--timeout", type=int, default=TIMEOUT, help="Thời gian tối đa chờ đợi (giây)")
    parser.add_argument("--live-monitoring", action="store_true", help="Hiển thị thông số realtime")

    args = parser.parse_args()
    SERVER_URL = args.url
    CONVERSATION_ID = args.conversation
    MESSAGES_PER_CLIENT = args.messages
    DELAY_BETWEEN_MESSAGES = args.delay
    CONNECTION = args.clients
    TIMEOUT = args.timeout
    TOKEN_FILE = args.token_file

    print(f"\n{Fore.CYAN}{'='*20} WEBSOCKET STRESS TEST {'='*20}{Style.RESET_ALL}")
    print(f"{Fore.CYAN}[CONFIG]{Style.RESET_ALL} Server URL: {SERVER_URL}")
    print(f"{Fore.CYAN}[CONFIG]{Style.RESET_ALL} Conversation ID: {CONVERSATION_ID}")
    print(f"{Fore.CYAN}[CONFIG]{Style.RESET_ALL} Số clients: {CONNECTION}")
    print(f"{Fore.CYAN}[CONFIG]{Style.RESET_ALL} Số tin nhắn mỗi client: {MESSAGES_PER_CLIENT}")
    print(f"{Fore.CYAN}[CONFIG]{Style.RESET_ALL} Độ trễ giữa các tin nhắn: {DELAY_BETWEEN_MESSAGES}s")
    print(f"{Fore.CYAN}[CONFIG]{Style.RESET_ALL} Thời gian timeout: {TIMEOUT}s")
    print(f"{Fore.CYAN}[CONFIG]{Style.RESET_ALL} File token: {args.token_file}")
    print(f"{Fore.CYAN}{'='*60}{Style.RESET_ALL}\n")

    # Tải danh sách tokens
    tokens = load_tokens(args.token_file)
    if not tokens:
        print(f"{Fore.RED}[ERROR]{Style.RESET_ALL} Không có tokens để test, đang thoát...")
        return
        
    if CONNECTION > len(tokens):
        print(f"{Fore.YELLOW}[WARNING]{Style.RESET_ALL} Số lượng clients ({CONNECTION}) lớn hơn số lượng tokens ({len(tokens)})")
        print(f"{Fore.YELLOW}[WARNING]{Style.RESET_ALL} Giảm số clients xuống {len(tokens)}")
        CONNECTION = len(tokens)
    
    # Lấy thông tin về cuộc trò chuyện để phân tích độ trễ
    if tokens:
        get_conversation_info(CONVERSATION_ID, tokens[0])
    
    # Bắt đầu theo dõi tài nguyên hệ thống
    START_MONITORING = True
    monitor_thread = threading.Thread(target=monitor_system_resources, daemon=True)
    monitor_thread.start()
    
    # Bắt đầu theo dõi tiến độ
    progress_thread = threading.Thread(target=progress_monitor, daemon=True)
    progress_thread.start()
    
    print(f"{Fore.CYAN}[INFO]{Style.RESET_ALL} Bắt đầu stress test với {CONNECTION} clients...")
    START_TIME = time.time()
    
    # Hiển thị thông số realtime nếu được yêu cầu
    if args.live_monitoring:
        live_monitor_thread = threading.Thread(target=live_stats_display, daemon=True)
        live_monitor_thread.start()
    
    # Khởi tạo và chạy các client trong thread riêng biệt
    threads = []
    for i in range(CONNECTION):
        if i < len(tokens):
            client_thread = threading.Thread(
                target=create_client, 
                args=(tokens[i], i+1, CONVERSATION_ID)
            )
            threads.append(client_thread)
            client_thread.start()
            
            # Thêm độ trễ nhỏ giữa các lần khởi tạo client để tránh tải đột ngột
            time.sleep(0.1)
        else:
            print(f"{Fore.YELLOW}[WARNING]{Style.RESET_ALL} Không đủ tokens cho {CONNECTION} clients")
            break
    
    # Đặt timeout cho toàn bộ quá trình test
    def timeout_handler():
        print(f"\n{Fore.YELLOW}[TIMEOUT]{Style.RESET_ALL} Đã hết thời gian test ({TIMEOUT}s)")
        print(f"{Fore.YELLOW}[TIMEOUT]{Style.RESET_ALL} Đang kết thúc test...")
        
        # Chờ thêm 5 giây để các client có thể ghi nhận tin nhắn cuối
        time.sleep(5)
        os._exit(0)
    
    timeout_thread = threading.Timer(TIMEOUT, timeout_handler)
    timeout_thread.daemon = True
    timeout_thread.start()
    
    # Chờ tất cả các client hoàn thành
    try:
        for thread in threads:
            thread.join()
    except KeyboardInterrupt:
        print(f"\n{Fore.YELLOW}[INTERRUPT]{Style.RESET_ALL} Đã hủy test bởi người dùng")
    
    # Dừng theo dõi tài nguyên
    START_MONITORING = False
    
    # Đánh dấu test đã hoàn thành
    with LOCK:
        PROGRESS["test_completed"] = True
    
    # Tính thời gian test
    test_duration = time.time() - START_TIME
    
    # Hiển thị kết quả
    print(f"\n{Fore.CYAN}{'='*20} KẾT QUẢ TEST {'='*20}{Style.RESET_ALL}")
    print(f"{Fore.CYAN}[RESULT]{Style.RESET_ALL} Thời gian thực hiện: {test_duration:.2f} giây")
    print(f"{Fore.CYAN}[RESULT]{Style.RESET_ALL} Tổng tin nhắn đã gửi: {TOTAL_SENT}")
    print(f"{Fore.CYAN}[RESULT]{Style.RESET_ALL} Tổng tin nhắn đã nhận: {TOTAL_RECEIVED}")
    
    if TOTAL_SENT > 0:
        success_rate = (TOTAL_RECEIVED / TOTAL_SENT) * 100
        print(f"{Fore.CYAN}[RESULT]{Style.RESET_ALL} Tỉ lệ thành công: {success_rate:.2f}%")
    
    if LATENCIES:
        avg_latency = statistics.mean(LATENCIES) * 1000  # Chuyển sang ms
        min_latency = min(LATENCIES) * 1000
        max_latency = max(LATENCIES) * 1000
        p95_latency = np.percentile([lat * 1000 for lat in LATENCIES], 95) if len(LATENCIES) > 1 else avg_latency
        p99_latency = np.percentile([lat * 1000 for lat in LATENCIES], 99) if len(LATENCIES) > 1 else max_latency
        
        print(f"{Fore.CYAN}[LATENCY]{Style.RESET_ALL} Độ trễ trung bình: {avg_latency:.2f} ms")
        print(f"{Fore.CYAN}[LATENCY]{Style.RESET_ALL} Độ trễ thấp nhất: {min_latency:.2f} ms")
        print(f"{Fore.CYAN}[LATENCY]{Style.RESET_ALL} Độ trễ cao nhất: {max_latency:.2f} ms")
        print(f"{Fore.CYAN}[LATENCY]{Style.RESET_ALL} Độ trễ P95: {p95_latency:.2f} ms")
        print(f"{Fore.CYAN}[LATENCY]{Style.RESET_ALL} Độ trễ P99: {p99_latency:.2f} ms")
    
    if CPU_USAGE:
        avg_cpu = statistics.mean([cpu for _, cpu in CPU_USAGE])
        max_cpu = max([cpu for _, cpu in CPU_USAGE])
        print(f"{Fore.CYAN}[RESOURCE]{Style.RESET_ALL} CPU trung bình: {avg_cpu:.2f}%")
        print(f"{Fore.CYAN}[RESOURCE]{Style.RESET_ALL} CPU cao nhất: {max_cpu:.2f}%")
    
    if MEMORY_USAGE:
        avg_mem = statistics.mean([mem for _, mem in MEMORY_USAGE])
        max_mem = max([mem for _, mem in MEMORY_USAGE])
        print(f"{Fore.CYAN}[RESOURCE]{Style.RESET_ALL} RAM trung bình: {avg_mem:.2f}%")
        print(f"{Fore.CYAN}[RESOURCE]{Style.RESET_ALL} RAM cao nhất: {max_mem:.2f}%")
    
    # Hiển thị thông tin lỗi
    if TOTAL_ERRORS > 0:
        print(f"\n{Fore.RED}[ERRORS]{Style.RESET_ALL} Tổng số lỗi: {TOTAL_ERRORS}")
        print(f"{Fore.RED}[ERRORS]{Style.RESET_ALL} Chi tiết lỗi:")
        for error_type, count in ERRORS_BY_TYPE.items():
            print(f"  - {error_type}: {count}")
    
    # Tạo biểu đồ phân tích hiệu suất nếu không có cờ --no-charts
    if not args.no_charts:
        print(f"\n{Fore.CYAN}[INFO]{Style.RESET_ALL} Đang tạo biểu đồ phân tích...")
        charts_created = draw_charts(test_duration)
        if charts_created:
            print(f"{Fore.GREEN}[SUCCESS]{Style.RESET_ALL} Đã tạo các biểu đồ phân tích hiệu suất")
        else:
            print(f"{Fore.YELLOW}[WARNING]{Style.RESET_ALL} Không thể tạo biểu đồ phân tích")
    
    # Thống kê theo kích thước cuộc trò chuyện (số người tham gia)
    if LATENCY_BY_CONVERSATION:
        print(f"\n{Fore.CYAN}[STATS]{Style.RESET_ALL} Độ trễ theo số lượng người tham gia:")
        for size, latencies in LATENCY_BY_CONVERSATION.items():
            if latencies:
                avg = statistics.mean(latencies)
                print(f"  - Số người: {size}, Độ trễ trung bình: {avg:.2f} ms, Mẫu: {len(latencies)}")
    
    # Xuất báo cáo chi tiết dạng bảng
    generate_detailed_report(test_duration)
    
    print(f"\n{Fore.GREEN}[SUCCESS]{Style.RESET_ALL} Đã hoàn thành stress test!")

if __name__ == "__main__":
    main()