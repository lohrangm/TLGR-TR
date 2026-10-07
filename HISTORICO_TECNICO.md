# Historico tecnico - Telegram Top Reacoes

Documento pra quem (humano ou IA) pegar esse projeto depois e entender o que
foi feito, por que, e onde estao as pegadinhas. Mantido atualizado a cada
mudanca relevante.

## O que o projeto faz

Escaneia os grupos e canais do Telegram do usuario atras de mensagens com
reacoes, guarda tudo localmente e mostra um ranking ("top reacoes") com link
direto pra mensagem original.

## Decisao de arquitetura: tudo dentro do navegador

Existiu uma primeira versao em Python (Telethon + SQLite + dashboard Flask,
arquivos `scan.py`, `db.py`, `dashboard.py`, `list_chats.py` na raiz do
projeto - mantidos so como referencia historica, **descontinuados**).

Essa versao exigia manter um processo Python rodando no PC. O requisito do
usuario foi explicito: tudo tem que rodar nativamente dentro do Telegram Web,
sem servidor separado, sem processo Python, sem "manter uma conexao de IP
aberta". A solucao final e um **unico userscript Tampermonkey** que roda
dentro de `web.telegram.org`, com um cliente MTProto real em JavaScript puro
embutido nele. Esse e o unico caminho a seguir dai em diante - nao cogitar
voltar pra arquitetura com processo externo.

### Como um cliente MTProto roda dentro do navegador

A peca-chave e a lib `teleproto` (fork do GramJS mantido ativamente, pacote
npm `teleproto`), que espelha quase 1:1 a API do Telethon/GramJS
(`TelegramClient`, `StringSession`, `client.start(...)`, `iterDialogs()`,
`iterMessages()`, etc).

O ponto que destrava tudo e a extensao `teleproto/extensions/PromisedWebSockets.js`:
um transporte MTProto via WebSocket nativo do navegador, conectando em
`wss://<host-do-dc>:443/apiws` - o mesmo endpoint que o proprio Telegram Web
usa. Passar essa classe como `networkSocket` na criacao do `TelegramClient`
faz `client.networkSocket.isWebSocket === true`, o que faz o cliente
endereçar os DCs por hostname em vez de IP:porta cru (que nao seria possivel
abrir direto de dentro do navegador).

### Empacotamento (esbuild)

`painel_build/build.mjs` empacota o `teleproto` pra rodar no navegador via
esbuild, com:
- `esbuild-plugin-polyfill-node` pra polyfillar `fs`/`path`/`os`/`events`/`util`/`crypto`
  e marcar `net`/`timers/promises` como vazios (nao sao alcancados no caminho
  que usamos).
- Um plugin customizado que stubba `node-localstorage` e `write-file-atomic`
  pra modulo vazio. Motivo: esses dois so existem pra dar suporte ao
  `StoreSession` (sessao salva em arquivo), que **nao usamos** - aqui a sessao
  e `StringSession`, guardada via `GM_setValue` do Tampermonkey. Sem esse
  stub, o bundle quebra com `TypeError: Cyclic __proto__ value` (vem do
  `graceful-fs`, que faz um truque de prototype-patching incompativel com o
  polyfill de `fs`).
- Imports diretos de arquivo (ex: `teleproto/client/TelegramClient.js`, nao
  `teleproto/client`) porque os arquivos-barril (`index.js`) do pacote
  puxam codigo Node-only que nao usamos e que quebraria o build.

`painel_build/entry.js` e o ponto de entrada do bundle (so expoe
`TelegramClient`, `StringSession`, `PromisedWebSockets` em
`window.TeleprotoBridge`). `painel_build/montar_userscript.mjs` concatena o
cabecalho do userscript (metadata do Tampermonkey) + `bundle.js` gerado +
`painel_logic.js` (logica escrita a mao) no arquivo final
`painel_telegram.user.js`.

Pra rebuildar do zero: `cd painel_build && npm install && npm run build`
(roda `build.mjs` e depois `montar_userscript.mjs`). Se so `painel_logic.js`
mudou (o `bundle.js` do teleproto nao muda), basta rodar
`node montar_userscript.mjs` direto, sem precisar rebuildar o bundle inteiro.

### Teste automatizado da logica de armazenamento

`painel_build/test_indexeddb_logic.mjs` testa a logica do IndexedDB (busca
do top por reacoes, contagem por chat, persistencia do campo `concluido`)
fora do navegador, usando `fake-indexeddb` em Node puro. Roda com
`npm test` dentro de `painel_build`. Essas funcoes sao copias das que estao
em `painel_logic.js` - se mudar uma, atualiza a outra tambem (nao tem import
compartilhado porque um lado roda em userscript, outro em Node puro).

## As tres convencoes de id de chat do Telegram (pegadinha grande)

Existem TRES esquemas diferentes de id pra um mesmo grupo/canal, e confundir
eles foi a causa da maior dor de cabeca do projeto:

1. **"Marked id" da Bot API** - o que `teleproto` usa por padrao
   (`dialog.id`): `-<id>` pra grupo basico, `-100<id>` pra canal/supergrupo.
   E o formato que a gente guarda como `chatId` no IndexedDB.
