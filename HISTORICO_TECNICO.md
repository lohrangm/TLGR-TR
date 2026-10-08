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
- **Botao de sair**: tirado do menu principal (onde ficava do lado de
  "Escanear"/"Ver top reacoes" e corria risco de clique por acidente) e
  movido pra um texto pequeno no cabecalho do painel, do lado do "x" de
  fechar. Exige dois cliques (primeiro vira "confirmar?" em vermelho por
  3s, so sai no segundo clique dentro desse tempo) - sem usar `confirm()`
  nativo do navegador, que trava a pagina.

## Busca por palavra-chave (a busca nativa do Telegram falha)

Confirmado por pesquisa (nao era "coisa da cabeca" do usuario): a busca
nativa do Telegram e indexada por PALAVRA INTEIRA, nao por substring. Ha uma
thread de bug aberta desde 2020 (`bugs.telegram.org/c/724`) pedindo busca
por substring pra idiomas sem espaco entre palavras (chines/japones), ainda
sem correcao oficial confirmada - o status e so "Added", sem resposta da
equipe do Telegram explicando ou corrigindo. Na pratica isso tambem afeta
busca por trechos/variacoes de palavra em qualquer idioma, inclusive
portugues: se a palavra busca nao bate exatamente com o token indexado
(singular/plural, acentuacao em certos casos, parte de uma palavra
composta), a busca nao acha a mensagem mesmo ela existindo.

**Solucao implementada**: aproveitar o que o scan ja escaneia. Antes, o
scan so salvava mensagens COM reacao (o resto era so contado e descartado).
Agora `escanearTudo()` salva o texto completo de TODA mensagem (campo
`texto`, sem truncar - antes era `textPreview`, truncado em 120 caracteres
e so pra mensagem com reacao). `reactionTotal` fica 0 quando nao tem
reacao, e o ranking de "top reacoes" continua funcionando igual (filtra
por esse campo).

Nova tela "Buscar mensagens" (`telaBusca()`) faz busca por substring
usando `buscarTexto()`: percorre as mensagens ja salvas (por chat, via o
indice `por_chat`, ou tudo via cursor na tabela toda) comparando o texto
normalizado (`normalizarTexto()` - remove acentuacao com
`.normalize("NFD")` + regex, poe em minusculo) contra o termo buscado,
tambem normalizado. E simples (sem indice invertido, sem lib de busca) e
roda inteiramente no navegador - suficiente pra escala de uso pessoal.

**Trade-off que o usuario precisa saber**: grupos que ja foram escaneados
ANTES dessa mudanca so tem o texto das mensagens com reacao salvo - as
outras foram descartadas na epoca e nao tem como recuperar o texto sem
escanear nao de novo. Pra backfill, a tela de scan ganhou um checkbox
"Reescanear esse grupo do zero" (so aparece quando um grupo especifico,
nao "Todos", esta selecionado) que zera o `lastScannedMessageId` daquele
chat antes de rodar, forcando o scan a percorrer o historico inteiro de
novo - dessa vez salvando tudo. Isso tambem significa que o banco local
agora guarda MUITO mais linhas (toda mensagem, nao so as com reacao), o
que e esperado e aceitavel pra uso pessoal mas vale deixar claro.

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
de completo/parcial, botao de sair no cabecalho, busca por palavra-chave)
esta implementado e entregue. A busca por palavra-chave ainda nao foi
validada pelo usuario no Telegram real dele no momento em que este trecho
foi escrito - vale conferir se o desempenho fica bom em grupos grandes
(o scan agora grava toda mensagem, nao so as com reacao) e se o backfill
via "reescanear do zero" funciona como esperado.

## "Reescanear do zero" preso ao modo de grupo unico (corrigido)

O usuario rodou escaneamento de "Todos" esperando que isso desse o texto
completo das mensagens antigas pra busca por palavra-chave. Na pratica, o
scan normal so busca mensagem NOVA a partir do `lastScannedMessageId`
salvo - um grupo que ja estava marcado como totalmente escaneado ANTES da
busca por palavra-chave existir fica parado nesse checkpoint, entao rodar
"Todos" de novo so pega as poucas mensagens genuinamente novas (por isso
pareceu rapido demais e "nao leu nada"). O texto completo das mensagens
antigas simplesmente nunca foi salvo pra esses grupos, e o scan normal nao
tem como saber disso sozinho.

