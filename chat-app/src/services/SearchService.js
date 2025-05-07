const { redisClient } = require("../config/redis");
const Message = require("../models/Message");
const Conversation = require("../models/Conversation");
const User = require("../models/User");

class SearchService {
  constructor() {
    this.messageCacheKey = "search:messages:";
    this.conversationCacheKey = "search:conversations:";
    this.friendCacheKey = "search:friends:";
    this.cacheTTL = 3600; // 1 giờ
  }

  // Hàm chuẩn hóa chuỗi không dấu
  removeAccents(str) {
    if (!str) return '';
    return str.normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/đ/g, 'd').replace(/Đ/g, 'D');
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

  // Tìm kiếm bạn bè
  async searchFriends(userId, query) {
    try {
      console.log("Searching friends for user:", userId, "with query:", query);
      
      if (!userId || !query) {
        throw new Error("Thiếu thông tin userId hoặc query");
      }

      const cacheKey = `${this.friendCacheKey}${userId}:${query}`;

      // Kiểm tra cache
      const cachedResult = await redisClient.get(cacheKey);
      if (cachedResult) {
        console.log("Found cached result for:", cacheKey);
        return JSON.parse(cachedResult);
      }

      const normalizedQuery = this.removeAccents(query);
      const regexQuery = new RegExp(normalizedQuery, 'i');

      console.log("Querying database for friends...");
      const user = await User.findById(userId).populate({
        path: 'friends',
        match: {
          $or: [
            { username: regexQuery },
            { email: regexQuery }
          ]
        },
        select: 'username email avatar status lastSeen'
      });

      if (!user) {
        console.error("User not found:", userId);
        throw new Error("Không tìm thấy người dùng");
      }

      console.log("Found user with friends:", user.friends.length);

      // Sắp xếp kết quả theo độ phù hợp
      const results = user.friends.map(friend => {
        const score = this.calculateUsernameMatchScore(friend, normalizedQuery);
        return { ...friend.toObject(), score };
      }).sort((a, b) => b.score - a.score);

      console.log("Search results:", results.length);

      // Lưu vào cache
      await redisClient.set(cacheKey, JSON.stringify(results), {
        EX: this.cacheTTL,
      });

      return results;
    } catch (error) {
      console.error("Search friends error:", error);
      throw {
        message: error.message || "Lỗi khi tìm kiếm bạn bè",
        error: error
      };
    }
  }

  // Tính điểm phù hợp của kết quả tìm kiếm theo username
  calculateUsernameMatchScore(friend, query) {
    let score = 0;
    const normalizedQuery = query.toLowerCase();
    const firstLetter = normalizedQuery[0];
    
    if (friend.username) {
      const normalizedUsername = this.removeAccents(friend.username).toLowerCase();
      const usernameWords = normalizedUsername.split(' ');
      
      // Kiểm tra từng từ trong username
      for (const word of usernameWords) {
        // Nếu từ bắt đầu bằng chữ cái đầu tiên của từ khóa
        if (word.startsWith(firstLetter)) {
          // Nếu từ khóa chỉ có 1 ký tự
          if (normalizedQuery.length === 1) {
            score += 100;
          }
          // Nếu từ bắt đầu bằng từ khóa
          else if (word.startsWith(normalizedQuery)) {
            score += 90;
          }
          // Nếu từ chứa từ khóa
          else if (word.includes(normalizedQuery)) {
            score += 70;
          }
          // Nếu từ bắt đầu bằng chữ cái đầu tiên của từ khóa
          else {
            score += 50;
          }
        }
        // Nếu từ chứa từ khóa nhưng không bắt đầu bằng chữ cái đầu tiên
        else if (word.includes(normalizedQuery)) {
          score += 30;
        }
      }

      // Thêm điểm cho kết quả khớp chính xác
      if (normalizedUsername === normalizedQuery) {
        score += 100;
      }
    }

    return score;
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
