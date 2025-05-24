require("dotenv").config();
const Redis = require("ioredis");

// Khởi kết nối tới Redis Cluster sử dụng ioredis
const redisCluster = new Redis.Cluster(
  [
    {
      host:
        process.env.REDIS_HOST_1 || "redis-cluster-0.redis-cluster-headless",
      port: Number(process.env.REDIS_PORT_1) || 6379,
    },
    {
      host:
        process.env.REDIS_HOST_2 || "redis-cluster-1.redis-cluster-headless",
      port: Number(process.env.REDIS_PORT_2) || 6379,
    },
    {
      host:
        process.env.REDIS_HOST_3 || "redis-cluster-2.redis-cluster-headless",
      port: Number(process.env.REDIS_PORT_3) || 6379,
    },
    {
      host:
        process.env.REDIS_HOST_4 || "redis-cluster-3.redis-cluster-headless",
      port: Number(process.env.REDIS_PORT_4) || 6379,
    },
    {
      host:
        process.env.REDIS_HOST_5 || "redis-cluster-4.redis-cluster-headless",
      port: Number(process.env.REDIS_PORT_5) || 6379,
    },
    {
      host:
        process.env.REDIS_HOST_6 || "redis-cluster-5.redis-cluster-headless",
      port: Number(process.env.REDIS_PORT_6) || 6379,
    },
  ],
  {
    redisOptions: {
      enableReadyCheck: true,
      maxRetriesPerRequest: 3,
      retryStrategy: function (times) {
        const delay = Math.min(times * 100, 3000);
        return delay;
      },
      reconnectOnError: function (err) {
        const targetError = "READONLY";
        if (err.message.includes(targetError)) {
          return true;
        }
        return false;
      },
    },
    scaleReads: "slave",
    enableOfflineQueue: true,
    showFriendlyErrorStack: true,
    slotsRefreshTimeout: 20000,
    dnsLookup: (address, callback) => callback(null, address),
    clusterRetryStrategy: function (times) {
      const delay = Math.min(times * 100, 3000);
      return delay;
    },
  }
);

console.log("Redis Cluster Config:", redisCluster);

redisCluster.on("error", (err) => {
  console.error("ioredis Cluster Error:", err);
});

redisCluster.on("connect", () => {
  console.log("ioredis Cluster Connected");
});

// Khởi tạo standalone client để dùng cho Pub/Sub hoặc debug nhanh
// Thay đổi cấu hình Redis standalone client để kết nối với container Redis
const redisClient = new Redis({
  host: process.env.REDIS_HOST_1 || "redis1", // Sử dụng tên container thay vì localhost
  port: Number(process.env.REDIS_PORT_1) || 6379,
  retryStrategy: function (times) {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
});

console.log("Attempting to connect to Redis...");
redisClient.on("connect", () => console.log("✅ioredis Client Connected"));
redisClient.on("error", (err) => {
  console.error("Redis Client Error:", err);
  if (err.code === "ECONNREFUSED") {
    console.error(
      "Cannot connect to Redis. Please check if Redis container is running and accessible."
    );
  }
});
redisClient.on("ready", () => console.log("Redis Client Ready"));

module.exports = { redisCluster, redisClient };
