require("dotenv").config();
const jwt = require("jsonwebtoken");
const { redisClient } = require("./config/redis");
const UserService = require("./services/UserService");
const MessageService = require("./services/MessageService");

// Tạo một global subscriber cho toàn bộ hệ thống
let globalSubscriber = null;
let isSubscribed = false;

// Xử lý tin nhắn mới từ Redis và gửi đến các clients
async function handleNewMessage(message) {
  try {
    const data = JSON.parse(message);
    const room = `conversation:${data.conversation}`;
    console.log(room);
    console.log("handleNewMessage is running");
    
    // Kiểm tra số lượng client trong room
    const clients = await global.io.in(room).allSockets();
    console.log(`Clients in room ${room}:`, clients.size);
    
    // Gửi đến tất cả clients trong room với cả 2 cách
    global.io.to(room).emit("new_message", {
      message: data.message,
      conversationId: data.conversation
    });
    
    // Gửi cả dạng JSON string cho Postman
    global.io.to(room).emit("new_message_json", JSON.stringify({
      message: data.message,
      conversationId: data.conversation
    }));
    
    console.log("Message emitted to room:", room);
  } catch (error) {
    console.error("Error handling new message:", error);
  }
}
// Xử lý khi người dùng gửi lời mời kết bạn
async function handleFriendRequest(message) {
  try {
    const data = JSON.parse(message);
    const { senderId, receiverId, senderInfo } = data;
    console.log("Friend request data:", data);

    const receiver = `user:${receiverId}`;

    // Gửi thông báo đến người nhận lời mời kết bạn
    global.io.to(receiver).emit("friend_request", {
      type: "friendRequest",
      data: {
        senderId,
        senderInfo: senderInfo || {
          _id: senderId,
          timestamp: new Date().toISOString()
        }
      }
    });

    // Gửi thông báo xác nhận đến người gửi
    global.io.to(`user:${senderId}`).emit("friend_request_sent", {
      type: "friendRequestSent",
      data: {
        receiverId
      }
    });

    // Gửi thêm bản dạng JSON string (để test với Postman nếu cần)
    global.io.to(`user:${senderId}`).emit("friend_request_sent_json", JSON.stringify({
      type: "friendRequestSent",
      data: {
        receiverId
      }
    }));

    console.log(`Emitted friend request to user:${receiverId} and confirmation to user:${senderId}`);

  } catch (error) {
    console.error("Error handling friend request:", error);
  }
}


async function handleGroupCreated(message) {
  try {
    const data = JSON.parse(message);
    const { conversationId, name, creatorId, participantIds, users } = data;

    // Thông báo cho tất cả thành viên (bao gồm người tạo)
    participantIds.forEach((userId) => {
      global.io.to(`user:${userId}`).emit("groupCreated", {
        type: "groupCreated",
        data: {
          conversationId,
          name,
          creatorId,
          users,
        },
      });
    });

    // Tự động yêu cầu các thành viên tham gia phòng
    participantIds.forEach((userId) => {
      global.io.to(`user:${userId}`).emit("joinConversation", {
        conversationId,
      });
    });
  } catch (error) {
    console.error("Error handling group created:", error);
  }
}

async function handleMemberAdded(message) {
  try {
    const data = JSON.parse(message);
    const { conversationId, users, newParticipantId } = data;

    // Phát sự kiện đến các thành viên hiện tại trong phòng
    global.io.to(`conversation:${conversationId}`).emit("memberAdded", {
      type: "memberAdded",
      data: {
        conversationId,
        users,
      },
    });

    // Thông báo cho người dùng mới để tham gia phòng
    global.io.to(`user:${newParticipantId}`).emit("addedToConversation", {
      conversationId,
    });
  } catch (error) {
    console.error("Error handling member added:", error);
  }
}

async function handleMemberRemoved(message) {
  try {
    const data = JSON.parse(message);
    const { conversationId, userId } = data;

    // Thông báo cho các thành viên hiện tại trong nhóm
    global.io.to(`conversation:${conversationId}`).emit("memberRemoved", {
      type: "memberRemoved",
      data: {
        conversationId,
        userId,
      },
    });

    // Thông báo cho người dùng bị xóa
    global.io.to(`user:${userId}`).emit("removedFromConversation", {
      conversationId,
    });
  } catch (error) {
    console.error("Error handling member removed:", error);
  }
}

// Xử lý đánh dấu đã đọc tin nhắn
async function handleMessageRead(message) {
  try {
    const data = JSON.parse(message);
    global.io.to(`conversation:${data.conversationId}`).emit("message_read", {
      userId: data.userId,
      conversationId: data.conversationId,
    });
  } catch (error) {
    console.error("Error handling message read:", error);
  }
}

