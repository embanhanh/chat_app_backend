cd "C:\React\chat_app_backend\k8s"

# build image
minikube -p minikube docker-env | Invoke-Expression

docker build -t api-gateway:latest C:/React/chat_app_backend/api-gateway
docker build -t chat-app-backend:latest C:/React/chat_app_backend/chat-app

# Áp dụng ConfigMaps
kubectl apply -f redis-configmap.yaml
kubectl apply -f chat-app-configmap.yaml
kubectl apply -f api-gateway-configmap.yaml
kubectl apply -f mongo-secret.yaml

# Áp dụng Redis Cluster
kubectl apply -f redis-service.yaml
kubectl apply -f redis-statefulset.yaml

# Đợi Redis khởi động
echo "\nWaiting for Redis to start...\n"
kubectl wait --for=condition=ready pod/redis-0 --timeout=180s

# Áp dụng Kafka
kubectl apply -f kafka.yaml
kubectl apply -f kafka-service.yaml

# Áp dụng Chat App Backend
kubectl apply -f chat-app-deployment.yaml
kubectl apply -f chat-app-service.yaml

# Áp dụng HPA cho Chat App
kubectl apply -f chat-app-hpa.yaml

# Áp dụng API Gateway
kubectl apply -f api-gateway-deployment.yaml
kubectl apply -f api-gateway-service.yaml

# Áp dụng Ingress
kubectl apply -f ingress.yaml

echo "Done!"