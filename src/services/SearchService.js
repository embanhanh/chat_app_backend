const { redisClient } = require("../config/redis");
const Message = require("../models/Message");
const Conversation = require("../models/Conversation");
const User = require("../models/User");

class SearchService {
  constructor() {
    this.messageCacheKey = "search:messages:";
    this.conversationCacheKey = "search:conversations:";
    this.cacheTTL = 3600; // 1 giờ
  }

  // Tìm kiếm conversation và người dùng
  async searchConversation(query, userId, options = {}) {
    try {
      const { page = 1, limit = 20 } = options;
      const cacheKey = `${this.conversationCacheKey}${query}:${userId}:${page}:${limit}`;

      // Kiểm tra cache
      const cachedResult = await redisClient.get(cacheKey);
      if (cachedResult) {
        return JSON.parse(cachedResult);
      }

      // Tạo đối tượng regex với cờ "i" để tìm kiếm không phân biệt chữ hoa/thường
      const regexQuery = new RegExp(query, "i");

      // Tìm kiếm conversations
      const conversationQuery = {
        $or: [{ name: regexQuery }],
        "participants.user": userId,
      };

      const [conversations, conversationTotal] = await Promise.all([
        Conversation.find(conversationQuery)
          .populate("participants.user", "username avatar status")
          .populate("lastMessage")
          .sort({ updatedAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit),
        Conversation.countDocuments(conversationQuery),
      ]);

      // Tìm kiếm users
      const userQuery = {
        $and: [
          { _id: { $ne: userId } },
          {
            $or: [{ username: regexQuery }, { email: regexQuery }],
          },
        ],
      };

      const [users, userTotal] = await Promise.all([
        User.find(userQuery)
          .select("username avatar status email lastSeen")
          .sort({ lastSeen: -1 })
          .skip((page - 1) * limit)
          .limit(limit),
        User.countDocuments(userQuery),
      ]);

      const result = {
        conversations,
        users,
        conversationTotal,
        userTotal,
        page,
        limit,
      };

      // Lưu vào cache
      await redisClient.set(cacheKey, JSON.stringify(result), {
        EX: this.cacheTTL,
      });

      return result;
    } catch (error) {
      throw {
        message: "Lỗi khi tìm kiếm conversation",
        error: error,
      };
    }
  }

  // Tìm kiếm tin nhắn trong conversation
  async searchMessagesInConversation(query, conversationId, options = {}) {
    try {
      const { page = 1, limit = 20, startDate, endDate } = options;
      const cacheKey = `${this.messageCacheKey}${query}:${conversationId}:${page}:${limit}`;

      // Kiểm tra cache
      const cachedResult = await redisClient.get(cacheKey);
      if (cachedResult) {
        return JSON.parse(cachedResult);
      }

      // Tạo đối tượng regex với cờ "i"
      const regexQuery = new RegExp(query, "i");

      // Tìm kiếm trong MongoDB
      const searchQuery = {
        conversation: conversationId,
        content: regexQuery,
      };

      if (startDate) {
        searchQuery.createdAt = {
          ...searchQuery.createdAt,
          $gte: new Date(startDate),
        };
      }

      if (endDate) {
        searchQuery.createdAt = {
          ...searchQuery.createdAt,
          $lte: new Date(endDate),
        };
      }

      const [messages, total] = await Promise.all([
        Message.find(searchQuery)
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .populate("sender", "username avatar"),
        Message.countDocuments(searchQuery),
      ]);

      const result = {
        messages,
        total,
        page,
        limit,
      };

      // Lưu vào cache
      await redisClient.set(cacheKey, JSON.stringify(result), {
        EX: this.cacheTTL,
      });

      return result;
    } catch (error) {
      throw {
        message: "Lỗi khi tìm kiếm tin nhắn",
      };
    }
  }

  // Xóa cache khi có thay đổi
  async invalidateCache(type, query) {
    try {
      const pattern = `${this[`${type}CacheKey`]}${query}:*`;
      const keys = await redisClient.keys(pattern);
      if (keys.length > 0) {
        await redisClient.del(keys);
      }
    } catch (error) {
      console.error(`Error invalidating ${type} cache:`, error);
    }
  }
}

module.exports = new SearchService();
