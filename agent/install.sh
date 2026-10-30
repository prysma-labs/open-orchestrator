#!/bin/sh
set -eu
cd /opt/research-agent
npm ci
npx tsc
install_unit() {
  cp research-agent.service /etc/systemd/system/research-agent.service
  systemctl daemon-reload
  systemctl enable research-agent
  systemctl restart research-agent
}
if [ "$(id -u)" -eq 0 ]; then
  install_unit
else
  sudo sh -c 'cp /opt/research-agent/research-agent.service /etc/systemd/system/research-agent.service && systemctl daemon-reload && systemctl enable research-agent && systemctl restart research-agent'
fi
