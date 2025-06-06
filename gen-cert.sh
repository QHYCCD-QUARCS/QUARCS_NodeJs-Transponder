#!/bin/bash

# 创建certs目录
mkdir -p certs

# 生成自签名证书
openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
    -keyout certs/server.key -out certs/server.crt \
    -subj "/C=CN/ST=State/L=City/O=Organization/CN=localhost"

# 设置证书权限
chmod 600 certs/server.key
chmod 644 certs/server.crt

echo "SSL certificates generated successfully!" 