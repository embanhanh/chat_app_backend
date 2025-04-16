require("dotenv").config();
const User = require("../models/User");
const Conversation = require("../models/Conversation");
const jwt = require("jsonwebtoken");
const { redisClient } = require("../config/redis");
const sendEmail = require("../utils/sendEmail");

class UserService {
  // Create JWT token
  static generateToken(userId) {
    return jwt.sign({ id: userId }, process.env.JWT_SECRET, {
      expiresIn: process.env.JWT_EXPIRES_IN,
    });
  }

  // Register new user
  static async register(userData) {
    const user = new User(userData);
    await user.save();
    const token = this.generateToken(user._id);
    return { user: user.getPublicProfile(), token };
  }

  // Login user
  static async login(email, password) {
    const user = await User.findOne({ email });
    if (!user || !(await user.comparePassword(password))) {
      throw { message: "Email hoặc mật khẩu không chính xác" };
    }

    const token = this.generateToken(user._id);
    return { user: user.getPublicProfile(), token };
  }

  // Update user's FCM token
  static async updateFCMToken(userId, token, device) {
    try {
      const user = await User.findById(userId);
      if (!user) throw { message: "Không tìm thấy người dùng" };
      // Remove old token for this device if exists
      user.fcmTokens = user.fcmTokens.filter((t) => t.device !== device);
      user.fcmTokens.push({ token, device });
      await user.save();
    } catch (error) {
      console.error("Error updating FCM token:", error.message);
      throw error;
    }
  }

  // Push fcm token to user
  static async pushFCMToken(userId, token, device) {
    const user = await User.findById(userId);
    if (!user) throw { message: "Không tìm thấy người dùng" };
    user.fcmTokens.push({ token, device });
    await user.save();
  }

  // Delete fcm token from user
  static async deleteFCMToken(userId, token, device) {
    const user = await User.findById(userId);
    if (!user) throw { message: "Không tìm thấy người dùng" };
    user.fcmTokens = user.fcmTokens.filter((t) => t.device !== device);
    await user.save();
  }

  // Search users
  static async searchUsers(query, currentUserId) {
    return User.find({
      $and: [
        { _id: { $ne: currentUserId } },
        {
          $or: [
            { username: { $regex: query, $options: "i" } },
            { email: { $regex: query, $options: "i" } },
          ],
        },
      ],
    })
      .select("-password -fcmTokens")
      .limit(20);
  }

  // Update user's online status
  static async updateOnlineStatus(userId, status) {
    await User.findByIdAndUpdate(userId, {
      status,
      lastSeen: new Date(),
    });

    // Cache user's status in Redis for quick access
    await redisClient.set(`user:${userId}:status`, status);
  }

  // Get user's online status
  static async getOnlineStatus(userId) {
    // Try to get from cache first
    const cachedStatus = await redisClient.get(`user:${userId}:status`);
    if (cachedStatus) return cachedStatus;

    // If not in cache, get from DB and cache it
    const user = await User.findById(userId).select("status");
    if (user) {
      await redisClient.set(`user:${userId}:status`, user.status);
      return user.status;
    }
    return "offline";
  }

  // Get info of user
  static async getUserInfo(userId) {
    const user = await User.findById(userId);
    if (!user) throw { message: "Không tìm thấy người dùng" };
    return user;
  }

  // Get user's friends
  static async getUserFriends(userId) {
    const user = await User.findById(userId).populate("friends");
    if (!user) throw { message: "Không tìm thấy người dùng" };
    return user.friends;
  }

  // Get user's friend requests
  static async getUserFriendRequests(userId) {
    const user = await User.findById(userId).populate("friendRequests");
    if (!user) throw { message: "Không tìm thấy người dùng" };
    return user.friendRequests;
  }

