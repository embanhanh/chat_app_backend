# 📱 Chat App Backend - Hướng Dẫn Chạy Ứng Dụng

## 📋 Cài Đặt Môi Trường

### Yêu Cầu

- Node.js (v14+)
- Docker và Docker Compose
- Kubernetes (Minikube)
- MongoDB (Có thể sử dụng MongoDB Atlas)
- Kafka
- Redis Cluster

## 🚀 Các Bước Chạy Ứng Dụng

### 1. Cài Đặt Phụ Thuộc

Cài đặt thư viện cho cả API Gateway và Chat App:

```bash
# Cài đặt thư viện cho API Gateway
cd api-gateway
npm install

# Cài đặt thư viện cho Chat App
cd ../chat-app
npm install
```

### 2. Cấu Hình Biến Môi Trường

Tạo file `.env` trong thư mục `chat-app`:

```
PORT=5000
MONGO_URI=mongodb+srv://your-username:your-password@cluster.mongodb.net/chatapp
JWT_SECRET=your-jwt-secret
S3_BUCKET_NAME=your-s3-bucket
S3_REGION=your-s3-region
S3_ACCESS_KEY=your-s3-access-key
S3_SECRET_KEY=your-s3-secret-key
KAFKA_BROKERS=kafka:9092
REDIS_HOST=localhost
REDIS_PORT=6379
```

Tạo file `.env` trong thư mục `api-gateway`:

```
PORT=3000
CHAT_SERVICE_URL=http://localhost:5000
NODE_ENV=development
```

### 3. Chạy Với Docker Compose (Phát Triển)

Sử dụng Docker Compose để chạy tất cả các dịch vụ cần thiết:

```bash
cd chat-app
docker-compose up -d
```

### 4. Chạy Trực Tiếp (Development)

Nếu bạn muốn chạy ứng dụng trực tiếp không qua Docker:

1. Khởi động các dịch vụ Redis, MongoDB và Kafka riêng lẻ
2. Khởi động Chat App:
   ```bash
   cd chat-app
   npm run dev  # hoặc "npm start" nếu không dùng nodemon
   ```
3. Khởi động API Gateway:
   ```bash
   cd api-gateway
   npm run dev  # hoặc "npm start" nếu không dùng nodemon
   ```

### 5. Deploy trên Kubernetes (Minikube)

Tham khảo hướng dẫn chi tiết trong [thư mục k8s](./k8s/README.md).

## 📊 Kiểm Tra Ứng Dụng

Khi ứng dụng được khởi động:

1. API Gateway sẽ chạy tại: http://localhost:3000
2. Chat App sẽ chạy tại: http://localhost:5000

Kiểm tra API health:

```
GET http://localhost:3000/health
```

### Đăng ký tài khoản:

```
POST http://localhost:3000/api/auth/register
Content-Type: application/json

{
  "username": "tester",
  "email": "test@example.com",
  "password": "password123"
}
```

### Đăng nhập:

```
POST http://localhost:3000/api/auth/login
Content-Type: application/json

{
  "email": "test@example.com",
  "password": "password123"
}
```

## 🐞 Xử Lý Lỗi Thường Gặp

### 1. Lỗi "BadRequestError: request aborted"

Nguyên nhân: Xung đột trong việc parse body JSON giữa API Gateway và Chat App.

Giải pháp: Đã được sửa trong API Gateway bằng cách:

- Thêm middleware parse JSON riêng cho các endpoint cụ thể
- Cấu hình lại proxy để xử lý body request đúng cách

### 2. Lỗi kết nối Redis Cluster

Kiểm tra cấu hình Redis trong file `chat-app/src/config/redis.js` và đảm bảo Redis Cluster đang chạy.

### 3. Lỗi kết nối Kafka

Kiểm tra Kafka service đang chạy và cấu hình trong `chat-app/src/services/KafkaService.js`.

## 📖 API Documentation

API Gateway cung cấp các endpoint sau:

1. **Auth API**

   - `POST /api/auth/register`: Đăng ký tài khoản
   - `POST /api/auth/login`: Đăng nhập
   - `POST /api/auth/fcm-token`: Cập nhật FCM token
   - `DELETE /api/auth/fcm-token`: Xóa FCM token

2. **Users API**

   - `GET /api/users`: Lấy danh sách người dùng
   - `GET /api/users/me`: Lấy thông tin người dùng hiện tại
   - `PUT /api/users/me`: Cập nhật thông tin người dùng

3. **Conversations API**

   - `GET /api/conversations`: Lấy danh sách cuộc hội thoại
   - `POST /api/conversations`: Tạo cuộc hội thoại mới
   - `GET /api/conversations/:id`: Lấy chi tiết cuộc hội thoại

4. **Messages API**

   - `GET /api/messages/:conversationId`: Lấy tin nhắn theo cuộc hội thoại
   - `POST /api/messages`: Gửi tin nhắn mới

5. **Notifications API**

   - `GET /api/notifications`: Lấy thông báo
   - `PUT /api/notifications/:id`: Đánh dấu đã đọc

6. **Files API**

   - `POST /api/files/upload`: Tải file lên
   - `GET /api/files/:fileId`: Lấy thông tin file

7. **Search API**
   - `GET /api/search?q=query`: Tìm kiếm người dùng và hội thoại

## 📡 WebSocket

Ứng dụng sử dụng Socket.IO cho real-time communication, với các sự kiện:

1. `connection`: Kết nối mới
2. `disconnect`: Ngắt kết nối
3. `join_conversation`: Tham gia cuộc hội thoại
4. `leave_conversation`: Rời cuộc hội thoại
5. `new_message`: Tin nhắn mới
6. `typing`: Người dùng đang nhập
7. `stop_typing`: Người dùng dừng nhập
8. `message_read`: Đánh dấu tin nhắn đã đọc

## 📝 Kiểm thử tải (Load Testing)

Sử dụng script có sẵn để test tải:

```bash
cd chat-app/test
python stress_test.py
```

---

© 2025 Chat App Backend
