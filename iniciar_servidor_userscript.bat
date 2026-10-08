@echo off
cd /d "%~dp0painel_build"

echo Servindo painel_telegram.user.js em http://localhost:8787/painel_telegram.user.js
echo.
echo Deixa essa janela aberta enquanto quiser que o Tampermonkey consiga
echo checar atualizacao. Pra atualizar: Tampermonkey Dashboard, no script
echo "Telegram Top Reacoes - Painel", pede "Check for userscript updates".
echo.
echo Fecha essa janela pra desligar o servidor.
echo.

python -m http.server 8787

pause
