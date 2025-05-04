#!/bin/sh
echo "Waiting for Redis nodes to start..."
sleep 10

echo "Creating Redis cluster..."
redis-cli --cluster create redis1:6379 redis2:6379 redis3:6379 redis4:6379 redis5:6379 redis6:6379 --cluster-replicas 0 --cluster-yes

echo "Redis cluster created."