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
de completo/parcial, botao de sair no cabecalho, busca por palavra-chave,
backfill automatico do historico antigo, paginacao em "Ver top reacoes",
marcar mensagem como "ja visto") esta implementado e entregue. Nao tem
pendencia aberta no momento - proximos itens dependem de novo feedback do
usuario (ver "Pesquisa de reclamacoes comuns do Telegram" mais abaixo pra
ideias ainda nao conversadas com ele, como o "resumo do que rolou" pra
grupo silenciado).

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

Adicionado tambem um log de diagnostico (`console.log("[Top Reacoes]
scan:", ...)`) no inicio de cada chat processado, mostrando
`reescanearDoZero` e `ultimoId` - usado pra confirmar com evidencia real
(log do usuario) que o problema seguinte nao era mais o checkbox escondido.

**Esse checkbox foi removido depois** - ver "Backfill automatico" mais
abaixo, que substitui esse mecanismo manual.

## Checkbox nativo invisivel no Telegram Web (corrigido)

Depois do fix acima, o usuario reportou (com screenshot) que a caixinha
"Reescanear do zero" aparecia so como uma caixa de texto com borda, SEM
nenhum quadrado de checkbox visivel - o cursor virava de "clicavel" ao
passar por cima, mas clicar nao parecia fazer nada. Causa: o CSS global do
Telegram Web reseta a aparencia de `input[type="checkbox"]` (coisa comum
em apps com design system proprio) sem recolocar nada visivel no lugar de
elementos injetados por fora da arvore de componentes deles - o checkbox
continuava funcional (o DOM via `.checked` funcionava), so que invisivel.

Corrigido substituindo por uma caixa marcavel feita na mao
(`caixaMarcavel()`, perto de `botaoAcao()`/`campoTexto()`): um `<div>`
quadrado com borda, que alterna cor de fundo e um "✓" via JS puro no
`click`, sem depender de nenhuma aparencia nativa de form control. Devolve
um objeto com `.checked` (getter/setter) e `.disabled` (setter) pra manter
a mesma interface que o `telaScanner()` ja usava, trocando so a
implementacao interna. **Licao pro resto do projeto**: qualquer novo
controle de formulario (checkbox, radio, talvez select customizado) deve
usar esse mesmo padrao de elemento proprio em vez de depender da aparencia
nativa do navegador, porque o CSS do host (Telegram Web) pode reset-ar sem
aviso.

## Backfill automatico (substitui o checkbox "Reescanear do zero")

O usuario chamou o checkbox manual de "gambiarra" com razao: pra completar
o texto do historico antigo de um grupo especifico, ele tinha que
selecionar aquele grupo, marcar o checkbox, esperar escanear tudo nele de
novo, e repetir grupo a grupo - nada disso acontecia sozinho, mesmo rodando
"Todos".

`escanearTudo()` agora faz isso em duas fases, pra cada chat, sem nenhum
toggle manual:

- **Fase 1 (backfill automatico)**: completa o texto das mensagens antigas
  de quando o chat foi escaneado antes da busca por palavra-chave existir
  (so a mensagem com reacao era salva, o resto descartado). Dois campos
  novos no registro do chat: `backfillAlvo` (congela, na primeira vez que o
  chat passa por essa logica, o checkpoint antigo - o limite abaixo do
  qual o historico pode estar incompleto) e `textoCompletoAte` (ponteiro
  retomavel de ate onde o backfill ja avancou, comeca em 0). So roda
  enquanto `textoCompletoAte < backfillAlvo`; usa
  `iterMessages(entity, { minId: textoCompletoAte, maxId: backfillAlvo + 1,
  reverse: true })` pra pegar exatamente o intervalo que falta, checkpoint
  a cada 500 mensagens (mesmo padrao que a fase 2 ja usava). Uma vez que
  alcanca o alvo, nunca mais roda de novo nesse chat - nao tem custo
  recorrente.
