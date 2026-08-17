#!/bin/bash
# NEXUS — para o servidor
pkill -f "node server.js" && echo "NEXUS parado." || echo "NEXUS não estava rodando."