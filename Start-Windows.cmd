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
  echo Node.js was not found. Install Node.js 22.13 or later, then restart.
  pause
  exit /b 1
)

for /f "delims=" %%V in ('node -p "const [major,minor]=process.versions.node.split('.').map(Number); Number((major===22&&minor>=13)||(major===23&&minor>=4)||major>=24)" 2^>nul') do set "NODE_SQLITE_SUPPORTED=%%V"
if not defined NODE_SQLITE_SUPPORTED (
  echo Could not read the Node.js version. Install Node.js 22.13+ on the 22.x line, 23.4+ on the 23.x line, or 24+.
  pause
  exit /b 1
)
if not "%NODE_SQLITE_SUPPORTED%"=="1" (
  echo Built-in SQLite requires Node.js 22.13+ on the 22.x line, 23.4+ on the 23.x line, or 24+. Install a supported release, then restart.
  pause
  exit /b 1
)

node launcher\server.mjs
set "SERVER_EXIT=%ERRORLEVEL%"
if not "%SERVER_EXIT%"=="0" pause
exit /b %SERVER_EXIT%
