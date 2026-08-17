#!/bin/bash
# NEXUS — inicia o servidor no Linux
cd /home/fabiorjvr/.opencode/nexus
if pgrep -f "node server.js" > /dev/null; then
  echo "NEXUS já está rodando."
  exit 0
fi
nohup node server.js > nexus.log 2>&1 &
sleep 1
echo "⚡ NEXUS no ar: http://LINUX_TAILSCALE_IP:3777"