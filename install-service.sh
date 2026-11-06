#!/usr/bin/env bash
# Installs deps, builds Notebox and registers it as a systemd service that starts on boot.
# Usage: sudo ./install-service.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
    echo "Run with sudo: sudo $0" >&2
    exit 1
fi

APP_USER="${SUDO_USER:-sauron00}"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> Checking build dependencies"
missing=()
for pkg in libsqlite3-dev nlohmann-json3-dev cmake g++; do
    dpkg-query -W -f='${Status}' "$pkg" 2>/dev/null | grep -q "install ok installed" || missing+=("$pkg")
done
if ((${#missing[@]})); then
    echo "Installing: ${missing[*]}"
    apt-get install -y "${missing[@]}"
else
    echo "All dependencies already installed"
fi

echo "==> Building as $APP_USER"
sudo -u "$APP_USER" cmake -S "$APP_DIR" -B "$APP_DIR/build"
sudo -u "$APP_USER" cmake --build "$APP_DIR/build" -j"$(nproc)"
sudo -u "$APP_USER" mkdir -p "$APP_DIR/data"

echo "==> Writing /etc/systemd/system/notebox.service"
cat > /etc/systemd/system/notebox.service <<EOF
[Unit]
Description=Notebox (notes web app)
After=network.target

[Service]
Type=simple
User=$APP_USER
Group=$APP_USER
WorkingDirectory=$APP_DIR
Environment=NOTEBOX_HOST=127.0.0.1
Environment=NOTEBOX_PORT=8080
Environment=NOTEBOX_DATA=$APP_DIR/data
Environment=NOTEBOX_WEB=$APP_DIR/web
ExecStart=$APP_DIR/build/notebox
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF

echo "==> Enabling and starting service"
systemctl daemon-reload
systemctl enable --now notebox
systemctl restart notebox

echo "==> Ensuring Tailscale Serve (https :8447 -> 127.0.0.1:8080)"
tailscale serve --bg --https=8447 http://127.0.0.1:8080 >/dev/null

sleep 1
systemctl --no-pager --lines=5 status notebox || true
echo
echo "Done: https://$(tailscale status --json | sed -n 's/.*"DNSName": *"\([^"]*\)\.".*/\1/p' | head -1):8447"