A funcao `escanearTudo()` ja aceitava um `reescanearDoZero` que zera esse
checkpoint pra qualquer chat que o loop processar, independente de
`apenasChatId` - nao era bug nela. O bug era so na UI: o checkbox
"Reescanear do zero" (`telaScanner()`) ficava escondido e forcado a `false`
sempre que "Todos" estava selecionado, entao nao tinha como disparar esse
comportamento pra mais de um grupo por vez sem fazer manualmente, grupo a
grupo, pelo seletor. Corrigido: o checkbox agora fica visivel e funciona
nos dois modos, com o texto do label mudando pra avisar que em "Todos" ele
reescaneia TODOS os grupos do zero (pode demorar bem mais, repassa o
historico inteiro de cada um de novo).

## Backlog (pedido pelo usuario, nao implementado ainda)

- **Marcar mensagem como "ja visto" (manual)**: usuario quer uma caixinha
  por mensagem, tanto em "Ver top reacoes" quanto em "Buscar mensagens",
  pra marcar que ja checou aquela mensagem - sem nenhuma logica automatica,
  so controle manual dele. Ele mesmo disse que acha que e dificil de fazer,
  mas NAO e: e so um campo booleano (`visto: true/false`) no registro da
  mensagem + um checkbox na UI que chama `salvarMensagem()` de novo com
  esse campo atualizado, no mesmo padrao do `concluido` que ja existe pros
  chats. Prioridade baixa (ele deixou claro que e so pra anotar).

- **Paginacao em "Ver top reacoes"**: hoje `buscarTop()` e chamado com
  `limite: 50` fixo (`telaResultados()`), sem jeito de ver o resto. O
  usuario pediu um botao "mostrar mais" no final da lista que carrega mais
  resultados sob demanda (nao a lista inteira de uma vez). Prioridade alta
  - ele foi explicito que esse e o que mais importa.
- **Mesma paginacao em "Buscar mensagens"**: ele disse que nao tem certeza
  se vale a pena aqui (menos prioridade que o item acima, mas vale
  considerar junto ja que `buscarTexto()` tem a mesma limitacao de
  `limite` fixo).
- **Mostrar quais reacoes, nao so o total**: hoje `telaResultados()` so
  exibe `m.reactionTotal` (numero). O registro ja guarda o array
  `reactions` (`[{emoji, count}]`, separado por emoji), entao da pra
  exibir sem precisar escanear de novo - e so renderizar esse array. Ultima
  prioridade da lista, usuario deixou claro que so vale a pena se for
  facil (e e - os dados ja estao salvos).

## Pesquisa de reclamacoes comuns do Telegram (p/ identificar melhorias)

A pedido do usuario, pesquisei reclamacoes recorrentes de usuarios do
Telegram (agregadores de reviews de App Store/Google Play, r/Telegram via
gummysearch, Capterra) pra ver se haveria mais oportunidades pro nosso
painel. Reclamacoes relevantes pro escopo do projeto:

- **Busca ineficiente** - confirma de novo o que ja motivou a busca por
  palavra-chave que implementamos.
- **Silenciar grupo faz perder mensagem importante** / notificacao em
  excesso em grupo movimentado - essa e a mais promissora pra uma proxima
  feature: como ja escaneamos e guardamos tudo localmente, da pra fazer um
  "resumo do que rolou" (ex: mensagens com mais reacao, ou so as novas,
  desde a ultima vez que o usuario abriu aquele chat/o painel) - uma forma
  de acompanhar grupo silenciado sem perder o que importa. Ainda nao
  conversei isso com o usuario, so anotando a ideia.
- **Organizar muitos grupos/canais e dificil, pastas insuficientes** -
  relacionado de leve ao nosso seletor de grupo, mas nao parece um gap que
  valha a pena perseguir agora.
- Reclamacoes fora do escopo do projeto (nao da pra resolver com um
  userscript local): spam/contas falsas, chamada de video, demora pra
  enviar mensagem, bloqueio de conta sem aviso, falta de criptografia
  ponta-a-ponta por padrao, ausencia de ferramentas de gestao de
  tarefas/prazos (isso seria outro produto, nao uma feature desse).

Se aparecer um proximo problema relatado pelo usuario, documentar aqui
depois de resolvido: o que quebrou, por que, e a correcao - nesse mesmo
formato das secoes acima.
