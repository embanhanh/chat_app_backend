const express = require("express");
const router = express.Router();
const UserService = require("../services/UserService");


// Register
// [POST] api/auth/register
router.post("/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const result = await UserService.register({ username, email, password });
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Login
// [POST] api/auth/login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await UserService.login(email, password);
    res.json(result);
  } catch (error) {
    res.status(401).json({ message: error.message });
  }
});

// Send fcm token
// [POST] api/auth/fcm-token
router.post("/fcm-token", async (req, res) => {
  try {
    const { token, device } = req.body;
    const result = await UserService.pushFCMToken(req.user._id, token, device);
    res.json(result);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Delete fcm token
// [DELETE] api/auth/fcm-token
router.delete("/fcm-token", async (req, res) => {
  try {
    const { token, device } = req.body;
    const result = await UserService.deleteFCMToken(req.user._id, token, device);
    res.json(result);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Forgot password
// [POST] api/auth/forgot-password
router.post("/forgot-password", async (req, res) => {
  try {
    const { email } = req.body;
    console.log(req.body);
    const result = await UserService.forgotPassword(email);
    res.json(result);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

// Reset password
// [POST] api/auth/reset-password
router.post("/reset-password", async (req, res) => {
  try {
    const { token, newPassword, confirmPassword } = req.body;
    const result = await UserService.resetPassword(token, newPassword, confirmPassword);
    res.json(result);
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
});

module.exports = router;
