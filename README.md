# Telegram Top Reacoes

Escaneia grupos e canais do Telegram via API oficial (Telethon/MTProto) e guarda as mensagens com mais reacoes num banco SQLite local. Conversas privadas com pessoas sao sempre ignoradas. Quais grupos/canais entram no scan e controlado pelo arquivo grupos_para_escanear.txt, gerado automaticamente com o nome de cada um - voce so apaga as linhas dos que nao quer escanear, sem precisar descobrir identificador nenhum. Veja "Escolher quais grupos/canais entram no scan".

## Setup (uma vez so)

1. Pegue suas credenciais de API em https://my.telegram.org/apps (login com seu numero, cria um app qualquer, anota api_id e api_hash).
2. Copie .env.example para .env e preenche TELEGRAM_API_ID, TELEGRAM_API_HASH e TELEGRAM_PHONE (com DDI, ex: +5511999999999).
3. Ative o ambiente virtual e instale as dependencias:

   venv\Scripts\activate
   pip install -r requirements.txt

4. Rode o primeiro login manualmente, direto no seu terminal (precisa digitar o codigo que o Telegram manda, entao essa parte nao da pra automatizar):

   python list_chats.py

   Vai pedir o codigo de login (chega por mensagem no proprio Telegram ou SMS) e, se voce tiver verificacao em duas etapas, a senha. Depois disso fica uma sessao salva em data/session.session e os proximos comandos nao pedem login de novo.

   Esse script tambem cria o arquivo grupos_para_escanear.txt, com todos os seus grupos/canais listados pelo nome, e mostra na tela o status de cada um ("sera escaneado" ou "fora do escopo"). Rode ele de novo sempre que quiser conferir essa lista ou atualizar com grupos novos.

## Uso do dia a dia

- python scan.py                                 escaneia tudo que for novo, em todos os grupos/canais, desde o ultimo scan
- python scan.py --top 20                        escaneia e ja mostra as 20 mensagens com mais reacoes no final
- python scan.py --top-only 20                   so mostra o top 20 que ja esta salvo, sem escanear de novo
- python scan.py --limite-por-chat 1000 --top 20 escaneia no maximo 1000 mensagens novas por grupo nessa rodada (rapido pra testar); retoma de onde parou na proxima execucao
- python list_chats.py                           lista seus grupos/canais e mostra quais serao escaneados ou ignorados

Durante o scan, ele imprime o progresso a cada 500 mensagens verificadas dentro de cada grupo/canal, entao mesmo num grupo grande da pra ver que esta avançando (nao fica mudo até terminar).

Os dados ficam em data/reacoes.db (SQLite puro - abre com qualquer client SQL, DB Browser for SQLite, ou "sqlite3 data/reacoes.db" no terminal). Consultas prontas em queries.sql.

## Escolher quais grupos/canais entram no scan

O `list_chats.py` cria (na primeira vez) o arquivo grupos_para_escanear.txt, com uma linha por grupo/canal, no formato:

    @deckpirata | Deck Pirata
    -1004485725044 | Appeals - Chat...

Abra esse arquivo (ex: `notepad grupos_para_escanear.txt`) e apague as linhas dos grupos que voce NAO quer escanear - so isso, nao precisa saber identificador nem editar JSON. Se preferir manter a linha mas desativar temporariamente, pode so colocar um `#` na frente dela em vez de apagar.

Se voce entrar num grupo/canal novo depois, rode `python list_chats.py` de novo: ele nao mexe no que voce ja decidiu, so acrescenta os novos numa secao "NOVOS" no final do arquivo pra voce revisar.

Sem esse arquivo (antes de rodar list_chats.py pela primeira vez), o scan.py escaneia tudo automaticamente.

## Limitacoes ja conhecidas

- Grupos basicos (nao supergrupo) nao tem link publico de mensagem no Telegram - o campo link fica vazio nesses casos, e limitacao da propria plataforma, nao do script.
- Primeiro scan de um canal com muito historico pode demorar, porque passa mensagem por mensagem verificando reacao. Scans seguintes so leem o que e novo.
- O arquivo data/session.session equivale a estar logado na sua conta do Telegram - nao sobe isso pra lugar nenhum (o .gitignore ja exclui) e trata como senha.
