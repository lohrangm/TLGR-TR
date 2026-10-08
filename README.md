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

## Dashboard web local (descontinuado, veja o painel nativo abaixo)

Essa abordagem (servidor Python local + pagina separada) foi testada e descartada - os links abertos davam erro e o fluxo de depender de um servidor rodando nao era pratico. Ficou aqui so por referencia; o caminho atual e o "Painel nativo dentro do Telegram Web" mais abaixo.

    python dashboard.py

Sobe um servidor local (so acessivel no seu computador) e abre sozinho no navegador em http://127.0.0.1:8765. Mostra a tabela de top reacoes com filtro por grupo e por minimo de reacoes, e cada linha tem um link que abre a mensagem direto no Telegram. Le direto do banco, entao sempre mostra o que ja foi escaneado ate o momento - roda o scan.py de novo quando quiser dado mais recente, e so atualizar a pagina (F5) no navegador. Pra parar o servidor, Ctrl+C no terminal.

Os links de grupos/canais publicos abrem como pagina web (sem precisar do app do Telegram instalado). Grupos/canais privados (sem @username publico) nao tem essa opcao - o link deles so abre se voce tiver o Telegram Desktop instalado ou estiver logado em web.telegram.org no navegador.

## Painel nativo dentro do Telegram Web (versao atual)

O painel roda inteiro dentro do proprio web.telegram.org - sem servidor local, sem Python rodando, sem conexao de IP pra manter aberta. O cliente do Telegram (MTProto) foi portado pra JavaScript puro e roda direto no navegador, do mesmo jeito que o proprio Telegram Web se conecta (WebSocket), e a sessao de login fica guardada no proprio Tampermonkey.

Isso ainda e so a parte de login (fase 1). A tela de top reacoes dentro do painel (puxando os dados que o scan.py ja coleta) e a proxima etapa.

Setup (uma vez so):

1. Instale a extensao Tampermonkey no seu navegador (https://www.tampermonkey.net).
2. Tampermonkey → Dashboard → aba "Utilitarios" → "Importar do arquivo" → escolhe `painel_build/painel_telegram.user.js`. **Nao** abra o arquivo no Bloco de Notas e cole o conteudo no editor do Tampermonkey - o arquivo passa de 8 MB de texto, e colar isso numa caixa de texto de extensao de navegador trava, corta ou mistura com o conteudo antigo sem avisar erro nenhum (ja aconteceu, ver HISTORICO_TECNICO.md).
3. Abra ou atualize o web.telegram.org - aparece um botao flutuante "Top Reacoes" no canto da tela.
4. Clique nele. Na primeira vez, vai pedir api_id e api_hash (pegue em https://my.telegram.org/apps, so precisa fazer isso uma vez - fica salvo no proprio navegador).
5. Depois disso, pede seu numero de telefone, o codigo de login (chega no proprio Telegram ou por SMS) e, se voce tiver verificacao em duas etapas, a senha - tudo em caixas de texto dentro do proprio painel.
6. Uma vez logado, a sessao fica salva no Tampermonkey - reabrir o painel depois nao pede login de novo. Tem um botao "Sair" pra apagar a sessao salva, se precisar trocar de conta.

O numero de versao instalado aparece no topo do proprio painel (do lado de "Top Reacoes") e tambem no Dashboard do Tampermonkey, ao lado do nome do script - compare com a versao mais recente entregue pra saber se a atualizacao realmente pegou.

**Atualizar depois da primeira vez**: o script ja vem com `@updateURL`/`@downloadURL` no cabecalho, entao o Tampermonkey consegue checar sozinho se tem versao nova (Dashboard → no script → "Check for userscript updates"). Enquanto o repositorio nao esta publicado (ver "Publicar no GitHub" abaixo), isso exige rodar `iniciar_servidor_userscript.bat` (na raiz do projeto) antes de pedir a checagem. Depois de publicado no GitHub, isso deixa de ser necessario.

Detalhe tecnico, caso de erro: o arquivo painel_telegram.user.js e gerado (nao e pra editar na mao) a partir dos arquivos em painel_build/ (entry.js, painel_logic.js, build.mjs, montar_userscript.mjs). Pra gerar de novo depois de alguma mudanca: `cd painel_build && node build.mjs && node montar_userscript.mjs` (so precisa do `build.mjs` se `entry.js` ou as dependencias do teleproto mudarem).

### Publicar no GitHub (opcional, elimina o `iniciar_servidor_userscript.bat`)

Sem repositorio remoto, o `@updateURL` aponta pra um servidor local (precisa do `.bat` rodando no momento da checagem). Publicando num repositorio **publico** no GitHub, a URL passa a ser `https://raw.githubusercontent.com/<usuario>/<repo>/<branch>/painel_build/painel_telegram.user.js` - sempre disponivel, sem precisar de nada rodando no seu PC. Repo **privado** nao funciona bem aqui: a checagem do Tampermonkey e uma requisicao sem autenticacao, e `raw.githubusercontent.com` de repo privado exige token. Nada sensivel esta versionado (.env, sessao e banco ja ficam de fora pelo .gitignore), entao repo publico so expoe o codigo.

Passos (rodar numa conta com permissao pra criar repositorio nessa conta do GitHub):

    cd C:\Projetos\PROJETOS_MAESTRO\TELEGRAM_TOP_REACOES
    gh repo create <seu-usuario>/telegram-top-reacoes --public --source=. --remote=origin --push

Sem `gh` autenticado: cria o repositorio pelo site do GitHub (vazio, sem README) e depois:

    git remote add origin https://github.com/<seu-usuario>/telegram-top-reacoes.git
    git push -u origin master

Depois disso, atualiza `URL_ATUALIZACAO` em `painel_build/montar_userscript.mjs` pra essa URL raw, roda `node montar_userscript.mjs`, importa essa versao **uma ultima vez** via "Importar do arquivo" (nao copia/cola) - da em diante o Tampermonkey confere sozinho direto no GitHub.

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
