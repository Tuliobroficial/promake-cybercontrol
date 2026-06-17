@echo off
cd /d "%~dp0"
echo.
echo   ==============================
echo     JARVIS - Assistente Promake
echo   ==============================
echo.
echo   Iniciando servidor Flask e abrindo Jarvis...
echo.
start http://localhost:8081/jarvis
"C:\Users\tulio\.local\bin\python3.14.exe" "%~dp0backend\app.py"
echo.
echo   Servidor encerrado.
pause
