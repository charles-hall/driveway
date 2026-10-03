#!/bin/bash
# Runs on the server after each push lands in the app folder:
# installs any new packages and restarts the Node app. Safe to run by hand too.
set -e
cd "$(dirname "$0")/.."
REL="${PWD#$HOME/}"
ACT=$(ls -d "$HOME"/nodevenv/"$REL"/*/bin/activate 2>/dev/null | sort -V | tail -1)
if [ -n "$ACT" ]; then
  source "$ACT"
  npm install --omit=dev --no-audit --no-fund
else
  echo "No Node.js app found for $PWD yet. Create it in cPanel > Setup Node.js App, then run NPM Install."
fi
mkdir -p tmp && touch tmp/restart.txt
echo "Deployed $(git rev-parse --short HEAD 2>/dev/null) at $(date)"
