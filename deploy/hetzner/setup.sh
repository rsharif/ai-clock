#!/bin/sh
# One-time setup for a fresh Hetzner CX22 (Ubuntu 24.04, Ashburn). Run as root:
#   curl -fsSL <raw-url>/setup.sh | sh
# or copy this file up and run:  sh setup.sh
set -eu

apt-get update -qq
apt-get install -y -qq docker.io docker-compose-plugin ufw >/dev/null

systemctl enable --now docker

# Firewall: SSH + HTTP/S only. go2rtc stays on the private compose network.
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

mkdir -p /opt/aiclock-cam
cd /opt/aiclock-cam

if [ ! -f .env ]; then
  printf 'RING_REFRESH_TOKEN=\n' > .env
  chmod 600 .env
fi

echo "done. Next:"
echo "  1. copy docker-compose.yml, Caddyfile, go2rtc.yaml into /opt/aiclock-cam"
echo "  2. edit Caddyfile (your hostname) and go2rtc.yaml (camera_id/device_id)"
echo "  3. put the Ring refresh token in /opt/aiclock-cam/.env"
echo "  4. docker compose up -d"