- **Fase 2 (scan incremental, igual sempre foi)**: continua de
  `lastScannedMessageId` pra frente, so mensagem nova. So comeca se a fase
  1 nao foi interrompida - se o usuario clicar "Parar" durante o backfill,
  o chat fica com o backfill parcial e a fase 2 fica pra depois (na
  proxima vez que passar por esse chat, primeiro termina o backfill antes
  de seguir pra mensagem nova).

Chat que ja existia de antes dessa funcionalidade (sem `backfillAlvo`
salvo) assume o pior caso: `backfillAlvo = lastScannedMessageId` salvo e
`textoCompletoAte = 0`, ou seja, trata como se nenhum texto completo do
historico tivesse sido salvo ainda. **Efeito colateral conhecido**: o
unico grupo que o usuario ja tinha completado manualmente com o checkbox
antigo vai passar por esse backfill mais uma vez (reprocessamento
redundante, mas inofensivo - so demora um pouco mais na primeira vez que
esse grupo for escaneado depois dessa mudanca).

A tela de scan (`telaScanner()`) perdeu o checkbox "Reescanear do zero"
inteiro - nao tem mais nada pra marcar, o backfill acontece sozinho. A
tabela "O que ja esta salvo" (`renderizarTabelaChats()`) ganhou um terceiro
estado de badge, "completando historico antigo" (amarelo, como "parcial"),
pra deixar visivel quando um chat ainda esta nessa fase 1.

## "Mensagem com reacao suficiente nao aparecia no top reacoes" - causa e correcao

