# Telegram Top Reacoes

Escaneia grupos e canais do Telegram via API oficial (Telethon/MTProto) e guarda as mensagens com mais reacoes num banco SQLite local. Troca a abordagem anterior de userscript raspando o Telegram Web por uma onde ID, data e link da mensagem vem direto da API, sem chute em cima de DOM.

## Setup (uma vez so)

1. Pegue suas credenciais de API em https://my.telegram.org/apps (login com seu numero, cria um app qualquer, anota api_id e api_hash).
2. Copie .env.example para .env e preenche TELEGRAM_API_ID, TELEGRAM_API_HASH e TELEGRAM_PHONE (com DDI, ex: +5511999999999).
3. Copie config.example.json para config.json e lista os grupos/canais que quer acompanhar (username com @ ou o ID numerico).
4. Ative o ambiente virtual e instale as dependencias:

   venv\Scripts\activate
   pip install -r requirements.txt

5. Rode o primeiro login manualmente, direto no seu terminal (precisa digitar o codigo que o Telegram manda, entao essa parte nao da pra automatizar):

   python scan.py

   Vai pedir o codigo de login (chega por mensagem no proprio Telegram ou SMS) e, se voce tiver verificacao em duas etapas, a senha. Depois disso fica uma sessao salva em data/session.session e os proximos "python scan.py" nao pedem login de novo.

## Uso do dia a dia

- python scan.py          escaneia so o que for novo desde o ultimo scan (incremental, nao reprocessa tudo de novo)
- python scan.py --top 20        escaneia e ja mostra as 20 mensagens com mais reacoes no final
- python scan.py --top-only 20   so mostra o top 20 que ja esta salvo, sem escanear de novo

Os dados ficam em data/reacoes.db (SQLite puro - abre com qualquer client SQL, DB Browser for SQLite, ou "sqlite3 data/reacoes.db" no terminal). Consultas prontas em queries.sql.

## Limitacoes ja conhecidas

- Grupos basicos (nao supergrupo) nao tem link publico de mensagem no Telegram - o campo link fica vazio nesses casos, e limitacao da propria plataforma, nao do script.
- Primeiro scan de um canal com muito historico pode demorar, porque passa mensagem por mensagem verificando reacao. Scans seguintes so leem o que e novo.
- O arquivo data/session.session equivale a estar logado na sua conta do Telegram - nao sobe isso pra lugar nenhum (o .gitignore ja exclui) e trata como senha.
