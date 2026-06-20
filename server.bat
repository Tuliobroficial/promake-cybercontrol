@echo off
cd /d "%~dp0"
set PYTHONPATH=%~dp0pylib
echo.
echo   PROMAKE DASH v2.0
echo   ====================
echo   Servidor: http://localhost:8081
echo   Login: tuliobroficial@gmail.com / admin123
echo.

python3.14 "%~dp0backend\app.py"
if %ERRORLEVEL% EQU 0 exit /b

"C:\Users\tulio\.local\bin\python3.14.exe" "%~dp0backend\app.py"
if %ERRORLEVEL% EQU 0 exit /b

python3 "%~dp0backend\app.py"
if %ERRORLEVEL% EQU 0 exit /b

python "%~dp0backend\app.py"
if %ERRORLEVEL% EQU 0 exit /b

echo   ERRO: Nao foi possivel iniciar o servidor.
echo   Certifique-se de que o Python esta instalado.
pause
