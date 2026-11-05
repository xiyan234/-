@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo.
echo === 教务登录检测 ===
echo.
set /p SID=请输入学号后回车: 
echo.
if "%SID%"=="" (
  echo 没有输入学号，已退出。
  pause
  exit /b
)
echo 提交方式：
echo   直接回车 = 表单 body（默认）
echo   输入 q   = 字段放 URL、body 为空（小程序里新用的方式）
echo.
set /p MODE=请选择后回车: 
echo.
if /i "%MODE%"=="q" (
  node scripts\probe-jw.js %SID% --query
) else (
  node scripts\probe-jw.js %SID%
)
echo.
echo === 检测结束，把上面最后几行发给助手 ===
pause
