#!/bin/zsh

PROJECT_DIR="${0:A:h}"
cd "$PROJECT_DIR" || {
  print "无法进入 MasterQC Web 项目目录。"
  read "?按 Return 键关闭此窗口。"
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  print "Node.js was not found. Install Node.js 22.13 or later, then restart."
  read "?按 Return 键关闭此窗口。"
  exit 1
fi

NODE_SQLITE_SUPPORTED="$(node -p 'const [major, minor] = process.versions.node.split(".").map(Number); Number((major === 22 && minor >= 13) || (major === 23 && minor >= 4) || major >= 24)' 2>/dev/null)"
if [[ "$NODE_SQLITE_SUPPORTED" != "1" ]]; then
  print "Built-in SQLite requires Node.js 22.13+ on the 22.x line, 23.4+ on the 23.x line, or 24+. Install a supported release, then restart."
  read "?按 Return 键关闭此窗口。"
  exit 1
fi

node launcher/server.mjs
SERVER_EXIT=$?
if (( SERVER_EXIT != 0 )); then
  read "?启动失败。按 Return 键关闭此窗口。"
fi
exit "$SERVER_EXIT"
