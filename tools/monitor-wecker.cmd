@echo off
rem Starts monitor-wecker.ps1 hidden (put a shortcut to this file into shell:startup)
start "" powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "%~dp0monitor-wecker.ps1"
