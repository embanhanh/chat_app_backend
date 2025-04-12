require("dotenv").config();
const User = require("../models/User");
const jwt = require("jsonwebtoken");
const { redisClient } = require("../config/redis");

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

  // Send friend request
  static async sendFriendRequest(senderId, receiverId) {
    const [sender, receiver] = await Promise.all([
      User.findById(senderId),
      User.findById(receiverId),
    ]);

    if (sender._id.equals(receiver._id)) {
      throw { message: "Không thể gửi lời mời kết bạn cho chính mình" };
    }

    if (!sender || !receiver) {
      throw { message: "Không tìm thấy người dùng" };
    }

    if (receiver.friendRequests.includes(senderId)) {          
      throw { message: "Đã gửi lời mời kết bạn trước đó" };
    }

    if (receiver.friends.includes(senderId)) {
      throw { message: "Các người dùng đã là bạn bè" };
    }

    receiver.friendRequests.push(senderId);
    await receiver.save();
  }

  // Accept friend request
  static async acceptFriendRequest(userId, friendId) {
    const [user, friend] = await Promise.all([
      User.findById(userId),
      User.findById(friendId),
    ]);

    if (!user || !friend) {
      throw { message: "Không tìm thấy người dùng" };
    }

    if (!user.friendRequests.includes(friendId)) {
      throw { message: "Không tìm thấy lời mời kết bạn" };
    }

    // Remove friend request and add to friends list for both users
    user.friendRequests = user.friendRequests.filter(
      (id) => id.toString() !== friendId
    );
    user.friends.push(friendId);
    friend.friends.push(userId);

    await Promise.all([user.save(), friend.save()]);
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

  
}

module.exports = UserService;
