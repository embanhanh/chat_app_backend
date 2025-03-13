require("dotenv").config();
const Redis = require("redis");

const redisClient = Redis.createClient({
  host: process.env.REDIS_HOST,
  port: process.env.REDIS_PORT,
});

redisClient.on("error", (err) => {
  console.error("Redis Client Error:", err);
});

redisClient.on("connect", () => {
  console.log("Redis Client Connected");
});

const connectRedis = async () => {
  try {
    await redisClient.connect();
  } catch (error) {
    console.error(`Redis Connection Error: ${error.message}`);
    process.exit(1);
  }
};

module.exports = {
  redisClient,
  connectRedis,
};