// Xử lý xóa tin nhắn
async function handleMessageDeleted(message) {
  try {
    const data = JSON.parse(message);
    global.io
      .to(`conversation:${data.conversationId}`)
      .emit("message_deleted", {
        messageId: data.messageId,
        conversationId: data.conversationId,
      });
  } catch (error) {
    console.error("Error handling message deletion:", error);
  }
}

async function handleGroupNameUpdated(message) {
  try {
    const data = JSON.parse(message);
    const { conversationId, name, updatedBy } = data;

    // Thông báo cho tất cả thành viên trong nhóm
    global.io.to(`conversation:${conversationId}`).emit("groupNameUpdated", {
      type: "groupNameUpdated",
      data: {
        conversationId,
        name,
        updatedBy,
      },
    });
  } catch (error) {
    console.error("Error handling group name updated:", error);
  }
}

async function handleConversationDeleted(message) {
  try {
    const data = JSON.parse(message);
    const { conversationId, participantIds } = data;

    participantIds.forEach((userId) => {
      global.io.to(`user:${userId}`).emit("conversationDeleted", {
        type: "conversationDeleted",
        data: {
          conversationId,
        },
      });
    });

    global.io.to(`conversation:${conversationId}`).emit("leaveConversation", {
      conversationId,
    });
  } catch (error) {
    console.error("Error handling conversation deleted:", error);
  }
}

// Khởi tạo Redis subscribers
async function initRedisSubscribers() {
  if (isSubscribed) return;

  console.log("Initializing Redis subscribers...");
  globalSubscriber = redisClient.duplicate();
  await globalSubscriber.connect();

  // Đăng ký các kênh
  await globalSubscriber.subscribe("new_message", handleNewMessage);
  await globalSubscriber.subscribe("message_read", handleMessageRead);
  await globalSubscriber.subscribe("message_deleted", handleMessageDeleted);
  await globalSubscriber.subscribe("member_added", handleMemberAdded);
  await globalSubscriber.subscribe("member_removed", handleMemberRemoved);
  await globalSubscriber.subscribe("group_created", handleGroupCreated);
  await globalSubscriber.subscribe(
    "group_name_updated",
    handleGroupNameUpdated
  );
  await globalSubscriber.subscribe(
    "conversation_deleted",
    handleConversationDeleted
  );
  await globalSubscriber.subscribe("friend_request", handleFriendRequest);
  await globalSubscriber.subscribe("friend_request_sent_json", handleFriendRequest);


  isSubscribed = true;
  console.log("Redis subscribers initialized successfully");
}

const setupWebSocket = (io) => {
  // Lưu trữ io trong global để có thể truy cập từ các hàm xử lý Redis
  global.io = io;

  // Khởi tạo Redis subscribers
  initRedisSubscribers();

  // Middleware to authenticate socket connections
  io.use(async (socket, next) => {
    try {
      const token =
        socket.handshake.auth?.token || socket.handshake.headers?.token;
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
    console.log(`User connected: ${userId}, socket ID: ${socket.id}`);
    
    let reconnectAttempts = 0;
    const maxReconnectAttempts = 5;
    const reconnectDelay = 5000; // 5 seconds

    // Join user's room
    socket.join(`user:${userId}`);
    console.log(`User ${userId} joined room user:${userId}`);

    // Update user's online status
    await UserService.updateOnlineStatus(userId, "online");

    // Event handlers for testing with Postman
    socket.on("test", (data) => {
      console.log("Test event received:", data);
      // Send a response back to confirm
      socket.emit("test_response", { message: "Test received", data });
    });
    
    // Testing event for direct message
    socket.on("direct_message", async (data) => {
      try {
        console.log("Direct message event received:", data);
        
        // Send a direct message to a specific user
        if (data.receiverId) {
          const receiver = `user:${data.receiverId}`;
          global.io.to(receiver).emit("direct_message", {
            message: data.message,
            senderId: userId
          });
          // Also send as JSON string for Postman testing
          global.io.to(receiver).emit("direct_message_json", JSON.stringify({
            message: data.message,
            senderId: userId
          }));
          console.log(`Direct message sent to ${receiver}`);
          
          // Confirm to sender
          socket.emit("direct_message_sent", { 
            success: true, 
            receiverId: data.receiverId 
          });
        }
      } catch (error) {
        console.error("Error in direct_message:", error);
        socket.emit("error", { message: "Failed to send direct message" });
      }
    });

    // Handle joining conversations
    socket.on("join_conversation", (conversationId) => {
      try {
        const room = `conversation:${conversationId}`;
        socket.join(room);
        console.log(`User ${userId} joined conversation ${conversationId}`);
        
        // Send confirmation to client
        socket.emit("joined_conversation", { 
          conversationId,
          success: true
        });
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
      } catch (error) {
        console.error("Error handling disconnection:", error);
      }
    });
  });
};

module.exports = setupWebSocket;
