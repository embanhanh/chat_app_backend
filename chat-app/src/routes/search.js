const express = require("express");
const router = express.Router();
const SearchService = require("../services/SearchService");
const auth = require("../middlewares/auth");

// Tìm kiếm tin nhắn
// [GET] api/search/messages
router.get("/messages", auth, async (req, res) => {
  try {
    const { query, conversationId, page, limit, startDate, endDate } =
      req.query;

    if (!query) {
      return res
        .status(400)
        .json({ message: "Vui lòng nhập từ khóa tìm kiếm" });
    }

    const searchResults = await SearchService.searchMessagesInConversation(
      query,
      conversationId,
      {
        page: parseInt(page) || 1,
        limit: parseInt(limit) || 20,
        startDate,
        endDate,
        userId: req.user._id,
      }
    );

    res.json(searchResults);
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "Lỗi khi tìm kiếm tin nhắn" });
  }
});

// Tìm kiếm cuộc hội thoại
// [GET] api/search/conversations
router.get("/conversations", auth, async (req, res) => {
  try {
    const { query, page, limit } = req.query;

    if (!query) {
      return res
        .status(400)
        .json({ message: "Vui lòng nhập từ khóa tìm kiếm" });
    }

    const searchResults = await SearchService.searchConversation(
      query,
      req.user._id,
      {
        page: parseInt(page) || 1,
        limit: parseInt(limit) || 20,
      }
    );

    res.json(searchResults);
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "Lỗi khi tìm kiếm cuộc hội thoại" });
  }
});

// Tìm kiếm bạn bè
// [GET] api/search/friends
router.get("/friends", auth, async (req, res) => {
  try {
    const { query } = req.query;
    if (!query) {
      return res.status(400).json({ message: "Vui lòng nhập từ khóa tìm kiếm" });
    }

    if (!req.user._id) {
      return res.status(400).json({ message: "Không tìm thấy thông tin người dùng" });
    }

    const friends = await SearchService.searchFriends(req.user._id, query);
    res.json(friends);
  } catch (error) {
    console.error("Search friends error:", error);
    res.status(500).json({ 
      message: error.message || "Lỗi khi tìm kiếm bạn bè",
      error: error.error || error
    });
  }
});

module.exports = router;
