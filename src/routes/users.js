require("dotenv").config();
const express = require("express");
const router = express.Router();
const auth = require("../middlewares/auth");
const upload = require("../middlewares/upload");
const UserService = require("../services/UserService");
const s3 = require("../config/s3");
const { PutObjectCommand } = require("@aws-sdk/client-s3");
const User = require("../models/User");

// Search users
router.get("/search", auth, async (req, res) => {
  try {
    const { query } = req.query;
    const users = await UserService.searchUsers(query, req.user._id);
    res.json(users);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update FCM token
router.post("/fcm-token", auth, async (req, res) => {
  try {
    const { token, device } = req.body;
    await UserService.updateFCMToken(req.user._id, token, device);
    res.json({ message: "FCM token updated" });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Update avatar
router.post("/avatar", auth, upload.single("avatar"), async (req, res) => {
  try {
    const file = req.file;
    const key = `avatars/${req.user._id}-${Date.now()}.${
      file.mimetype.split("/")[1]
    }`;

    const uploadParams = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype,
      ACL: "public-read",
    };

    const command = new PutObjectCommand(uploadParams);
    const result = await s3.send(command);

    await User.findByIdAndUpdate(req.user._id, {
      avatar: `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`,
    });

    res.json({
      avatar: `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`,
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Send friend request
router.post("/friend-request/:id", auth, async (req, res) => {
  try {
    await UserService.sendFriendRequest(req.user._id, req.params.id);
    res.json({ message: "Friend request sent" }); 
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Accept friend request
router.post("/friend-request/:id/accept", auth, async (req, res) => {
  try {
    const result = await UserService.acceptFriendRequest(req.user._id, req.params.id);
    
    res.json({ 
      message: "Friend request accepted",
      conversationId: result.conversationId
    });
  } catch (error) {
    console.error("Error accepting friend request:", error);
    res.status(400).json({ message: error.message });
  }
});

// Reject friend request
router.post("/friend-request/:id/reject", auth, async (req, res) => {
  try {
    await UserService.rejectFriendRequest(req.user._id, req.params.id);
    res.json({ message: "Friend request rejected" });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Remove friend
router.post("/friend/:id/remove", auth, async (req, res) => {
  try {
    await UserService.removeFriend(req.user._id, req.params.id);
    res.json({ message: "Friend removed successfully" });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Get user's friends
router.get("/friends", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .populate("friends", "username avatar status")
      .select("friends");
    res.json(user.friends);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Get user's friend requests
router.get("/friend-requests", auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .populate("friendRequests", "username avatar")
      .select("friendRequests");
    res.json(user.friendRequests);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Remove friend
router.delete("/friends/:id", auth, async (req, res) => {
  try {
    const result = await UserService.removeFriend(req.user._id, req.params.id);
    res.json(result);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Get user's info
router.get("/info", auth, async (req, res) => {
  try {
    const user = await UserService.getUserInfo(req.user._id);
    res.json(user);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});
   

// Get user's friends
router.get("/friends", auth, async (req, res) => {
  try {
    const user = await UserService.getUserFriends(req.user._id);
    res.json(user);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Get user's friend requests
router.get("/friend-requests", auth, async (req, res) => {
  try {
    const user = await UserService.getUserFriendRequests(req.user._id);
    res.json(user);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});


module.exports = router;
