@echo off
cd /d "%~dp0"
echo.
echo   ==============================
echo     PROMAKE DASH v2.0
echo   ==============================
echo.
echo   Iniciando servidor Flask...
echo.
"C:\Users\tulio\.local\bin\python3.14.exe" "%~dp0backend\app.py"
echo.
echo   Servidor encerrado.
pause
