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
    console.log("Received member_added message:", message);
    const data = JSON.parse(message);
    const { conversationId, users, newParticipantId } = data;

    console.log(
      `Emitting memberAdded for conversation ${conversationId}, new participant ${newParticipantId}`
    );
    const room = `conversation:${conversationId}`; // Thêm dòng này
    global.io.to(room).emit("memberAdded", {
      type: "memberAdded",
      data: {
        conversationId,
        users,
      },
    });

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

// Xử lý lời mời kết bạn
async function handleFriendRequest(message) {
  try {
    const data = JSON.parse(message);
    const { senderId, receiverId, senderInfo } = data;

    const receiver = `user:${receiverId}`;
    const clients = await global.io.in(receiver).allSockets();

    if (clients.size === 0) {
      // Lưu lời mời vào Redis nếu receiver offline
      await redisClient.lPush(
        `pending_friend_requests:${receiverId}`,
        JSON.stringify({ senderId, senderInfo, timestamp: new Date().toISOString() })
      );      
    } else {
      // Gửi thông báo tới receiver
      global.io.to(receiver).emit("friend_request", {
        type: "friendRequest",
        data: {
          senderId,
          senderInfo: {
            _id: senderInfo._id,
            username: senderInfo.username,
            avatar: senderInfo.avatar || "",
            timestamp: senderInfo.timestamp || new Date().toISOString(),
          },
        },
      });      
    }

    // Gửi xác nhận tới sender
    const sender = `user:${senderId}`;    
    global.io.to(sender).emit("friend_request", {
      type: "friendRequestSent",
      data: {
        receiverId,
        timestamp: senderInfo.timestamp || new Date().toISOString(),
      },
    });    
  } catch (error) {
    console.error("Error in handleFriendRequest:", error);
  }
}

// Xử lý chấp nhận lời mời kết bạn
async function handleFriendRequestAccepted(message) {
  try {
    const data = JSON.parse(message);
    const { senderId, receiverId, conversationSenderData, conversationReceiverData } = data;

    const receiverRoom = `user:${receiverId}`;
    const clients = await global.io.in(receiverRoom).allSockets();

    if (clients.size > 0) {      
      global.io.to(receiverRoom).emit("friend_request_accepted", {
        type: "friendRequestAccepted",
        data: {
          senderId,
          conversationSenderData,
        },
      });
    } else {
      // Lưu thông báo vào Redis nếu receiver offline
      await redisClient.lPush(
        `pending_friend_request_accepted:${receiverId}`,
        JSON.stringify({ senderId, conversationSenderData })
      );
    }

    // Gửi xác nhận tới sender
    const senderRoom = `user:${senderId}`;      
    global.io.to(senderRoom).emit("friend_request_accepted", {
      type: "friendRequestAccepted",
      data: { receiverId, conversationReceiverData },
    });
  } catch (error) {
    console.error("Error in handleFriendRequestAccepted:", error);
  }
}

// Khởi tạo Redis subscribers
async function initRedisSubscribers() {
  if (isSubscribed) return;
  
  console.log("Initializing Redis subscribers...");
  globalSubscriber = redisClient.duplicate();
  await globalSubscriber.connect();

  globalSubscriber.on("error", (error) => {
    console.error("Redis subscriber error:", error);
    isSubscribed = false;
    initRedisSubscribers();
  });

  // Đăng ký các kênh
  await globalSubscriber.subscribe("new_message", handleNewMessage);
  await globalSubscriber.subscribe("message_read", handleMessageRead);
  await globalSubscriber.subscribe("message_deleted", handleMessageDeleted);
  await globalSubscriber.subscribe("member_added", handleMemberAdded);
  await globalSubscriber.subscribe("member_removed", handleMemberRemoved);
  await globalSubscriber.subscribe("group_created", handleGroupCreated);
  await globalSubscriber.subscribe("group_name_updated", handleGroupNameUpdated);
  await globalSubscriber.subscribe("conversation_deleted", handleConversationDeleted);
  await globalSubscriber.subscribe("friend_request", handleFriendRequest);
  await globalSubscriber.subscribe("friend_request_accepted", handleFriendRequestAccepted);

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

    // Gửi các lời mời pending cho user
    const pendingRequests = await redisClient.lRange(
      `pending_friend_requests:${socket.userId}`,
      0,
      -1
    );
    if (pendingRequests.length > 0) {
      for (const request of pendingRequests) {
        const { senderId, senderInfo } = JSON.parse(request);
        socket.emit("friend_request", {
          type: "friendRequest",
          data: { senderId, senderInfo },
        });
        console.log(`Sent pending friend_request to ${socket.userId}`);
      }
      await redisClient.del(`pending_friend_requests:${socket.userId}`);
    }
    
    // Gửi các thông báo chấp nhận kết bạn pending
    const pendingAccepted = await redisClient.lRange(
      `pending_friend_request_accepted:${socket.userId}`,
      0,
      -1
    );
    if (pendingAccepted.length > 0) {
      for (const accepted of pendingAccepted) {
        const { senderId, conversationData } = JSON.parse(accepted);
        socket.emit("friend_request_accepted", {
          type: "friendRequestAccepted",
          data: { senderId, conversationData },
        });
        console.log(`Sent pending friend_request_accepted to ${socket.userId}`);
      }
      await redisClient.del(`pending_friend_request_accepted:${socket.userId}`);
    }

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
    socket.on("join_conversation", (payload) => {
      try {
        const conversationId = payload.data.conversationId; // Lấy conversationId từ payload
        socket.join(`conversation:${conversationId}`);

        // Send confirmation to client
        socket.emit("joined_conversation", { 
          conversationId,
          success: true
        });
        console.log(
          `User ${socket.userId} joined conversation conversation:${conversationId}`
        );
        console.log("Socket rooms:", socket.rooms);
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
