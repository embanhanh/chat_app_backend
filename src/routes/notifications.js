const express = require("express");
const router = express.Router();
const NotificationService = require("../services/NotificationService");
const auth = require("../middlewares/auth");
const UserService = require("../services/UserService");

// Đăng ký device token
router.post("/register-device", auth, async (req, res) => {
  try {
    const { deviceToken, device } = req.body;

    if (!deviceToken) {
      return res
        .status(400)
        .json({ message: "Vui lòng cung cấp device token" });
    }

    // Đăng ký device token cho user
    await UserService.updateFCMToken(req.user._id, deviceToken, device);

    // Đăng ký device token cho các topic cần thiết
    await NotificationService.subscribeToTopic(
      deviceToken,
      `user_${req.user._id}`
    );

    res.json({ message: "Đăng ký device token thành công" });
  } catch (error) {
    console.error("Error registering device token:", error.message);
    res.status(500).json({ message: "Lỗi khi đăng ký device token" });
  }
});

// Hủy đăng ký device token
router.post("/unregister-device", auth, async (req, res) => {
  try {
    const { deviceToken } = req.body;

    if (!deviceToken) {
      return res
        .status(400)
        .json({ message: "Vui lòng cung cấp device token" });
    }

    // Xóa device token khỏi user
    await UserService.updateFCMToken(req.user._id, deviceToken, "web");

    // Hủy đăng ký device token khỏi các topic
    await NotificationService.unsubscribeFromTopic(
      deviceToken,
      `user_${req.user._id}`
    );

    res.json({ message: "Hủy đăng ký device token thành công" });
  } catch (error) {
    console.error("Error unregistering device token:", error);
    res.status(500).json({ message: "Lỗi khi hủy đăng ký device token" });
  }
});

// Gửi test notification
router.post("/test", auth, async (req, res) => {
  try {
    const { title, body } = req.body;

    if (!title || !body) {
      return res
        .status(400)
        .json({ message: "Vui lòng cung cấp title và body" });
    }

    const user = await UserService.getUserById(req.user._id);
    if (!user.deviceToken) {
      return res
        .status(400)
        .json({ message: "Người dùng chưa đăng ký device token" });
    }

    const result = await NotificationService.sendToDevice(
      user.deviceToken,
      title,
      body
    );

    if (result.success) {
      res.json({ message: "Gửi test notification thành công" });
    } else {
      res.status(500).json({ message: "Lỗi khi gửi test notification" });
    }
  } catch (error) {
    console.error("Error sending test notification:", error);
    res.status(500).json({ message: "Lỗi khi gửi test notification" });
  }
});

module.exports = router;