O usuario reportou ver mensagens no grupo que claramente tinham reacao
suficiente pra aparecer em "Ver top reacoes" mas nao apareciam. Causa:
`telaResultados()` chamava `buscarTop()` com `limite: 50` fixo, sem jeito
de pedir mais. Com um grupo especifico selecionado isso so corta a cauda
da lista (mensagens com pouca reacao ficam de fora, esperado). Mas com
"Todos os grupos" selecionado, `buscarTop()` mistura TODAS as mensagens de
TODOS os grupos num unico ranking global antes de cortar em 50 - uma
mensagem de um grupo menos ativo pode ficar fora dos top 50 globais mesmo
tendo mais reacao que mensagens exibidas de outro grupo mais movimentado.
Isso ja estava anotado como prioridade alta no backlog ("paginacao em Ver
top reacoes").

Corrigido: `telaResultados()` agora comeca com `limite: 50` mas tem um
botao "Mostrar mais" no fim da lista (so aparece quando a lista bateu no
limite atual) que aumenta o limite em 50 e recarrega. O limite volta pra
50 toda vez que o filtro de grupo ou o minimo de reacoes muda. Mesma ideia
que pagina de resultado de busca - carrega sob demanda, nao tudo de uma
vez.

## Marcar mensagem como "ja visto" (implementado)

Cada mensagem exibida em "Ver top reacoes" e "Buscar mensagens" agora tem
uma caixinha marcavel (`criarQuadradoMarcavel()`, a mesma tecnica de
`<div>` desenhado na mao do item anterior - sem depender de aparencia
nativa de checkbox) que marca o campo `visto: true/false` no registro da
mensagem, via `marcarVisto(db, key, visto)`. Controle 100% manual do
usuario, nao mexe em nada automatico - so guarda o estado pra ele
acompanhar o que ja checou. O item da lista fica com opacidade reduzida
(0.55) quando marcado como visto, pra destacar visualmente o que ainda nao
foi olhado. Testado em `test_indexeddb_logic.mjs` (marca, desmarca, chave
inexistente nao quebra).

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

## Busca avancada - pesquisa GLOBAL em canais/grupos publicos (implementado)

Usuario pediu uma busca separada da local (`buscarTexto()`, que so enxerga
o que ja foi escaneado): pesquisar por palavra-chave em canais/grupos
PUBLICOS que a conta nao participa, pra descobrir onde uma palavra aparece
sem precisar entrar no grupo primeiro. Ele mesmo reconheceu que grupo
fechado e praticamente impossivel - escopo certo, so grupo/canal aberto.

Pesquisei a API oficial do Telegram (core.telegram.org/api/search e
core.telegram.org/method/channels.searchPosts) antes de implementar.
Achados:

- Existe sim um metodo pra isso: `channels.searchPosts`, que faz busca
  "globalmente em todos os canais publicos" (inclusive os que a conta nao
  participa). Dois modos, exatamente um deles por chamada: `hashtag` (busca
  por hashtag, sem custo documentado) ou `query` (texto livre, busca full-
  text de verdade - esse e o que o usuario quer).
- **"Canal" aqui inclui supergrupo** - no namespace MTProto, tanto canal
  de transmissao quanto super grupo sao a mesma entidade `Channel`
  (diferenciados pelo campo `megagroup`). Como grupo basico do Telegram
  NUNCA pode ter @usuario publico (so supergrupo/canal pode), todo "grupo
  aberto" que o usuario quer achar ja e um supergrupo por definicao - entao
  o metodo cobre exatamente o caso dele, mesmo o nome sendo "channels".
- **Busca por texto livre nao e de graca ilimitada**: cada conta tem uma
  cota diaria gratis (campos `totalDaily`/`remains`, descobertos via
  `channels.checkSearchPostsFlood`), e depois dela cada busca cobra em
  Telegram Stars (`starsAmount`). A doc tambem lista `PREMIUM_ACCOUNT_REQUIRED`
  como erro possivel, mas nao deixa claro se e sempre assim ou so em algum
  caso especifico - **nao sei** se a conta do usuario vai conseguir usar
  sem Premium/sem pagar, por isso a tela mostra a cota real da conta dele
  antes de ele gastar uma busca, em vez de eu prometer que e de graca.
  Busca por hashtag nao tem esse aviso de custo na documentacao.
- `messages.searchGlobal` (o outro metodo candidato) NAO serve pra isso -
  ele busca dentro dos chats que a propria conta ja participa, nao em
  canal/grupo externo.

Implementacao (`telaBuscaAvancada()`, acessivel pelo botao "Busca avancada
(grupos/canais publicos)" em `telaLogado()`): mostra a cota atual de busca
por texto livre assim que abre a tela (`channels.CheckSearchPostsFlood`),
tem uma checkbox pra alternar entre hashtag e texto livre (reaproveitando
`criarQuadradoMarcavel()`), e um campo + botao que chama
`channels.SearchPosts({ hashtag ou query, offsetRate: 0, offsetPeer:
InputPeerEmpty, offsetId: 0, limit: 20 })`. O resultado traz `messages` +
`chats` juntos (sem precisar resolver entidade por fora) - cada mensagem
tem `peerId.channelId` que casa com o `id` de um dos chats retornados; a
partir dai da pra mostrar titulo, @usuario, se e canal ou supergrupo
(`chat.megagroup`), o trecho da mensagem, e um link `t.me/<usuario>` pra
abrir.

**Nao precisou de nenhuma mudanca pra rodar junto com o scan** - e so mais
uma chamada RPC na mesma conexao MTProto (`cliente.invoke(...)`), sem
nenhum estado compartilhado com `escanearTudo()`. Da pra abrir essa tela
com o scan rodando em segundo plano sem problema.

**Mudanca de infraestrutura**: essa foi a primeira vez que o painel
precisou chamar a API crua do Telegram por fora dos metodos de
conveniencia do teleproto (`iterDialogs`, `iterMessages`, etc.), entao o
bridge (`entry.js`) passou a exportar tambem `Api` (de
`teleproto/tl/api.js`), alem de `TelegramClient`/`StringSession`/
`PromisedWebSockets` que ja exportava. Precisou rodar `node build.mjs` de
novo (regerar o `bundle.js`) antes de `node montar_userscript.mjs` - diferente
das mudancas anteriores, que só mexiam em `painel_logic.js` e não exigiam
reconstruir o bundle do teleproto.

**Testado com a conta real do usuario: bloqueado por falta de Telegram
Premium.** Primeira tentativa (texto livre) deu
`PREMIUM_ACCOUNT_REQUIRED (caused by channels.SearchPosts)` direto, sem
nem chegar a consumir cota. Usuario estranhou - foi olhar a lista de
recursos Premium do proprio Telegram e nao achou essa busca la, pediu pra
verificar nas fontes de novo.

Achei a confirmacao no proprio blog oficial do Telegram
(telegram.org/blog/post-search-story-albums-and-more, anuncio de
ago/2025, que introduziu essa busca global de posts): "Post search is
initially available to Telegram Premium users." Ou seja: nao e uma
confusao nossa nem erro de configuracao - e uma restricao de rollout do
proprio Telegram, deliberada e documentada por eles (a palavra "initially"
sugere que pode abrir pra conta free no futuro, sem prazo dito). O
usuario tinha razao em estranhar: e um recurso tao novo que ainda nao
aparece listado nas telas de "o que o Premium inclui" do app/site, mas
esta descrito no blog oficial deles.

Pratico: sem Telegram Premium, a tela de busca avancada nao funciona
(nem por hashtag, bloqueio e no nivel do metodo inteiro, nao so no modo
texto livre) - so o aviso na tela foi ajustado pra deixar isso explicito
em vez da redacao antiga, que sugeria cota gratis disponivel mesmo sem
Premium. Nenhuma mudanca de codigo alem do texto do aviso: a chamada
`channels.SearchPosts` em si esta correta, so a conta nao tem permissao
do lado do servidor do Telegram. Se o usuario um dia assinar Premium, a
tela ja funciona sem precisar mexer em nada - e so a Telegram liberar do
lado deles.

**Atualizacao**: ganhou paginacao de verdade (botao "Carregar mais"),
seguindo a receita de paginacao da propria doc da API: `offsetRate` vira o
`nextRate` da resposta anterior (ou a data da ultima mensagem, se
`nextRate` nao vier), e `offsetPeer`/`offsetId` viram o peer+id da ultima
mensagem recebida (o peer e montado como `InputPeerChannel` usando
`accessHash` do chat, que a propria resposta ja devolve na lista `chats` -
nao precisa resolver entidade por fora). Segundo a doc, chamada de pagina
seguinte de uma busca ja iniciada nao conta na cota diaria gratis - so o
primeiro pedido de cada busca nova consome.

## "Buscar mensagens" preso no primeiro grupo quando a palavra e comum (corrigido)

Usuario reportou: buscando uma palavra comum com "Todos os grupos"
selecionado, so aparecia resultado de um grupo; selecionando aquele outro
grupo especifico manualmente, os resultados dele apareciam. Causa:
exatamente a mesma classe de bug do "top reacoes" (`limite` fixo + ordem de
iteracao por chat), so que em `buscarTexto()` em vez de `buscarTop()`.

Sem `chatId`, o cursor de `buscarTexto()` percorre a loja `mensagens` pela
chave primaria (`chatId:messageId`), que ordena por ordem lexicografica de
string - ou seja, visita TODAS as mensagens de um grupo antes de passar
pro proximo (o "A" de um chatId vem antes do "Z" de outro, por exemplo). A
busca parava assim que `resultados.length >= limite` (100, fixo) - se o
primeiro grupo sozinho ja tivesse 100+ mensagens batendo com o termo, o
cursor nunca chegava nos outros grupos. Reproduzido e confirmado em
`test_indexeddb_logic.mjs` (grupo "A" com 5 mensagens batendo, grupo "Z"
com 1: `limite: 3` fica preso no A, `limite: 10` alcanca o Z).

Corrigido com o mesmo padrao ja usado em `telaResultados()`: "Mostrar
mais" no fim da lista, que aumenta o `limite` e busca de novo (deixa o
cursor andar o suficiente pra sair do primeiro grupo). Resetado pra 100
toda vez que o termo, grupo, ordenacao ou minimo de reacoes muda.

## "Buscar mensagens" - filtros, ordenacao e agrupamento (evolucao pedida pelo usuario)

Junto com o fix acima, o usuario pediu uma geral na tela de busca: filtro
de minimo de reacoes (`buscarTexto()` ganhou o parametro `minimo`, mesmo
padrao de `buscarTop()`), ordenacao por mais recente ou mais reacoes
(parametro `ordenarPor: "data" | "reacoes"`), e, quando a busca e em
"Todos os grupos" e o resultado tem mais de um grupo, um agrupamento
visual com cabecalho clicavel por grupo (maximizar/minimizar, seta ▾/▸)
em vez de uma lista unica misturada.

`agruparPorChat(mensagens)` faz esse agrupamento preservando a ordem de
PRIMEIRA aparicao de cada chat na lista ja ordenada - ou seja, o grupo que
contém o resultado mais relevante (primeiro pela ordenacao escolhida)
aparece primeiro, e a ordem interna de cada grupo respeita a mesma
ordenacao geral. So ativa esse modo quando `chatId` do filtro esta vazio
E os resultados realmente tem mais de um chat distinto - selecionando um
grupo especifico continua mostrando lista simples, sem cabecalhos.

## Botao flutuante "voltar ao topo" (pedido geral de navegacao)

Usuario reportou ter que rolar manualmente ate o topo do painel depois de
descer numa lista longa de resultado. Pediu uma das duas opcoes: botao
flutuante de voltar ao topo, OU cabecalho fixo com só a lista rolando.
Optei pela primeira - e mais simples de implementar sobre a estrutura
atual (o painel inteiro e um unico bloco com `overflow: auto`, cabecalho e
corpo juntos; fixar só o cabecalho exigiria separar isso em dois
containers de rolagem) e resolve o problema de forma mais direta (volta
pro topo de QUALQUER tela, nao so deixa o cabecalho visivel).

`adicionarBotaoTopo()` cria um botao circular "↑" com `position: fixed`,
filho direto do `painel` (nao de `#trp-corpo`) - por isso sobrevive a troca
de tela (que só limpa o `#trp-corpo`) e some sozinho quando o painel fecha
(`painel.remove()` leva os filhos junto). Chamado uma vez em
`montarPainel()`, ao lado de `renderizarCabecalho()`. Clique faz
`painel.scrollTop = 0`.

## Busca nativa achou mensagem que a nossa busca local nao achou - nova tela "Verificar mensagem"

Usuario reportou (com prints) que buscando "arlene" no grupo "Orfãos Do
Exclusivo", a busca nativa do Telegram (escopo "This Group") achou 3
resultados e a nossa "Buscar mensagens" achou 5 - mas os conjuntos nao
batiam: a nossa achava coisas que a nativa nao achava (esperado, e
diferenca de substring vs palavra-inteira, ver secao mais acima), MAS a
nativa tambem achava pelo menos uma mensagem ("Deleted Account", texto
"...arlene1ee...") que nao aparecia em NENHUM dos nossos 5 resultados.
Isso e diferente de "algoritmo de busca difere" - se a mensagem existe e
bate com o termo mas nao esta nos nossos resultados, ou ela nao foi
escaneada (buraco de cobertura), ou foi escaneada com o texto errado/vazio.

Theory sem confirmar (NAO proseguida): tentei estimar, so pelo log de
console colado pelo usuario (que mostra `lastScannedMessageId` subindo
429318 -> 966151 -> 1085413 ao longo de varias rodadas de scan desse
grupo, com o backfill do historico antigo ja concluido,
`textoCompletoAte === backfillAlvo`), se a mensagem em questao
simplesmente ainda nao tinha sido alcancada pelo scan incremental. Nao da
pra concluir isso so pelo log - precisaria do ID exato da mensagem em
questao, que nao aparece no print nem no log. Em vez de chutar, criei uma
ferramenta pra responder isso com certeza, pra esse caso e qualquer outro
parecido no futuro.

**Nova tela "Verificar mensagem (local vs. ao vivo)"**: usuario escolhe o
grupo (so aparecem os ja escaneados), cola o link da mensagem (ou so
digita o ID - a tela tenta reconhecer o formato `t.me/c/<id>/<msg>` e
tambem o link que o nosso proprio botao "abrir" gera,
`web.telegram.org/...#<id>?post=<msg>`, preenchendo o campo de ID e
selecionando o grupo certo sozinha quando reconhece) e clica "Verificar".
A tela mostra dois blocos lado a lado:

- **No nosso banco local**: existe ou nao (`buscarMensagem()`, novo
  helper, get direto pela chave `chatId:messageId` na loja `mensagens`);
  se existe, mostra texto/data/reacoes salvos.
- **Ao vivo no Telegram agora**: busca a mensagem de verdade via
  `cliente.getMessages(entidade, { ids: [messageId] })` (mesmo client
  MTProto que o scan usa) e mostra texto/data/reacoes atuais.
  `encontrarEntidadePorChatId()` (novo helper) itera os dialogs da conta
  ate achar o `entity` certo pra passar pro `getMessages` - precisa disso
  porque nao da pra montar o `InputPeer` so com o chatId numerico sem o
  `access_hash`, que so vem iterando os dialogs (mesma limitacao que ja
  existia na busca avancada).

Se der "nao encontrada" no local E "existe" no ao-vivo, a tela avisa na
hora: isso confirma um buraco real de scan (nao falta so rodar o scan de
novo se o scan incremental ja passou da data - nesse caso sim seria bug
de verdade). Se os dois "existem" mas o texto bate diferente, avisa que
provavelmente foi editada depois do scan (ou falhou a captura na hora).

Isso NAO resolve sozinho o caso especifico que o usuario reportou -
resolve a FERRAMENTA de diagnostico. Falta ele rodar "Verificar mensagem"
com o grupo + ID da mensagem "Deleted Account" (ou a "Vitor", 25/03/2025)
pra saber de verdade se e buraco de scan ou outra coisa, antes de decidir
se precisa mexer em mais alguma coisa.

## Erro "Erro de seguranca ... file:///" no console, associado ao grupo "Vip OF"

Usuario colou um log de console com essa linha, associada ao chatId
`-1002621491696` ("Vip OF"):
`Erro de seguranca: O conteudo em https://web.telegram.org/k/#-2621491696
nao pode carregar nem criar link para file:///.`

Reparando no formato: o link que a nossa `idBaseDoChatId()` gera pra esse
chatId seria `2621491696` (tira o "-100" do inicio, sem sinal nenhum) +
`?post=<id da mensagem>` no final. O que aparece no erro e
`-2621491696`, SEM o `?post=...` e COM um sinal de "-" que a nossa funcao
nunca deixaria sobrar nesse caso. Ou seja, esse texto de URL no erro nao
bate com o que o nosso codigo gera - tudo indica que e o proprio
Telegram Web reescrevendo/reinterpretando o hash da pagina (por exemplo,
ao tentar resolver um chat que ainda nao esta no cache local dele) e
falhando sozinho, nao um bug na nossa `idBaseDoChatId()` ou no botao
"abrir". Nao investiguei mais fundo porque e um erro que vem de dentro do
proprio app do Telegram, fora do nosso controle - se continuar
acontecendo especificamente ao clicar "abrir" num resultado desse grupo,
vale abrir o grupo manualmente uma vez direto no Telegram antes de tentar
o link, mas isso e especulacao, nao confirmado.

## "Vip OF" com backfill do historico antigo incompleto no log

Log colado pelo usuario mostrou, pra esse chat, `textoCompletoAte: 158638`
contra `backfillAlvo: 163202` - ou seja, a Fase 1 (completar texto do
historico antigo) ainda nao tinha terminado nesse grupo na hora do log.
Isso e esperado/normal (a Fase 1 avanca aos poucos, salvando checkpoint a
cada 500 mensagens, e continua de onde parou na proxima vez que o scan
rodar) - nao e bug, so precisa deixar o scan rodar mais.

## "Buscar mensagens" com mais de uma palavra sumia com resultados (corrigido)

Usuario testou a nova tela "Verificar mensagem" buscando "arlene lee" (duas
palavras) no mesmo grupo onde antes tinha buscado so "arlene", e achou que
"ficou pior" - so 1 resultado em vez dos 5 anteriores. Nao era regressao de
nenhuma mudanca dessa sessao: era `buscarTexto()` tratando o termo inteiro
como UMA substring so, exigindo que "arlene" e "lee" aparecessem juntas,
coladas, nessa ordem exata, no texto. "Arlene Lee" bate; uma mensagem tipo
"Lee, viu novidade da Arlene?" (as duas palavras presentes, mas separadas e
fora de ordem) nao batia - e e exatamente esse tipo de mensagem que some
quando voce refina a busca com mais uma palavra.

Corrigido: o termo agora e dividido em palavras (por espaco) e cada uma e
checada separada contra o texto - a mensagem entra no resultado se TODAS as
palavras aparecerem em qualquer lugar do texto (E logico), nao precisa
estar juntas nem na mesma ordem. Busca de uma palavra so continua
identica a antes (array de 1 palavra so). Teste novo em
`test_indexeddb_logic.mjs` reproduz o caso: mensagem com "lee" antes de
"arlene" e sem estarem juntas agora e encontrada buscando "arlene lee",
mensagem so com "arlene" (sem "lee") continua de fora.

## Numero de versao visivel no topo do painel (pedido do usuario)

Usuario testou a correcao acima, confirmou que tinha atualizado o
userscript no Tampermonkey, e mesmo assim viu o mesmo resultado (1
mensagem) de antes da correcao - sem jeito de saber, so olhando, se era
"a correcao nao resolveu" ou "o Tampermonkey nao pegou a versao nova de
verdade". Pediu um numero de versao visivel no proprio painel pra isso
ficar claro de cara.

`montar_userscript.mjs` agora tem uma unica constante `VERSAO` (formato
`AAAA.MM.DD.N`, N = numero da entrega naquele dia) usada em DOIS lugares:
o `@version` do cabecalho `==UserScript==` (o que o proprio Tampermonkey
mostra no dashboard dele, em "gerenciar extensoes") e uma linha
`window.TRP_VERSAO = "..."` injetada entre o bundle do teleproto e o
`painel_logic.js`. `painel_logic.js` le isso em `VERSAO_PAINEL` e mostra
"v2026.10.08.1" ao lado do titulo "Top Reacoes" no cabecalho do painel -
que fica fixo em toda tela (`renderizarCabecalho()` e chamado uma vez em
`montarPainel()`, nao por tela).

**IMPORTANTE pra manutencao futura**: a partir de agora, BUMP a constante
`VERSAO` em `montar_userscript.mjs` toda vez que gerar uma entrega nova
(mesmo dia, N+1; dia novo, N=1) e rodar `node montar_userscript.mjs` de
novo antes de entregar. Sem isso o numero fica parado e perde a
utilidade.

Sobre o caso especifico que gerou esse pedido (1 resultado pra "arlene
lee" mesmo depois de atualizar): com a correcao de palavras separadas (E
logico), "Darlene amaro" e "Marlene soares" contem a substring "arlene"
(ex.: "d-ARLENE", "m-ARLENE") mas NAO contem "lee" em lugar nenhum - entao
o filtro corretamente as exclui ao buscar "arlene lee". Se no banco local
so existe 1 mensagem com as duas palavras ao mesmo tempo, 1 resultado e o
numero certo, nao e bug nem reaparecimento do problema antigo. Isso e
DIFERENTE do problema ja levantado antes (busca nativa achando mensagem
que o nosso scan nao tem) - aquele continua em aberto e precisa ser
checado com a tela "Verificar mensagem", nao foi resolvido nem afetado por
essa correcao de busca com varias palavras.

## Busca com varias palavras: de E logico pra OU logico (pedido do usuario)

Depois de entender o "so 1 resultado" acima, usuario deu uma instrucao
clara sobre como quer essa ferramenta: mais ampla, de proposito. No
conceito dele, buscar "arlene lee" DEVE continuar trazendo "Darlene
amaro"/"Marlene soares" (que so tem "arlene", nao tem "lee") - ele prefere
resultado a mais (filtra visualmente depois) a resultado a menos, porque o
problema real que motivou tudo isso e mensagem que deveria aparecer e nao
aparece, nunca o contrario.

Troquei `buscarTexto()` de E logico (`palavras.every(...)`, exigia TODAS
as palavras) pra OU logico (`palavras.some(...)`, basta UMA aparecer).
Busca de uma palavra so continua identica (sempre foi so substring). Teste
em `test_indexeddb_logic.mjs` atualizado: "arlene lee" agora acha as 3
mensagens que tem pelo menos uma das palavras (incluindo a que so tem
"arlene" sem "lee"), e so exclui a que nao tem nenhuma das duas.

Reforcando o que o usuario deixou explicito: essa mudanca e sobre
PRECISAO da busca (quanto ela filtra), nao tem nada a ver com o problema
de COBERTURA do scan (mensagem que a busca nativa acha e a nossa nem tem
salva) - aquele segue em aberto, ver secao "Verificar mensagem" acima.

## Busca hibrida: "Buscar mensagens" tambem pergunta ao vivo pro servidor (pedido do usuario)

Usuario perguntou se dava pra usar os dois sistemas de busca (nosso banco
local + a busca nativa do Telegram) ao mesmo tempo, depois de eu explicar
(com pesquisa em bugs.telegram.org, GitHub do tdlib e de um projeto
parecido, SearchGram) que sao dois mecanismos completamente independentes:
o nativo e 100% server-side (confirmado por um mantenedor do TDLib - "o
client nao tem como melhorar isso"), o nosso so enxerga o que ja esta no
IndexedDB local.

Resposta: sim, e da pra fazer sem reinventar nada - `cliente.iterMessages`
(a mesma funcao ja usada no scan) aceita uma opcao `search` que, por
baixo, dispara exatamente o `messages.Search` que a busca nativa usa
(confirmado lendo `node_modules/teleproto/client/messages.js` - quando
`search` e passado, o proprio teleproto monta o request de
`Api.messages.Search` com `filter: InputMessagesFilterEmpty`, do mesmo
jeito que a busca "dentro do grupo" do app).

Na tela "Buscar mensagens", nova caixinha "Tambem buscar ao vivo no
servidor do Telegram" (so funciona com um grupo especifico selecionado,
nao com "Todos os grupos" - evita uma chamada por grupo escaneado e risco
de flood wait). Quando marcada, `executarBusca()` roda os dois em
paralelo conceitual: `buscarTexto()` no banco local (do jeito de sempre) e
`buscarAoVivoNoServidor()` (novo helper, usa `encontrarEntidadePorChatId()`
que ja existia da tela "Verificar mensagem") perguntando pro servidor.
Resultado que so o servidor achou (nao estava no local, dedupe por
`chatId:messageId`) e **salvo na hora** via `salvarMensagem()` - ou seja,
a busca hibrida tambem conserta sozinha, na pratica, o tipo de buraco de
scan que motivou a tela "Verificar mensagem" (sem precisar rodar o scan
inteiro de novo so por causa de uma mensagem). Esses itens aparecem na
lista com uma marca verde "achado ao vivo no servidor, salvo agora" pra
ficar claro que e novo.

Falha na busca ao vivo (chat nao resolvido, erro de rede, etc.) nao quebra
a busca local - aparece so um aviso em vermelho acima dos resultados
locais, que continuam normais.