2. **"peerId" interno do Telegram Web K** (cliente real em
   `web.telegram.org/k`, codigo em `github.com/morethanwords/tweb`,
   `src/helpers/peerIdPolyfill.ts`): sempre o id puro negativado, **sem** o
   infixo "100" - `isChat ? -Math.abs(n) : n`.
3. **Link nativo de "copiar link da mensagem"** (`t.me/c/<id>/<msg>`): usa o
   mesmo id puro do esquema 2, sem sinal.

O link que abre a MENSAGEM EXATA dentro do Telegram Web (nao so o chat) e
(achado lendo o codigo-fonte real do tweb, `appImManager.ts`,
`onHashChangeUnsafe`):

```
https://web.telegram.org/k/#<id puro, sem sinal, sem 100>?post=<id da mensagem>
```

A funcao `idBaseDoChatId()` em `painel_logic.js` converte do formato que a
gente guarda (esquema 1) pro formato que a URL precisa (esquema 2/3) -
tira o sinal e, se tiver, o "100" do meio. Confirmado contra exemplos reais
de link nativo que o usuario mandou.

**Licao**: quando uma integracao com um cliente de terceiros nao bate, vale
mais clonar o codigo-fonte real dele (`git clone --depth 1`) e ler a logica
exata do que tentar adivinhar ou pedir pro usuario fazer um teste manual
ambiguo. Foi assim que se chegou no formato certo do link, depois de duas
tentativas erradas (hash estatico sem reload; abrir em aba nova mas sem o
`?post=`).

## Decisoes de produto que vieram de feedback do usuario

- **Escolha de grupo no scan**: o scan antes processava o que
  `iterDialogs()` devolvesse primeiro (podia ser um grupo gigante e
  irrelevante). Agora a tela de scan tem um `<select>` com todos os
  grupos/canais da conta (carregado via `iterDialogs()` de novo, so pra
  listar titulo+id) e deixa escolher um especifico ou "Todos".
- **Visibilidade do que ja foi salvo**: antes o usuario ficava "as cegas" -
  sem saber quantas mensagens com reacao ja tinham sido salvas por grupo, nem
  quando. Agora a tela de scan mostra uma tabela (titulo, quantidade de
  mensagens salvas, status, data do ultimo scan) que atualiza sozinha durante
  o scan (a cada checkpoint de 500 mensagens e ao terminar um chat).
- **Marcacao de scan completo vs parcial**: campo `concluido` (true/false)
  gravado junto com cada chat. So vira `true` quando o loop de mensagens
  daquele chat termina sozinho (sem o usuario ter clicado "Parar"). Aparece
  como badge "completo"/"parcial" na tabela acima.

## Estilo de trabalho esperado pelo usuario (Lohran)

- Nao gosta de aprovacao passo a passo - prefere que a solucao seja
  entregue pronta e testada do lado dele como usuario final.
- Instrucoes de "o que fazer agora" devem ser curtas e diretas (ex: "mesmo
  arquivo, mesmo processo de antes"), nunca um guia passo-a-passo repetido
  quando ele ja fez aquele processo antes.
- Prefere que erros e causas sejam resolvidos investigando evidencia real
  (codigo-fonte, console do navegador) em vez de pedir pra ele fazer testes
  manuais ambiguos ou comparacoes que nao fazem sentido no fluxo real do
  Telegram Web.

## Pipeline de entrega (sandbox -> PC do usuario)

O trabalho e feito num sandbox cloud sem acesso de rede a
`web.telegram.org` (bloqueio de egress da organizacao - confirmado via
`curl` e WebSocket direto) - ou seja, a verificacao end-to-end so e
possivel no navegador real do usuario, nunca aqui. O fluxo de entrega e:
editar o arquivo no sandbox -> `SendUserFile` -> `device_commit_files`
(grava no PC Windows do usuario, pasta
`C:\Projetos\PROJETOS_MAESTRO\TELEGRAM_TOP_REACOES`) -> commit via
`windows-cli` (PowerShell), usando `git -C "<caminho>"` porque o parametro
`workingDir` da ferramenta e rejeitado.

**Pegadinha do shell do Windows-cli**: bloqueia qualquer comando que
contenha `&`, `|`, `;` ou `` ` `` em qualquer lugar da string - inclusive
dentro do texto da mensagem de commit entre aspas. Por isso o `git add` e o
`git commit` vao em chamadas separadas, e a mensagem de commit nunca pode
ter ponto-e-virgula no corpo.

## Estado atual / pendencias

Tudo que foi pedido ate agora (login, scan, armazenamento, ranking, link
pra mensagem exata, escolha de grupo, visibilidade do que foi salvo, marca
de completo/parcial) esta implementado e entregue. Nao ha pendencia
conhecida - a ultima leva de mudancas (escolha de grupo + tabela +
completo/parcial) ainda nao foi validada pelo usuario no Telegram real dele
no momento em que este documento foi escrito.

Se aparecer um proximo problema relatado pelo usuario, documentar aqui
depois de resolvido: o que quebrou, por que, e a correcao - nesse mesmo
formato das secoes acima.
