const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");
const ConversationService = require("../services/ConversationService");

// Get user's conversations
router.get("/", auth, async (req, res) => {
  try {
    const conversations = await ConversationService.getUserConversations(
      req.user._id
    );
    res.json(conversations);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Create private conversation
router.post("/private/:userId", auth, async (req, res) => {
  try {
    const conversation = await ConversationService.createPrivateConversation(
      req.user._id,
      req.params.userId
    );
    res.status(201).json(conversation);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Create group conversation
router.post("/group", auth, async (req, res) => {
  try {
    const { name, participants } = req.body;
    const conversation = await ConversationService.createGroupConversation(
      name,
      req.user._id,
      participants
    );
    res.status(201).json(conversation);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Add participant to group
router.post("/:id/participants", auth, async (req, res) => {
  try {
    const { userId } = req.body;
    await ConversationService.addParticipant(
      req.params.id,
      req.user._id,
      userId
    );
    res.json({ message: "Participant added successfully" });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Remove participant from group
router.delete("/:id/participants/:userId", auth, async (req, res) => {
  try {
    await ConversationService.removeParticipant(
      req.params.id,
      req.user._id,
      req.params.userId
    );
    res.json({ message: "Participant removed successfully" });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Leave conversation
router.post("/:id/leave", auth, async (req, res) => {
  try {
    await ConversationService.leaveConversation(req.params.id, req.user._id);
    res.json({ message: "Left conversation successfully" });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

module.exports = router;
