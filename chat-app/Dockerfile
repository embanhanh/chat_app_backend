# Sử dụng hình ảnh Node.js chính thức
FROM node:18-alpine

# Thiết lập thư mục làm việc trong container
WORKDIR /src

# Sao chép tệp package.json và package-lock.json vào container
COPY package*.json ./

# Cài đặt các dependencies
RUN npm install

# Sao chép toàn bộ mã nguồn vào container
COPY . .

# Mở cổng 5000 (hoặc cổng bạn sử dụng trong ứng dụng)
EXPOSE 5000

# Lệnh khởi chạy server
CMD ["npm", "run", "dev"]