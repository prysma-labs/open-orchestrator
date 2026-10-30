#!/bin/sh
set -eu
arch=$(uname -m)
case "$arch" in
  x86_64) nodearch=x64 ;;
  aarch64) nodearch=arm64 ;;
  *) echo "unsupported architecture: $arch" >&2; exit 1 ;;
esac
ver=v22.21.0
curl -fsSL "https://nodejs.org/dist/${ver}/node-${ver}-linux-${nodearch}.tar.xz" -o /tmp/node.tar.xz
sudo tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1
sudo ln -sfn /usr/local/bin/node /usr/bin/node
sudo ln -sfn /usr/local/bin/npm /usr/bin/npm
sudo ln -sfn /usr/local/bin/npx /usr/bin/npx
sudo mkdir -p /opt/research-agent
sudo chown "$(id -u)":"$(id -g)" /opt/research-agent
node -v
