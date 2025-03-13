const express = require("express");
const router = express.Router();
const UserService = require("../services/UserService");

// Register
router.post("/register", async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const result = await UserService.register({ username, email, password });
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// Login
router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await UserService.login(email, password);
    res.json(result);
  } catch (error) {
    res.status(401).json({ error: error.message });
  }
});

module.exports = router;
