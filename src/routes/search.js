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

    console.log(searchResults);

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

    console.log(searchResults);

    res.json(searchResults);
  } catch (error) {
    console.log(error);
    res.status(500).json({ message: "Lỗi khi tìm kiếm cuộc hội thoại" });
  }
});

module.exports = router;
