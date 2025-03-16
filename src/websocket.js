require("dotenv").config();
const jwt = require("jsonwebtoken");
const { redisClient } = require("./config/redis");
const UserService = require("./services/UserService");
const MessageService = require("./services/MessageService");

const setupWebSocket = (io) => {
  // Middleware to authenticate socket connections
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      if (!token) {
        throw new Error("Authentication error");
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.id;
      next();
    } catch (error) {
      next(new Error("Authentication error"));
    }
  });

  // Handle socket connections
  io.on("connection", async (socket) => {
    const userId = socket.userId;
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 5;
    const reconnectDelay = 5000; // 5 seconds

    // Join user's room
    socket.join(`user:${userId}`);

    // Update user's online status
    await UserService.updateOnlineStatus(userId, "online");

    // Subscribe to Redis channels
    const subscriber = redisClient.duplicate();
    await subscriber.connect();

    // Handle new messages
    await subscriber.subscribe("new_message", async (message) => {
      try {
        const data = JSON.parse(message);
        const room = `conversation:${data.conversation}`;
        io.to(room).emit("new_message", data.message);
      } catch (error) {
        console.error("Error handling new message:", error);
        socket.emit("error", { message: "Lỗi khi xử lý tin nhắn mới" });
      }
    });

    // Handle message read receipts
    await subscriber.subscribe("message_read", async (message) => {
      try {
        const data = JSON.parse(message);
        io.to(`conversation:${data.conversationId}`).emit("message_read", {
          userId: data.userId,
          conversationId: data.conversationId,
        });
      } catch (error) {
        console.error("Error handling message read:", error);
        socket.emit("error", { message: "Lỗi khi xử lý trạng thái đã đọc" });
      }
    });

    // Handle message deletions
    await subscriber.subscribe("message_deleted", async (message) => {
      try {
        const data = JSON.parse(message);
        io.to(`conversation:${data.conversationId}`).emit("message_deleted", {
          messageId: data.messageId,
          conversationId: data.conversationId,
        });
      } catch (error) {
        console.error("Error handling message deletion:", error);
        socket.emit("error", { message: "Lỗi khi xử lý xóa tin nhắn" });
      }
    });

    // Handle joining conversations
    socket.on("join_conversation", (conversationId) => {
      try {
        socket.join(`conversation:${conversationId}`);
      } catch (error) {
        console.error("Error joining conversation:", error);
        socket.emit("error", { message: "Lỗi khi tham gia cuộc trò chuyện" });
      }
    });

    // Handle leaving conversations
    socket.on("leave_conversation", (conversationId) => {
      try {
        socket.leave(`conversation:${conversationId}`);
      } catch (error) {
        console.error("Error leaving conversation:", error);
        socket.emit("error", { message: "Lỗi khi rời cuộc trò chuyện" });
      }
    });

    // Handle typing status
    socket.on("typing_start", (conversationId) => {
      try {
        socket.to(`conversation:${conversationId}`).emit("typing_start", {
          userId,
          conversationId,
        });
      } catch (error) {
        console.error("Error handling typing start:", error);
        socket.emit("error", { message: "Lỗi khi xử lý trạng thái đang nhập" });
      }
    });

    socket.on("typing_end", (conversationId) => {
      try {
        socket.to(`conversation:${conversationId}`).emit("typing_end", {
          userId,
          conversationId,
        });
      } catch (error) {
        console.error("Error handling typing end:", error);
        socket.emit("error", { message: "Lỗi khi xử lý trạng thái đang nhập" });
      }
    });

    // Handle socket errors
    socket.on("error", (error) => {
      console.error("Socket error:", error);
      socket.emit("error", { message: "Có lỗi xảy ra" });
    });

    // Handle disconnection
    socket.on("disconnect", async () => {
      try {
        await UserService.updateOnlineStatus(userId, "offline");
        await subscriber.quit();

        // Implement reconnection logic
        // if (reconnectAttempts < maxReconnectAttempts) {
        //   setTimeout(async () => {
        //     try {
        //       await socket.connect();
        //       reconnectAttempts = 0;
        //     } catch (error) {
        //       console.error("Reconnection failed:", error);
        //       reconnectAttempts++;
        //     }
        //   }, reconnectDelay);
        // }
      } catch (error) {
        console.error("Error handling disconnection:", error);
      }
    });
  });
};

module.exports = setupWebSocket;
