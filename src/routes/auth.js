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

module.exports = router;
