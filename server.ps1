$python = "C:\Users\tulio\.local\bin\python3.14.exe"
$script = "C:\Users\tulio\OneDrive\Documentos\Opencode projetos\master-dashboard\backend\app.py"

if (!(Test-Path $python)) {
  Write-Host "Python nao encontrado em: $python" -ForegroundColor Red
  exit 1
}

Write-Host "`n  Iniciando Promake Server..." -ForegroundColor Cyan
Write-Host "  Acesse: http://localhost:8081" -ForegroundColor Yellow
Write-Host "  Login:  admin@promake.com / admin123`n" -ForegroundColor Yellow

& $python $script
Read-Host "`nPressione Enter para sair"
