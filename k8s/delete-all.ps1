cd "C:\React\chat_app_backend\k8s"

# Xóa ConfigMaps
kubectl delete -f redis-configmap.yaml
kubectl delete -f chat-app-configmap.yaml
kubectl delete -f api-gateway-configmap.yaml

# Xóa Redis Cluster
kubectl delete -f redis-service.yaml
kubectl delete -f redis-statefulset.yaml

# Xóa Kafka
kubectl delete -f kafka.yaml
kubectl delete -f kafka-service.yaml

# Xóa Chat App Backend
kubectl delete -f chat-app-deployment.yaml
kubectl delete -f chat-app-service.yaml

# Xóa HPA cho Chat App
kubectl delete -f chat-app-hpa.yaml

# Xóa API Gateway
kubectl delete -f api-gateway-deployment.yaml
kubectl delete -f api-gateway-service.yaml

# Xóa Ingress
kubectl delete -f ingress.yaml
