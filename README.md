# Telegram Top Reacoes

Escaneia grupos e canais do Telegram via API oficial (Telethon/MTProto) e guarda as mensagens com mais reacoes num banco SQLite local. Conversas privadas com pessoas sao sempre ignoradas. Por padrao escaneia automaticamente todos os grupos/canais (e reflete sozinho quando voce entra ou sai de algum), mas voce pode restringir pra so os que importam via config.json - veja "Escolher quais grupos/canais entram no scan".

## Setup (uma vez so)

1. Pegue suas credenciais de API em https://my.telegram.org/apps (login com seu numero, cria um app qualquer, anota api_id e api_hash).
2. Copie .env.example para .env e preenche TELEGRAM_API_ID, TELEGRAM_API_HASH e TELEGRAM_PHONE (com DDI, ex: +5511999999999).
3. Ative o ambiente virtual e instale as dependencias:

   venv\Scripts\activate
   pip install -r requirements.txt

4. Rode o primeiro login manualmente, direto no seu terminal (precisa digitar o codigo que o Telegram manda, entao essa parte nao da pra automatizar):

   python list_chats.py

   Vai pedir o codigo de login (chega por mensagem no proprio Telegram ou SMS) e, se voce tiver verificacao em duas etapas, a senha. Depois disso fica uma sessao salva em data/session.session e os proximos comandos nao pedem login de novo. Esse script tambem lista todos os grupos/canais que voce participa, com o status "sera escaneado" ou "fora do escopo" - serve pra conferir o que vai entrar antes de rodar o scan de verdade. Rode ele de novo sempre que quiser conferir essa lista depois de mexer no config.json.

## Uso do dia a dia

- python scan.py                                 escaneia tudo que for novo, em todos os grupos/canais, desde o ultimo scan
- python scan.py --top 20                        escaneia e ja mostra as 20 mensagens com mais reacoes no final
- python scan.py --top-only 20                   so mostra o top 20 que ja esta salvo, sem escanear de novo
- python scan.py --limite-por-chat 1000 --top 20 escaneia no maximo 1000 mensagens novas por grupo nessa rodada (rapido pra testar); retoma de onde parou na proxima execucao
- python list_chats.py                           lista seus grupos/canais e mostra quais serao escaneados ou ignorados

Durante o scan, ele imprime o progresso a cada 500 mensagens verificadas dentro de cada grupo/canal, entao mesmo num grupo grande da pra ver que esta avançando (nao fica mudo até terminar).

Os dados ficam em data/reacoes.db (SQLite puro - abre com qualquer client SQL, DB Browser for SQLite, ou "sqlite3 data/reacoes.db" no terminal). Consultas prontas em queries.sql.

## Escolher quais grupos/canais entram no scan

Copie config.example.json para config.json e escolha um dos dois modos (por @username ou pelo identificador numerico que o list_chats.py mostra):

- **Lista branca ("incluir")**: se voce listar qualquer grupo/canal em "incluir", so esses sao escaneados - todo o resto fica fora, mesmo que "ignorar" esteja vazio. Use esse modo se voce sabe exatamente quais grupos importam (ex: so os de trabalho) e nao quer gastar tempo escaneando o resto.
- **Lista de exclusao ("ignorar")**: com "incluir" vazio (ou ausente), o scan volta ao padrao automatico - pega tudo, exceto o que estiver em "ignorar". Use esse modo se quiser que grupos novos entrem sozinhos e so precisa tirar alguns poucos de fora.

Rode `python list_chats.py` depois de editar o config.json pra conferir o resultado antes de rodar o scan de verdade.

## Limitacoes ja conhecidas

- Grupos basicos (nao supergrupo) nao tem link publico de mensagem no Telegram - o campo link fica vazio nesses casos, e limitacao da propria plataforma, nao do script.
- Primeiro scan de um canal com muito historico pode demorar, porque passa mensagem por mensagem verificando reacao. Scans seguintes so leem o que e novo.
- O arquivo data/session.session equivale a estar logado na sua conta do Telegram - nao sobe isso pra lugar nenhum (o .gitignore ja exclui) e trata como senha.
