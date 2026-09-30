#!/bin/zsh

PROJECT_DIR="${0:A:h}"
cd "$PROJECT_DIR" || {
  print "无法进入 MasterQC Web 项目目录。"
  read "?按 Return 键关闭此窗口。"
  exit 1
}

if ! command -v node >/dev/null 2>&1; then
  print "未检测到 Node.js。请安装 Node.js 22 或更高版本，然后重新启动。"
  read "?按 Return 键关闭此窗口。"
  exit 1
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null)"
if [[ ! "$NODE_MAJOR" =~ '^[0-9]+$' ]] || (( NODE_MAJOR < 22 )); then
  print "当前 Node.js 版本过旧。请安装 Node.js 22 或更高版本后重新启动。"
  read "?按 Return 键关闭此窗口。"
  exit 1
fi

node launcher/server.mjs
SERVER_EXIT=$?
if (( SERVER_EXIT != 0 )); then
  read "?启动失败。按 Return 键关闭此窗口。"
fi
exit "$SERVER_EXIT"