  static async sendFriendRequest(senderId, receiverId) {
    // Lấy thông tin sender và receiver
    const [sender, receiver] = await Promise.all([
      User.findById(senderId).select("username avatar fcmTokens"),
      User.findById(receiverId).select("friendRequests friends fcmTokens"),
    ]);

    // Kiểm tra điều kiện
    if (!sender || !receiver) {
      throw { message: "Không tìm thấy người dùng", status: 404 };
    }
    if (sender._id.equals(receiver._id)) {
      throw { message: "Không thể gửi lời mời cho chính mình", status: 400 };
    }
    if (receiver.friendRequests.includes(senderId)) {
      throw { message: "Đã gửi lời mời trước đó", status: 400 };
    }
    if (receiver.friends.includes(senderId)) {
      throw { message: "Đã là bạn bè", status: 400 };
    }

    // Lưu lời mời vào friendRequests của receiver
    receiver.friendRequests.push(senderId);
    await receiver.save();

    // Chuẩn bị thông tin sender
    const senderInfo = {
      _id: sender._id.toString(),
      username: sender.username,
      avatar: sender.avatar || "",
      timestamp: new Date().toISOString(),
    };

    // Gửi thông báo đẩy FCM tới receiver
    let pushStatus = "no_tokens";
    if (receiver.fcmTokens?.length > 0) {
      try {
        const message = {
          tokens: receiver.fcmTokens.map((t) => t.token),
          notification: {
            title: "Lời mời kết bạn mới",
            body: `${sender.username} đã gửi bạn một lời mời kết bạn!`,
          },
          data: {
            type: "FRIEND_REQUEST",
            senderId: senderId.toString(),
            receiverId: receiverId.toString(),
            senderUsername: sender.username,
            click_action: "FLUTTER_NOTIFICATION_CLICK",
          },
          apns: {
            payload: {
              aps: {
                sound: "default",
              },
            },
          },
          android: {
            priority: "high",
          },
        };

        const response = await admin.messaging().sendEachForMulticast(message);
        const successCount = response.successCount;
        const failureCount = response.failureCount;

        // Xóa token không hợp lệ
        if (failureCount > 0) {
          const failedTokens = [];
          response.responses.forEach((resp, idx) => {
            if (!resp.success) {
              failedTokens.push(receiver.fcmTokens[idx].token);
            }
          });
          receiver.fcmTokens = receiver.fcmTokens.filter(
            (t) => !failedTokens.includes(t.token)
          );
          await receiver.save();
        }

        pushStatus = successCount > 0 ? "sent" : "failed";
        console.log(
          `FCM to ${receiverId}: ${successCount} success, ${failureCount} failed`
        );
      } catch (error) {
        console.error("FCM push error:", error);
        pushStatus = "failed";
      }
    } else {
      console.log(`No FCM tokens found for receiver: ${receiverId}`);
    }

    // Publish thông điệp tới Redis cho WebSocket
    try {
      await redisClient.publish(
        "friend_request",
        JSON.stringify({ senderId, receiverId, senderInfo })
      );
      console.log(`Published friend_request for ${senderId} to ${receiverId}`);
    } catch (error) {
      console.error("Redis publish error:", error);
    }

    // Trả về response cho sender
    return {
      message: "Lời mời kết bạn đã được gửi thành công!",
      senderId,
      receiverId,
      senderInfo,
      deliveryStatus: {
        websocket: "pending", // Sẽ được cập nhật qua WebSocket
        push: pushStatus,
      },
    };
  }

  
  // Accept friend request
  static async acceptFriendRequest(userId, friendId) {
    // Lấy thông tin user và friend với các trường cần thiết
    const [user, friend] = await Promise.all([
      User.findById(userId).select("username friendRequests friends fcmTokens"),
      User.findById(friendId).select("username avatar friends fcmTokens"),
    ]);

    // Kiểm tra sự tồn tại của user và friend
    if (!user || !friend) {
      throw { message: "Không tìm thấy người dùng", status: 404 };
    }

    // Kiểm tra lời mời kết bạn
    if (!user.friendRequests.includes(friendId)) {
      throw { message: "Không tìm thấy lời mời kết bạn", status: 400 };
    }

    // Kiểm tra xem đã là bạn bè chưa
    if (user.friends.includes(friendId) || friend.friends.includes(userId)) {
      throw { message: "Đã là bạn bè", status: 400 };
    }

    // Cập nhật danh sách bạn bè và xóa lời mời
    user.friendRequests = user.friendRequests.filter(
      (id) => id.toString() !== friendId
    );
    user.friends.push(friendId);
    friend.friends.push(userId);

    // Lưu thay đổi đồng thời
    await Promise.all([user.save(), friend.save()]);

    // Tạo cuộc trò chuyện mới
    const conversation = new Conversation({
      type: "private",
      participants: [
        { user: userId, role: "member" },
        { user: friendId, role: "member" },
      ],
      createdBy: userId,
      unreadCount: new Map(),
      createdAt: new Date(),
    });

    await conversation.save();

    // Chuẩn bị dữ liệu thông báo
    const conversationSenderData = {
      conversationId: conversation._id.toString(),
      type: "private",
      name: friend.username, // Tên hiển thị cho user
      avatarUrl: friend.avatar || "",
      lastMessage: {
        messageId: "",
        content: "Bắt đầu cuộc trò chuyện",
        timestamp: new Date().toISOString(),
      },
      unreadCount: 0,
      isMuted: false,
      isArchived: false,
    };

    const conversationReceiverData = {
      ...conversationSenderData,
      name: user.username,
      avatarUrl: user.avatar || "",
    };

    // Gửi thông báo qua Redis cho WebSocket tới cả hai user
    try {
      await redisClient.publish(
        "friend_request_accepted",
        JSON.stringify({
          senderId: userId, // Người chấp nhận
          receiverId: friendId, // Người gửi lời mời ban đầu
          conversationSenderData,
          conversationReceiverData,
        })
      );      
    } catch (error) {
      console.error("Redis publish error:", error);
    }

    // Gửi thông báo đẩy FCM cho friend
    let pushStatus = "no_tokens";
    if (friend.fcmTokens?.length > 0) {
      try {
        const message = {
          tokens: friend.fcmTokens.map((t) => t.token),
          notification: {
            title: "Lời mời kết bạn được chấp nhận!",
            body: `${user.username} đã chấp nhận lời mời kết bạn của bạn.`,
          },
          data: {
            type: "FRIEND_REQUEST_ACCEPTED",
            senderId: userId.toString(),
            receiverId: friendId.toString(),
            conversationId: conversation._id.toString(),
            click_action: "FLUTTER_NOTIFICATION_CLICK",
          },
          apns: {
            payload: {
              aps: {
                sound: "default",
              },
            },
          },
          android: {
            priority: "high",
          },
        };

        const response = await admin.messaging().sendEachForMulticast(message);
        const successCount = response.successCount;
        const failureCount = response.failureCount;

        // Xóa token không hợp lệ
        if (failureCount > 0) {
          const failedTokens = [];
          response.responses.forEach((resp, idx) => {
            if (!resp.success && resp.error?.code === "messaging/registration-token-not-registered") {
              failedTokens.push(friend.fcmTokens[idx].token);
            }
          });
          friend.fcmTokens = friend.fcmTokens.filter(
            (t) => !failedTokens.includes(t.token)
          );
          await friend.save();
        }

        pushStatus = successCount > 0 ? "sent" : "failed";
        console.log(
          `FCM to ${friendId}: ${successCount} success, ${failureCount} failed`
        );
      } catch (error) {
        console.error("FCM push error:", error);
        pushStatus = "failed";
      }
    } else {
      console.log(`No FCM tokens found for friend: ${friendId}`);
    }

    // Trả về response
    return {
      message: "Đã chấp nhận lời mời kết bạn thành công",
      conversationId: conversation._id.toString(),
      deliveryStatus: {
        push: pushStatus,
      },
    };
  }
  
