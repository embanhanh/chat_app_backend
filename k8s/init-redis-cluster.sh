#!/bin/bash
# Create a temporary config file for redis-cli
cat > /tmp/redis-cli.conf << EOF
cluster-announce-ip 127.0.0.1
EOF

# Get all Redis node IPs
echo "Getting Redis nodes..."
nodes=""
for i in $(seq 0 5); do
  ip=$(nslookup redis-cluster-$i.redis-cluster-headless 2>/dev/null | grep -A2 Name | grep Address | awk '{print $2}')
  if [ -n "$ip" ]; then
    nodes="$nodes $ip:6379"
  fi
done

echo "Creating cluster with nodes: $nodes"
# Create the Redis cluster
redis-cli --cluster create $nodes --cluster-replicas 1 --cluster-yes
