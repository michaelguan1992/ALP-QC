@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
if errorlevel 1 (
  echo 无法进入 MasterQC Web 项目目录。
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js。请安装 Node.js 22 或更高版本，然后重新启动。
  pause
  exit /b 1
)

for /f "delims=" %%V in ('node -p "Number(process.versions.node.split('.')[0])" 2^>nul') do set "NODE_MAJOR=%%V"
if not defined NODE_MAJOR (
  echo 无法读取 Node.js 版本，请重新安装 Node.js 22 或更高版本。
  pause
  exit /b 1
)
if %NODE_MAJOR% LSS 22 (
  echo 当前 Node.js 版本过旧。请安装 Node.js 22 或更高版本后重新启动。
  pause
  exit /b 1
)

node launcher\server.mjs
set "SERVER_EXIT=%ERRORLEVEL%"
if not "%SERVER_EXIT%"=="0" pause
exit /b %SERVER_EXIT%
