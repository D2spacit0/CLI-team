@echo off
pushd "%~dp0"
node tools\launch.mjs
set "cli_team_exit=%errorlevel%"
popd
if not "%cli_team_exit%"=="0" pause
exit /b %cli_team_exit%