  // Reject friend request
  static async rejectFriendRequest(userId, friendId) {
    const [user, friend] = await Promise.all([  
      User.findById(userId),
      User.findById(friendId),
    ]);
    if (!user || !friend) throw { message: "Không tìm thấy người dùng" };

    if (!user.friendRequests.includes(friendId)) {
      throw { message: "Không tìm thấy lời mời kết bạn" };
    }

    // Remove friend request
    user.friendRequests = user.friendRequests.filter(
      (id) => id.toString() !== friendId
    );
    await user.save();
  }
  
  // Remove friend
  static async removeFriend(userId, friendId) {
    const [user, friend] = await Promise.all([
      User.findById(userId),
      User.findById(friendId),
    ]);

    if (!user || !friend) throw { message: "Không tìm thấy người dùng" };

    if (!user.friends.includes(friendId)) {
      throw { message: "Các bạn chưa phải là bạn bè" };
    }

    if (user.friends.includes(userId)) {
      throw { message: "Bạn không thể xóa chính mình" };
    }

    // remove friend from both users
    user.friends = user.friends.filter((id) => id.toString() !== friendId.toString());
    friend.friends = friend.friends.filter((id) => id.toString() !== userId.toString());
    
    await Promise.all([user.save(), friend.save()]);
  }

  // Forgot password
  static async forgotPassword(email) {
    const user = await User.findOne({ email });
    if (!user) throw { message: "Email không tồn tại" };
    const token = jwt.sign(
      { email: user.email },
      process.env.JWT_SECRET,
      { expiresIn: '15m' }
    );
    // Link này sẽ đưa người dùng đến trang đặt lại mật khẩu có token
    const resetLink = `http://localhost:3000/api/auth/reset-password?token=${token}`;
    await sendEmail(user.email, 'Khôi phục mật khẩu', `Đặt lại mật khẩu tại đây: ${resetLink}`);
    return { message: "Email đã được gửi đến người dùng" };
  }

  // Reset password
  static async resetPassword(token, newPassword, confirmPassword) {
    if (newPassword !== confirmPassword) throw { message: "Mật khẩu không khớp" };
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findOne({ email: decoded.email });
    if (!user) throw { message: "Email không tồn tại" };
    user.password = newPassword;
    await user.save();
    return { message: "Mật khẩu đã được đặt lại" };
  }

}

module.exports = UserService;
