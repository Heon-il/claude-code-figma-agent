#!/bin/bash
# Talk to Figma MCP - WebSocket 서버 실행 스크립트
# SSL 환경변수 없이 실행하면 ws:// (plain) 모드로 동작

cd "$(dirname "$0")"

if [ "$1" = "--ssl" ]; then
  if [ ! -f key.pem ] || [ ! -f cert.pem ]; then
    echo "SSL 인증서가 없습니다. 자동 생성 중..."
    openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 365 -nodes -subj '/CN=localhost' 2>/dev/null
    echo "SSL 인증서 생성 완료 (key.pem, cert.pem)"
  fi
  echo "WebSocket 서버 시작 (wss://localhost:3055)..."
  SSL_KEY_PATH=key.pem SSL_CERT_PATH=cert.pem bun socket
else
  echo "WebSocket 서버 시작 (ws://localhost:3055)..."
  bun socket
fi
