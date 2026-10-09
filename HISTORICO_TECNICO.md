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

## Causa raiz de toda a confusao de versao: metodo de atualizacao nunca funcionou

Depois de varias entregas parecendo "nao fazer efeito", descobrimos a
causa: o usuario estava atualizando copiando o conteudo inteiro do
`painel_telegram.user.js` (8+ MB de texto) do Bloco de Notas e colando
direto no editor do Tampermonkey (Firefox). Um arquivo desse tamanho
colado via Ctrl+V numa caixa de texto de extensao de navegador e um
tamanho fora do normal pra esse tipo de campo - trava, corta ou mistura
com o conteudo antigo sem avisar erro nenhum. Confirmado: a aba do editor
mostrava "Telegram Top Reacoes - Painel **2.0.0**" - a versao original, de
antes dessa sessao inteira. Ou seja, NENHUMA correcao feita nesta sessao
tinha rodado de verdade no navegador do usuario ate esse ponto - toda a
discussao sobre "ficou pior"/"nao mudou nada" foi, na pratica, sempre
contra o codigo antigo.

Jeito certo de instalar sem copiar/colar: Tampermonkey Dashboard → aba
"Utilitarios" → "Importar do arquivo" → escolhe o `.user.js` direto do
disco.

## Atualizacao automatica via @updateURL/@downloadURL (pedido do usuario)

Usuario perguntou se dava pra nao precisar trazer o arquivo manualmente
toda vez. Solucao: Tampermonkey suporta `@updateURL`/`@downloadURL` no
cabecalho `==UserScript==` - aponta pra uma URL http(s), e o proprio
Tampermonkey confere periodicamente (ou na hora, com "Check for userscript
updates" no Dashboard) se o `@version` de la e mais novo que o instalado,
oferecendo atualizar sozinho.

Nao tem repositorio remoto (git sem remote configurado) nem motivo pra
criar um so pra isso, entao a URL aponta pra um servidor HTTP local:
`http://localhost:8787/painel_telegram.user.js`. `montar_userscript.mjs`
ganhou a constante `URL_ATUALIZACAO` (mesma ideia de fonte unica que
`VERSAO`) injetada nas duas linhas novas do cabecalho.

Criado `iniciar_servidor_userscript.bat` na raiz do projeto (.bat sem
emoji, como preferido) - so entra na pasta `painel_build` e sobe
`python -m http.server 8787` (ja confirmado instalado na maquina do
usuario, nao precisa instalar nada). Precisa estar rodando no momento em
que o Tampermonkey checar - se nao estiver, a checagem so falha em
silencio, sem quebrar nada, e tenta de novo na proxima vez (automatica ou
manual).

**Esse metodo ainda exige UMA ultima importacao manual** (via "Importar
do arquivo", nao copia/cola) - e so depois dela, com o `@updateURL` ja
dentro do script instalado, que o Tampermonkey passa a saber aonde olhar
sozinho. Depois dessa vez, o fluxo normal vira: liga o `.bat`, abre o
Tampermonkey Dashboard, pede "Check for userscript updates" no script
"Telegram Top Reacoes - Painel", confirma a atualizacao se aparecer, e so
ai da F5 no Telegram Web.

## Preparacao pra publicar no GitHub (conta pessoal do usuario)

Usuario confirmou que tem GitHub e quer usar a conta pessoal dele -
decisao explicita dele: ou ele mesmo cria+sobe o repositorio, ou pede pra
aba do Claude pessoal dele fazer isso. Esta sessao (contexto
INFLEET/trabalho) NAO cria nem faz push do repositorio - so deixa tudo
pronto.

Verificacoes feitas antes de recomendar repo publico:
- `git remote -v` → vazio, nenhum remote configurado ainda.
- `.gitignore` ja exclui `.env`, `data/*.session`, `data/*.session-journal`,
  `data/*.db`, `grupos_para_escanear.txt` - nada sensivel versionado.
- `git status` limpo (so o `commit_message.txt` de rotina, nao rastreado).
- Encontrado um `painel_telegram.user.js` **duplicado na raiz** do
  projeto (fora de `painel_build/`) - `findstr /C:"@version"` nao achou
  nada nele, confirmando que e um arquivo antigo, de antes da convencao de
  versionamento, nunca tocado pelo pipeline de build (`montar_userscript.mjs`
  so escreve em `painel_build/painel_telegram.user.js`). Removido via
  `git rm` (fica preservado no historico do git, so sai da arvore atual).

Resposta tecnica pra pergunta do usuario ("so iria pro git se me poupar
de rodar o .bat toda vez, e se for melhor tecnicamente"): repo **publico**
no GitHub resolve os dois lados - `raw.githubusercontent.com` fica sempre
no ar (ao contrario de `localhost:8787`, que so responde com o `.bat`
aberto), entao o `@updateURL` passa a funcionar sem nada rodando na
maquina do usuario. Repo **privado** nao serve pra isso: a checagem do
Tampermonkey e uma requisicao HTTP sem autenticacao, e o raw de repo
privado exige token - sem token, o Tampermonkey so falha a checagem em
silencio.

`README.md` ganhou a secao "Publicar no GitHub" com os comandos exatos
(`gh repo create ... --public --source=. --remote=origin --push`, e a
alternativa manual com `git remote add` + `git push`). Depois que o repo
existir, falta so: atualizar `URL_ATUALIZACAO` em `montar_userscript.mjs`
pra `https://raw.githubusercontent.com/<usuario>/<repo>/<branch>/painel_build/painel_telegram.user.js`,
rodar `node montar_userscript.mjs` de novo, e importar manualmente **mais
essa uma ultima vez** - da em diante o Tampermonkey confere sozinho
direto no GitHub, sem `.bat` nenhum.

## Publicado no GitHub: github.com/lohrangm/TLGR-TR

Repositorio criado pelo usuario (publico, vazio) e o push inicial feito
direto desta sessao via `windows-cli`, sem precisar do `gh` nem da sessao
pessoal do Claude do usuario.

Detalhe encontrado no processo: havia uma credencial git antiga pro
GitHub salva no Gerenciador de Credenciais do Windows, sob o usuario
**lohranmagno** - mas o repositorio criado e o GitHub pessoal do usuario
sao sob o usuario **lohrangm** (bate com o e-mail pessoal dele,
lohrangm@gmail.com). Primeira tentativa de push falhou com 403
("Permission to lohrangm/TLGR-TR.git denied to lohranmagno") exatamente
por essa divergencia de contas. Resolvido apagando a credencial antiga
(`cmdkey /delete:LegacyGeneric:target=git:https://github.com`) e tentando
o push de novo - dessa vez o Windows/Git Credential Manager autenticou
corretamente (sem precisar de nenhuma acao manual visivel do usuario) e o
push foi confirmado via `git ls-remote origin` batendo com o commit local.

Depois do push: `URL_ATUALIZACAO` em `montar_userscript.mjs` atualizada
pra `https://raw.githubusercontent.com/lohrangm/TLGR-TR/master/painel_build/painel_telegram.user.js`,
versao bumped pra `2026.10.08.5`, `.user.js` regerado. `iniciar_servidor_userscript.bat`
removido do repositorio (fica preservado no historico do git) - deixou de
fazer sentido existir, ja que o servidor local que ele subia nao e mais o
que o `@updateURL` consulta. README.md atualizado pra refletir o fluxo
atual (sem mencionar mais o `.bat`).

Fluxo de atualizacao daqui pra frente: editar `painel_logic.js` (ou o que
for), `node montar_userscript.mjs`, commit + push - sem nenhuma importacao
manual nem servidor local. O Tampermonkey confere sozinho direto no
`raw.githubusercontent.com`.

## v2026.10.08.6: scroll do "Mostrar mais", filtro de periodo e configuracao de grupos do scan

Tres pedidos do usuario depois de testar a v2026.10.08.5 em produção.

**"Mostrar mais" jogando pro topo da tela**: causa encontrada no DOM, nao
no app em si - `executarBusca()`/`atualizarLista()` esvaziam a lista
(`lista.innerHTML = "Carregando..."`) antes de buscar de novo. Como o
painel inteiro e um unico container com `overflow:auto`, esvaziar a lista
encolhe a altura do conteudo abaixo do scroll atual, e o navegador trava o
`scrollTop` em 0 sozinho nesse instante - quando a lista cheia volta, o
scroll nao volta pra onde estava. Conserto: no clique do botao "Mostrar
mais" (so ali, nao no botao "Buscar" normal, onde ir pro topo faz
sentido), guarda `painel.scrollTop` antes e restaura depois do
`await executarBusca()`/`await atualizarLista()`. Corrigido nas duas telas
que tem esse botao (Buscar mensagens e Ver top reacoes).

**Filtro de periodo em "Buscar mensagens"**: dois campos `<input
type="date">` (De/Ate), ambos opcionais. `buscarTexto()` ganhou os
parametros `dataDe`/`dataAte`, comparados contra `dateUtc.slice(0,10)`
(formato ISO, comparavel como string). A busca ao vivo no servidor
continua salvando TUDO que acha de novo (auto-cura de buraco de scan
independente do filtro de data escolhido na hora) - o filtro de data so
afeta o que e EXIBIDO como "achado agora", nunca o que e salvo. Mirror em
`test_indexeddb_logic.mjs` atualizado com os mesmos parametros e testes
novos usando os 4 registros da arlene/lee ja existentes (filtra so o
meio, so `dataDe` sem `dataAte`, etc.) - todos passando.

**Configurar grupos do scan**: ate aqui, "Todos" no scan significava
literalmente todo grupo/canal da conta, sem jeito de tirar um
permanentemente (diferente da versao Python antiga, que tinha
`grupos_para_escanear.txt`). Nova tela "Configurar grupos do scan
(incluir/excluir)", acessivel pelo menu principal: lista todos os
grupos/canais (mesma fonte que a tela de scan usa,
`carregarGruposParaSelecao()`), um quadrado marcavel por grupo. So
guarda a lista de EXCLUIDOS (`GM_setValue`/`trp_grupos_excluidos`, JSON de
chatIds) - por desenho, assim grupo novo que a conta entrar aparece la
automaticamente ja incluido, sem precisar marcar nada toda vez. Escolher
um grupo especifico no dropdown da tela de scan ignora essa lista (sempre
escaneia o que foi escolhido na hora, mesmo que esteja desmarcado na
configuracao) - a exclusao so vale pro "Todos".

Pendente, discutido mas NAO implementado (usuario marcou como baixa
prioridade): deteccao automatica de "esse grupo tem mensagem nova desde o
ultimo scan" comparando a data da ultima mensagem real do chat com
`lastScannedAt`/`lastScannedMessageId` guardado. Hoje a unica forma de
saber e rodar o scan de novo. Fica como ideia pra quando ele quiser.

Tambem esclarecido (sem mudanca de codigo): a "Busca avancada
(grupos/canais publicos)" usa `channels.SearchPosts`, busca server-side
100% controlada pelo Telegram - mesma limitacao de tokenizacao por palavra
inteira (sem match parcial) documentada pra busca nativa deles
(bugs.telegram.org/c/724). Nao da pra tornar mais inteligente do nosso
lado porque nao temos o texto bruto de canais publicos que a conta nao
participa - so o que a API ja devolve filtrado.

## v2026.10.08.7: setinha de navegacao invisivel, scroll ainda instavel, confirmacao sobre acesso a grupo fechado

**Setinha "voltar ao topo" sumida**: achada a causa real. Ela era filha de
`painel`, que tem `overflow:auto` - e um elemento `position:fixed` filho
de um ancestral com overflow diferente de `visible` fica RECORTADO pelos
limites visuais desse ancestral, mesmo a posicao sendo calculada em
relacao a viewport (isso e comportamento de CSS, nao bug de navegador
especifico). Como o painel tem `maxHeight:80vh` comecando em `top:40px`,
na maioria dos tamanhos de janela o botao (fixado a `bottom:24px` da
viewport) cai fisicamente fora da caixa do painel e simplesmente nao
pinta - so apareceria em janelas muito baixas. Conserto: os botoes de
navegacao agora sao filhos de `document.body`, nao do `painel` -
`adicionarBotoesNavegacao()`/`removerBotoesNavegacao()` substituem a
antiga `adicionarBotaoTopo()`, e `alternarPainel()` remove os dois na mao
ao fechar (ja que nao saem mais de graca junto com `painel.remove()`).
Aproveitado pra adicionar a setinha "↓ pro fim" simetrica, pedida pelo
usuario.

**"Mostrar mais" ainda ocasionalmente jogando pro topo** mesmo depois do
conserto da v2026.10.08.6: a hipotese e que atribuir `painel.scrollTop`
logo em seguida ao `await` (sincrono, no mesmo tick) pode rodar antes do
navegador terminar de recalcular o layout da lista inteira recarregada,
principalmente com bastante item novo de uma vez - aí o proprio navegador
re-clampa o scroll depois, por conta propria. Novo helper
`restaurarScrollDepoisDoReflow()` usa dois `requestAnimationFrame`
encadeados (padrao conhecido pra isso) em vez de atribuir direto, pra so
restaurar depois de garantir que pelo menos um ciclo completo de
layout+pintura ja rodou. Aplicado nos dois lugares (Buscar mensagens e
Ver top reacoes).

Confirmado, sem mudanca de codigo, que a "Busca avancada" nunca teve o
bug do scroll: ela usa paginacao por cursor do lado do servidor
(`channels.SearchPosts` com `offsetRate`/`offsetPeer`/`offsetId`) e o
"Carregar mais" dali so ANEXA os itens novos no fim da lista existente -
nunca esvazia `lista.innerHTML` pra recarregar tudo, que era a causa raiz
do problema nos outros dois. Por isso nunca precisou do mesmo conserto.

**Pergunta do usuario, respondida sem mudanca de codigo**: nao, nenhuma
das ferramentas de busca alcanca conteudo de grupo FECHADO que a conta
nao participa. "Busca avancada" so alcanca canal/supergrupo PUBLICO (com
@usuario) - e limite do proprio metodo oficial do Telegram
(`channels.SearchPosts`), nao so configuracao nossa. Pra grupo fechado,
o protocolo MTProto exige ser participante (ter o access_hash do chat)
pra sequer pedir uma mensagem de la - nao e uma lacuna de busca, e
controle de acesso de base do proprio Telegram. no caso dele poder
acessar implicaria em ser adicionado ao grupo.

## v2026.10.08.8: estrutura do painel refeita (header fixo + area rolavel separada), causa raiz do salto do "Mostrar mais"

A v2026.10.08.7 tentou dois consertos e os dois saíram errados, confirmado
pelo usuario: a setinha "↑" (movida pra filha de `document.body`) passou a
aparecer sobreposta em cima do titulo "Top Reacoes" do proprio painel em
vez de flutuar no canto inferior direito da tela, a setinha "↓" nova ficou
totalmente invisivel, e o "Mostrar mais" continuou ocasionalmente jogando
pro topo mesmo com o `restaurarScrollDepoisDoReflow()` (dois
`requestAnimationFrame` encadeados).

**Causa da setinha errada**: a hipotese (nao 100% confirmavel sem acesso
ao DOM real do Telegram Web, mas consistente com o sintoma) e que algum
ancestral de `document.body` na propria pagina do Telegram tem
`transform`/`filter`/propriedade parecida, o que redefine a base de
calculo de um `position:fixed` - em vez de ser relativo a viewport real,
passa a ser relativo a esse ancestral transformado. Botao fixo filho de
`document.body` ficou refem dessa estrutura, fora do nosso controle.

**Conserto definitivo**: reestruturado `painel` de uma caixa unica com
`overflow:auto` pra um flex-column com dois andares - o cabecalho
(`renderizarCabecalho()`, sempre visivel, fora da area de scroll) e uma
nova `div#trp-area-rolavel` (`overflow:auto;flex:1;min-height:0`), unica
parte que de fato rola. `corpoDoPainel()` passou a montar `#trp-corpo`
dentro de `areaRolavel`, nao mais direto em `painel`. As setinhas voltaram
a ser filhas do proprio `painel` (que tem `position:fixed` confirmado
funcionando desde sempre), usando `position:absolute` - um absolute usa o
ancestral posicionado mais proximo como referencia, que e o proprio
painel, entao fica imune a qualquer coisa estranha que exista mais acima
na pagina do Telegram. `painel.remove()` continua levando tudo junto
(area rolavel e os dois botoes), sem precisar remover nada na mao.

**Causa raiz real do salto do "Mostrar mais" (dessa vez resolvida sem
"restaurar" scroll nenhum)**: tanto `atualizarLista()` (Ver top reacoes)
quanto `executarBusca()` (Buscar mensagens) reescreviam
`lista.innerHTML` pra um texto tipo "Carregando..."/"Buscando..." ANTES
do fetch assincrono (IndexedDB e/ou busca ao vivo no servidor), e so
reconstruiam a lista cheia depois que os dados chegavam. Entre essas duas
pontas existe um `await` real (o navegador cede o controle), e nesse
intervalo ele pode pintar a lista vazia - encolhendo a altura do
conteudo - e so ai o `scrollTop` da area rolavel acaba clampado/zerado
por conta propria. Tentar "restaurar" depois (sincrono na v6, com duplo
`requestAnimationFrame` na v7) as vezes nao bastava porque o salto podia
acontecer em momentos variaveis do reflow, dependendo de quao pesada era
a lista nova.

Conserto que elimina o problema na raiz em vez de compensar depois: as
duas funcoes so mostram "Carregando..."/"Buscando..." quando a lista
*ja* esta vazia (primeira carga/busca) - em "Mostrar mais" ou troca de
filtro, o conteudo ANTIGO fica exibido sem nenhuma mudanca ate os dados
novos estarem prontos. O conteudo novo e montado inteiro num
`DocumentFragment` fora da tela (nenhum filho de `lista` chega a mudar
durante isso); so no final e que `lista.innerHTML = ""` seguido de
`lista.appendChild(novoConteudo)` acontece, sincrono, sem nenhum `await`
no meio. O navegador nunca chega a pintar um estado intermediario vazio,
entao nunca existe scroll nenhum pra clampar ou restaurar -
`restaurarScrollDepoisDoReflow()` e o guardar/restaurar `painel.scrollTop`
foram removidos, ficaram sem uso.

Versao 2026.10.08.8.

## v2026.10.08.9: barra de rolagem horizontal, setinhas so quando tem rolagem de verdade, filtro de periodo tambem em "Ver top reacoes", texto sobre Premium/hashtag corrigido

Confirmado o motivo de a v2026.10.08.8 nao ter aparecido pro usuario: o
Tampermonkey (5.5.0) nao tinha buscado atualizacao desde a primeira vez -
nao existe um botao direto de "check for updates" na aba Utilitarios
dessa versao. Resolvido reimportando o arquivo .user.js direto pela
mesma aba ("Importar do arquivo"), que sempre funciona independente do
mecanismo de auto-update.

**Barra de rolagem horizontal**: mensagem com uma "palavra" comprida sem
espaco (link, texto colado) nao quebra sozinha por padrao em CSS -
estoura a largura da caixa mesmo com `flex:1;min-width:0` no container,
abrindo uma barra de rolagem horizontal que levava o usuario pra uma
area vazia a direita. Conserto: `overflow-wrap:anywhere;word-break:break-word`
em `#trp-corpo` (unico lugar, ja que toda tela aninha o conteudo dentro
dele - cobre "Ver top reacoes", "Buscar mensagens" e "Busca avancada" de
uma vez, por heranca de CSS) e `overflow-x:hidden` na area rolavel como
cinto de seguranca extra.

**Setinhas sempre visiveis, inclusive sem precisar rolar**: as setinhas
agora comecam escondidas (`display:none`) e so aparecem quando a area
rolavel realmente tem mais conteudo do que cabe na tela
(`scrollHeight > clientHeight`). Em vez de recalcular isso manualmente
em cada tela/lista, um unico `ResizeObserver` observa `#trp-corpo` (que
muda de tamanho toda vez que uma tela troca ou uma lista e recarregada)
e chama `atualizarVisibilidadeBotoesNavegacao()` sozinho sempre que o
tamanho muda - no mostra/some automaticamente, sem precisar instrumentar
cada ponto que altera a lista.

**Filtro de periodo replicado em "Ver top reacoes"**: mesmo campo De/Ate
que ja existia em "Buscar mensagens", agora tambem em `buscarTop()` e na
tela de resultados - as duas ferramentas de pesquisa compartilham os
mesmos filtros.

**Duvida sobre "Ver top reacoes" perder mensagem igual a busca por
palavra-chave perdia**: NAO e o mesmo problema. Em "Buscar mensagens" o
buraco era de DADO (mensagem que nunca tinha sido salva localmente, so
a busca ao vivo no servidor achava). Em "Ver top reacoes" nao tem busca
ao vivo nenhuma - e tudo local, e o cursor de `buscarTop()` sempre
percorre o indice por_reacoes inteiro do maior pro menor; o unico limite
e QUANTOS resultados entram na tela de uma vez (`limite`, que cresce
com "Mostrar mais"). Ou seja, nenhuma mensagem fica "escondida" pra
sempre - só requer clicar em "Mostrar mais" (ou aumentar o minimo de
reacoes) o suficiente pra alcancar mensagens de grupos menos
representados quando "Todos os grupos" esta selecionado. Nao precisou
de mudanca de codigo pra isso, so essa confirmacao.

**Texto sobre Premium/hashtag na "Busca avancada" corrigido**: o aviso
afirmava (baseado no blog do Telegram) que a restricao de conta Premium
valia inclusive pra busca por hashtag - o usuario testou e reportou o
contrario: funciona por hashtag mesmo sem Premium, e so falha no modo de
texto livre. Texto do aviso corrigido pra refletir o que foi observado
na pratica.

**Pedido nao implementado (fica pra depois)**: mostrar numero de
membros/participantes dos grupos/canais que aparecem na "Busca
avancada". Exigiria uma chamada extra por canal (`channels.GetFullChannel`
ou parecido) que pode nao vir de graca nem ser rapida pra uma lista
inteira de resultados - precisa investigar custo/limite antes de
implementar.

Versao 2026.10.08.9.

## v2026.10.08.10: caixa de "busca ao vivo no servidor" desabilitada de verdade com "Todos os grupos"

Ponto levantado pelo usuario, e correto: a limitacao de que a busca ao
vivo no servidor ("Buscar mensagens") so funciona com um grupo
especifico ja estava documentada num texto ao lado da caixa, mas a
caixa continuava clicavel e marcavel com "Todos os grupos" selecionado -
nesse estado ela nao fazia nada (o codigo ja ignorava
`checkboxServidor.checked` quando `chatId` e nulo), mas ficava marcada
na tela como se estivesse fazendo busca ao vivo em tudo. Um aviso em
texto que exige leitura nao é garantia nenhuma contra o usuario marcar e
achar que esta funcionando.

Conserto: a caixa agora fica visivelmente desabilitada (opacidade baixa,
sem clique) sempre que "Todos os grupos" esta selecionado, e se o
usuario tinha marcado e volta pra "Todos", ela se desmarca sozinha - nunca
fica marcada representando uma busca que nao esta de fato acontecendo.

Confirmado tambem (sem mudanca de codigo): essa limitacao e exclusiva de
"Buscar mensagens" - "Ver top reacoes" nunca teve busca ao vivo nenhuma
(e 100% local), entao nao tem o mesmo risco de enganar com "Todos os
grupos" porque nunca prometeu nada alem do que ja esta salvo.

Versao 2026.10.08.10.

## v2026.10.08.11: aviso de grupo desatualizado na tela de scan

Item que tinha ficado marcado como baixa prioridade voltou a fazer
sentido depois de uma discussao sobre "Ver top reacoes" so enxergar o
que ja foi escaneado: se um grupo nao e re-escaneado, mensagem nova (e
sua reacao) simplesmente nao existe no banco local - nao tem "Mostrar
mais" nem busca hibrida que resolva isso, porque nao e limite de
exibicao, e ausencia de dado. Diferente da busca por palavra-chave (que
tem busca hibrida porque da pra perguntar ao servidor algo pontual e
barato), reacao nao tem equivalente: a unica fonte de verdade e
percorrer o historico de mensagens, que e exatamente o que o scan ja
faz. Ou seja, a correcao aqui nao e arquitetura de busca, e frequencia
de scan.

Implementado um aviso (nao automatico, so informativo) na tela de scan:
`buscarUltimaMensagemPorChat()` aproveita a MESMA chamada `iterDialogs()`
que ja era feita em outros lugares (carregarGruposParaSelecao,
escanearTudo) - cada `dialog.message.id` ja vem de graca junto com a
lista de dialogs, sem precisar abrir o historico de cada grupo so pra
descobrir a ultima mensagem. Comparando esse id com o
`lastScannedMessageId` salvo, a tabela "O que ja esta salvo" mostra um
badge "⟳ tem mensagem nova" nos grupos que tem mensagem posterior ao
ultimo scan.

Cuidado de performance: essa chamada e feita UMA VEZ por abertura da
tela de scan (telaScanner()), nao a cada vez que a tabela e redesenhada -
`renderizarTabelaChats()` e chamada varias vezes durante um scan em
andamento (a cada checkpoint, via `aoAtualizarChat`), e repetir um
`iterDialogs()` completo a cada uma dessas chamadas seria caro e
desnecessario. O mapa e calculado uma vez e reaproveitado em todas as
chamadas da mesma abertura de tela; so recalcula no final de um scan
(a tabela final precisa refletir o scan que acabou de rodar).

## v2026.10.08.12: ordenacao por data em "Ver top reacoes", indicador de carregamento, botao voltar maior, texto de "Busca avancada" revisado, buscador de link de grupo

Cinco pedidos encaixados numa entrega so:

**1. Selecionar ordenacao (reacoes x data) em "Ver top reacoes".** O
indice `por_reacoes` so serve pra ordenar por quantidade de reacoes -
nao existe indice por `dateUtc` no banco. Criada `buscarTopPorData()`:
percorre tudo que bate com chat/periodo/minimo ate a mesma trava de
seguranca (`LIMITE_VISITAS = 50000`) ja usada em `buscarTexto()`, junta
num array e so ai ordena por data e corta pro `limite` - mesmo espirito
do full-scan que a busca por palavra-chave ja fazia, nao tem outro jeito
sem indice novo. `buscarTop()` virou um dispatcher: com
`ordenarPor: "data"` chama `buscarTopPorData()`, caso contrario segue o
caminho rapido de sempre (cursor no indice, para assim que passa do
minimo). Mais caro que o caminho padrao, principalmente com "Todos os
grupos" e minimo baixo (quase toda mensagem bate) - mas e o preco de
ordenar por algo sem indice.

**2. Indicador visual de carregamento.** Trocar o termo de busca e
deixar sem feedback visual enquanto a consulta roda da sensacao de
"travado". Adicionado um elemento `statusCarregando` separado da
`lista` de resultados em ambas as telas de busca ("Buscar mensagens" e
"Ver top reacoes") - separado de proposito: sobrescrever `lista`
reintroduziria o bug do salto de scroll que ja tinha sido corrigido
(ver v2026.10.08.8). `executarBusca()` em "Buscar mensagens" foi
dividida numa casca fina (seta "Buscando..." em `statusCarregando`,
chama a logica de verdade, limpa no `finally`) e `executarBuscaPorDentro()`
com o corpo original intacto.

**3. Botao "Voltar" maior.** Era um link de 12px sem borda, facil de
nao notar. Virou um botao com borda, fundo proprio, 13px/negrito e
padding - mesmo comportamento (`telaLogado()`), so mais visivel.

**4. Texto de "Busca avancada" revisado.** Duas confirmacoes pedidas
pelo usuario:
- "Publico" nesse contexto quer dizer especificamente "tem ou ja teve
  @usuario publico" - nao tem relacao com o grupo exigir aprovacao pra
  entrar. Ler/buscar nunca exige ser membro, so enviar mensagem exige;
  um grupo publico com aprovacao de entrada continua totalmente
  alcancavel pela Busca avancada.
- A exigencia de conta Premium (e o esquema de cota diaria gratis +
  pagamento em Stars depois) e especifica do modo de busca por texto
  livre (`query`), nao do modo hashtag - confirmado consultando a
  documentacao oficial (`core.telegram.org/method/channels.searchPosts`),
  que escopa essa mecanica explicitamente a "full text post searches
  (query)", sem linguagem equivalente pro modo hashtag. Isso bate com o
  que o usuario ja tinha observado na pratica (erro de Premium some ao
  trocar pra busca por hashtag).

**5. Buscador/verificador de link de grupo dentro da Busca avancada.**
Pedido como ideia solta ("como voce achar melhor"), implementado como
checkbox opcional (`checkboxLinks`, ao lado do checkbox de hashtag) por
ser mais lento que a busca normal:
- `extrairLinksTelegram(texto)`: regex construida nova a cada chamada
  (nunca reaproveitada entre strings - regex com flag `g` guarda estado
  em `lastIndex`, reusar o mesmo objeto entre textos diferentes pode
  pular ou duplicar match dependendo de onde parou da ultima vez),
  reconhece `t.me/nome` e `t.me/+hash` / `t.me/joinchat/hash` (convite).
- `verificarLinkTelegram(link)`: convite usa
  `Api.messages.CheckChatInvite({hash})`, usuario publico usa
  `Api.contacts.ResolveUsername({username})` - ambos confirmados
  existentes no schema TL embutido (checado direto no `bundle.js`).
  Link invalido/expirado nao vem como campo especial numa resposta de
  sucesso, vem como erro RPC jogado (`USERNAME_NOT_OCCUPIED`,
  `INVITE_HASH_EXPIRED` etc) - por isso o `try/catch` em volta de cada
  chamada.
- `processarLinksDaMensagem(texto)`, chamada dentro do loop de
  `executarBuscaGlobal()` (so quando `checkboxLinks.checked`), monta um
  item por link encontrado (dedup por `Map` `linksVistos`, chave
  `tipo:valor` em minusculo) com estado "verificando..." que atualiza
  pra "valido" (com titulo/numero de participantes quando disponiveis, e
  um link "abrir") ou "invalido ou expirado" assim que a verificacao
  responde. Lista (`listaLinks`) e titulo (`tituloLinks`, escondido ate
  achar o primeiro link) sao resetados junto com `lista` numa busca nova
  (nao numa continuacao via "Carregar mais").

Versao 2026.10.08.12.

## v2026.10.08.13: seletor de ordenacao de "Ver top reacoes" sumia (clipado) com grupo de nome longo

Usuario reportou que, mesmo na v12, o seletor "Mais reacoes/Mais
recentes" novo em "Ver top reacoes" nao aparecia - so o combo de grupo
("Todos os grupos") ficava visivel, ocupando a linha inteira, sem
seletor de ordenacao nem campo de minimo de reacoes ao lado. Nenhum
erro no console (confirmado tambem que a versao rodando batia
linha-a-linha com o build gerado, entao nao era cache de Tampermonkey
desatualizado).

Causa raiz: flexbox tem uma regra pouco conhecida - um item flex com
`flex-basis:0%` (o que `flex:2`/`flex:1` definem) ainda tem, por
padrao, um "automatic minimum size" baseado no conteudo (min-width:auto
implicito), que funciona como um piso mesmo com flex-shrink ativo. O
`<select>` de grupo tem opcoes com titulo de chat + "(ate msg NNNNN)",
e alguns titulos sao bem compridos (ex. "𝕺𝖗𝖋ã𝖔𝖘 𝕯𝖔 𝕰𝖝𝖈𝖑𝖚𝖘𝖎𝖛𝖔 (ate msg
1085413)") - o navegador (Firefox, no caso do usuario) calcula o
minimo intrinseco do select considerando o texto das opcoes, nao so a
selecionada. Esse minimo sozinho ja passava da largura disponivel do
painel (420px menos padding), entao o select de grupo tomava a linha
inteira e os outros dois itens (seletor de ordenacao, campo de minimo)
eram empurrados pra fora - sem gerar barra de rolagem horizontal
porque `areaRolavel` tem `overflow-x:hidden` (ver v2026.10.08.9), que
simplesmente corta o que nao cabe em vez de mostrar.

Esse mesmo padrao de linha (select de grupo flex:2 + select de
ordenacao flex:1 + input de minimo largura fixa) existe tanto em "Ver
top reacoes" quanto em "Buscar mensagens" - corrigido nos dois lugares
mesmo sem reclamacao especifica da segunda tela, ja que e o mesmo bug
latente.

Correcao: `min-width:0` explicito nos dois `<select>` de cada linha
(sobrepoe o automatic minimum size, deixando o flex-basis/grow/shrink
mandar de verdade) e `flex-shrink:0` no input de minimo (largura fixa
de 56px nao deve ser espremida). Efeito colateral aceito: com
`min-width:0`, o texto de uma opcao de grupo muito comprida pode ficar
cortado dentro do proprio select quando selecionada - troca aceitavel
por garantir que os outros filtros sempre apareçam.

Versao 2026.10.08.13.

## v2026.10.08.14: ocultar vistos, titulo da tela no cabecalho, grupo desmarcado some das listas, avisos viram icone "i", historico de busca, reacao nativa na Busca avancada

Lote grande de ajustes de UX, nenhum deles mexe no que e salvo no banco -
so em como e exibido/organizado:

**1. Ocultar mensagens ja vistas.** Checkbox novo em "Ver top reacoes" e
"Buscar mensagens" ("Ocultar as ja marcadas como vistas") - filtra so a
EXIBICAO (a mensagem continua no banco, com `visto:true`), em cima do
que ja foi buscado. O calculo de "Mostrar mais" continua olhando a
quantidade ANTES desse filtro (`mensagens.length`), senao a pessoa
nunca saberia se tem mais coisa pra carregar so porque a pagina atual
ficou vazia de visiveis.

**2. Titulo da tela no cabecalho.** Antes o cabecalho sempre mostrava
so "Top Reacoes", em qualquer tela - sem olhar o corpo do painel, nao
dava pra saber onde se estava (por exemplo depois de rolar pro topo).
`definirTituloTela(nome)`, chamada no inicio de cada tela, troca pra
"Top Reacoes - <nome da tela>"; `telaLogado()` (o menu) chama com
`null`, que volta a mostrar so o nome do app.

**3. Grupo desmarcado em "Configurar grupos" some das listas.** Antes,
desmarcar um grupo so afetava o proximo scan com "Todos" selecionado -
ele continuava aparecendo no seletor de grupo de "Ver top reacoes" e
"Buscar mensagens", e na tabela "O que ja esta salvo" da tela de scan,
mesmo sem mais interesse nele. Agora esses tres lugares filtram pelo
mesmo `carregarGruposExcluidos()` que ja existia - volta a aparecer se
a pessoa marcar o grupo de novo em "Configurar grupos". O seletor da
PROPRIA tela de scan (pra escolher um grupo especifico) continua
mostrando todos, de proposito - esse ja ignorava a lista de exclusao
antes (serve pra escanear algo pontual mesmo fora do "Todos").

**4. Avisos longos viram um icone "i" com tooltip.** Os paragrafos
grandes fixos (explicacao da Busca avancada, do checkbox de busca ao
vivo no servidor, do checkbox de extrair link de grupo, de "Configurar
grupos") poluiam a tela. Virou um texto curto + um pequeno "i"
(`criarIconeInfoHtml()`, span com `title` - tooltip nativo do
navegador, sem componente customizado) com a explicacao completa
disponivel ao passar o mouse por cima. Nao mexi no texto de status do
scan (`telaScanner`) - esse e dinamico (vira "Escaneando..." durante o
scan), nao so informativo.

**5. Tabela de status do scan mais larga.** Cabecalhos como "Status" e
"Ultimo scan" quebravam em 2 linhas porque a coluna ficava espremida
pela coluna "Grupo". `white-space:nowrap` nos `<th>` e painel 40px mais
largo (420px -> 460px) resolvem.

**6. Menu reorganizado: "Configurar grupos" por ultimo.** E um item de
configuracao, nao uma ferramenta de uso diario como as outras - pedido
do usuario pra ir pro fim da lista (cor de fundo mais discreta tambem,
pra reforcar visualmente que e diferente das demais).

**7. Historico de busca (autocomplete nativo).** Os campos de busca de
"Buscar mensagens" e "Busca avancada" agora ligam num `<datalist>`
(`ligarHistoricoBusca()`) com os ultimos 20 termos buscados,
persistidos via `GM_setValue`/`GM_getValue` entre sessoes - o proprio
navegador mostra isso como sugestao ao digitar, sem nenhum componente
customizado. "Capricho" pedido pelo usuario, simples de fazer com HTML
puro.

**8. Contagem de reacao nativa nos resultados da Busca avancada.** O
usuario cogitou (como ideia aberta, "pode ser totalmente descartavel")
tentar adivinhar quantidade de reacao analisando NUMEROS soltos no
texto das mensagens encontradas pela busca global - com o problema
obvio de falso positivo (um preco "125 BRL" no meio do texto, por
exemplo). Isso acabou sendo desnecessario: toda mensagem que
`channels.SearchPosts` devolve e um objeto `Message` completo do
Telegram, que ja inclui o campo nativo `reactions` (o MESMO campo
estruturado que `extrairReacoes()` ja le em qualquer outro lugar do
app, scan incluido) quando a mensagem tem reacao - nao e preciso (nem
seria confiavel) procurar numero no texto. Cada resultado da Busca
avancada agora mostra "N reacoes" quando esse campo vem preenchido,
sem nenhuma chamada de API extra (o dado ja vem dentro da resposta da
propria busca).

Versao 2026.10.08.14.

## v2026.10.09.15: fix no bug real por tras da "gambiarra" do usuario (buscarTexto parava antes de ordenar)

O usuario relatou ter tentado uma gambiarra em "Buscar mensagens": escolher
um grupo especifico, ligar "busca ao vivo no servidor", buscar uma letra
quase universal (ex.: "a") pra aproximar "me mostra tudo", e ordenar por
"mais reacoes" - tentando usar essa tela pra fazer na marra o que "Ver top
reacoes" ja faz de forma correta. Resultado: numeros inconsistentes e
suspeitos (maximo de 29 reacoes num grupo que "sempre funciona mas fica meio
travado"; so 1 reacao, chamado por ele de "impossivel", em outros).

**Causa raiz, achada em `buscarTexto()`:** a funcao parava de percorrer o
IndexedDB assim que `resultados.length >= limite` (padrao 100) - e SO DEPOIS
disso ordenava por reacao ou data. Como o indice `por_chat` visita as
mensagens de um grupo em ordem crescente de `messageId` (das mais antigas
pras mais recentes), um termo quase universal enchia o limite quase
imediatamente so com mensagens antigas do grupo. "Ordenar por reacoes"
nessas condicoes so reordenava esse pedaco antigo e truncado - nunca
alcancava uma mensagem de reacao alta que estivesse mais pra frente no
historico. Por isso o teto artificialmente baixo (29) e os casos "impossivel"
(1) em grupos onde o punhado antigo capturado tinha pouca reacao.

Fator secundario, menor: a parte "ao vivo no servidor" (`iterMessages({
search: termo, limit: 50 })`) e hard-capped em 50 resultados mais recentes do
servidor - nao cobre o historico completo tambem, mas isso e inerente ao
proposito dela (achar mensagem nova que ainda nao foi escaneada, nao
substituir o scan completo).

**Fix:** `buscarTexto()` agora so para de percorrer o cursor quando ele
acaba ou bate a trava de seguranca (`LIMITE_VISITAS = 300000`) - nunca mais
por ja ter "limite" resultados. Ordena o conjunto COMPLETO de mensagens que
bateram com o termo (ate a trava) e so ENTAO corta pro limite da pagina
atual. Mesmo padrao que `buscarTopPorData()` ja usava. Efeito colateral bom:
o comentario antigo de "um grupo sozinho pode engolir o limite e esconder os
demais" (motivo original do botao "Mostrar mais") tambem deixa de acontecer,
porque a ordenacao agora enxerga todos os grupos antes de cortar.

Testes novos em `test_indexeddb_logic.mjs` reproduzem o caso relatado:
termo quase universal DENTRO DE UM SO grupo, com a mensagem de reacao alta
aparecendo tarde no cursor (messageId maior) - antes do fix, um limite curto
nunca alcancava essa mensagem; depois do fix, acha de primeira.

**Importante pro usuario:** o fix deixa "Buscar mensagens" com "ordenarPor:
reacoes" correto de verdade (util pra buscar reacao de uma PALAVRA especifica
dentro das mensagens). Mas pra "ver o top de reacoes de um grupo inteiro,
sem me importar com o texto", a ferramenta certa continua sendo "Ver top
reacoes" direto - ela usa o indice `por_reacoes` (ja ordenado), nao depende
de nenhum termo bater, e por isso tambem pega posts so de midia/sem texto
com reacao alta que uma busca por palavra nunca acharia.

Versao 2026.10.09.15.

## v2026.10.09.16: termo em branco = mostrar tudo, bug do grupo excluido ainda aparecer no scan, auditoria de consistencia nas demais telas, contagem de membros na Busca avancada

Pacote de pedidos depois de confirmar o fix anterior:

**1. Termo em branco em "Buscar mensagens" agora bate com tudo.** Evolucao
direta da ideia do usuario de usar uma letra quase universal (tipo "a") pra
aproximar "mostra tudo" - ele tentou um espaco em branco e a tela rejeitava
("Digita algo pra buscar"). `buscarTexto()` agora trata termo vazio/so
espaco como "bate com qualquer mensagem" (antes so contava como "nunca
bate", por seguranca defensiva - nunca era de fato exercitado, porque a
propria tela bloqueava a busca antes de chegar la). É estritamente melhor
que a letra "a": nao fica cego a nenhuma mensagem (nem a que por acaso nao
tem essa letra). Pra isso funcionar nos filtros que re-executam a busca
sozinhos ao trocar (grupo/ordenar/minimo/data/ocultar vistos), a condicao
desses listeners deixou de ser "tem texto no campo" (`campoBusca.value.trim()`)
e virou uma flag `jaBuscou` (true depois do primeiro "Buscar"/Enter,
independente do campo estar vazio ou nao). Confirmado no codigo-fonte do
teleproto (`client/messages.js`) que `iterMessages` ja manda `q: search ||
""` pro `messages.Search` quando nao ha termo - termo vazio e um caso ja
suportado nativamente pela biblioteca/API (o mesmo mecanismo que navegar o
historico por filtro usa), nao uma gambiarra por cima dela. Isso vale
tambem pra busca ao vivo no servidor (quando marcada, com um grupo
especifico selecionado): sem termo, ela traz as 50 mensagens mais recentes
sem filtro de texto nenhum.

**2. Bug: grupo desmarcado em "Configurar grupos" continuava no dropdown
"Grupo/canal a escanear" da tela de scan.** Intencional desde a v14 (ver
comentario que dizia "escanear um grupo especifico ignora essa lista"), mas
o usuario relatou como inconsistente - os outros lugares (tabela de status,
seletores de busca) ja escondiam o grupo excluido havia tempo. Removida a
excecao: agora e uma regra unica, sem excecao por tela - grupo desmarcado
some de tudo, inclusive desse dropdown, ate ser marcado de novo em
"Configurar grupos". (Confirmado tambem: a exclusao ja era salva na hora via
GM_setValue a cada clique na caixinha - nao precisa nem nunca precisou de
botao de salvar.)

**3. Auditoria de consistencia nas demais telas** (pedido do usuario:
"passa o pente fino em tudo que eu te falei... verifica a replica pra
tudo"). Resultado da varredura:
- Texto longo em "Buscar mensagens" (sobre buscar so no que ja foi
  escaneado) virou label curto + icone "i", mesmo padrao das outras telas -
  tinha ficado de fora da v14.
- Texto longo em "Verificar mensagem" (o que essa tela faz) idem.
- Texto longo na tela de scan (escolher grupo especifico ou "Todos") idem -
  separado do elemento de status dinamico do proprio scan (que continua
  mostrando progresso em texto puro, isso nao muda).
- "Verificar mensagem" tambem ganhou o filtro de grupo excluido no seu
  proprio seletor de grupo (nao tinha, diferente das outras telas de
  pesquisa).
- Telas de login/conexao (credenciais, conectando, erro) foram conferidas e
  NAO se aplicam - sao mensagens curtas de status transitorio, nao textos
  de explicacao permanente, nao tem o que iconizar ali.

**4. Contagem de membros na Busca avancada, de graca.** Pedido antigo (v9)
tinha ficado como "fica pra depois, precisa investigar custo" -
`channels.GetFullChannel` (que tem `participantsCount` E `onlineCount`)
exigiria uma chamada de API extra por canal, cara demais pra uma lista
inteira de resultado. Na investigacao de hoje, achado melhor: o proprio
`channels.SearchPosts` ja devolve, JUNTO com as mensagens (no array
"chats", convencao padrao da API do Telegram), o objeto `Channel` completo
de cada canal/grupo referenciado - e esse objeto basico (sem precisar do
"Full") ja tem `participantsCount`. Ou seja, o numero de membros sempre
esteve disponivel de graca na mesma resposta que a Busca avancada ja fazia,
so nao estava sendo lido. Cada resultado agora mostra "N membros" quando
esse campo vem preenchido, sem nenhuma chamada extra.

`onlineCount` (quantos estao online agora) e `about` (bio do canal) SO
existem no `ChannelFull`, que ai sim exige uma chamada
`channels.GetFullChannel` por canal - continua precisando de investigacao
de custo/flood antes de implementar, e so faria sentido como algo opcional
(estilo o checkbox de verificar link), nao automatico pra cada resultado.

Versao 2026.10.09.16.

## v2026.10.09.17: busca por varias hashtags de uma vez na Busca avancada

Depois de confirmar (direto na documentacao oficial do metodo e no blog do
Telegram que anunciou o recurso, ago/2025) que a cota diaria + exigencia de
Premium/Stars e especifica do modo de TEXTO LIVRE (`query`) - o modo
`hashtag` nao e mencionado em nenhum dos dois textos como tendo essa
restricao, e bate com o que o usuario observa na pratica (hashtag nunca
deu erro de Premium) - o usuario concluiu, corretamente, que o modo texto
livre dificilmente vai valer a pena usar (ficaria sempre dependendo de
sobrar cota ou pagar Stars), e perguntou se dava pra tornar o modo hashtag
mais util permitindo buscar varias hashtags de uma vez, separadas por ";".

Implementado: no modo hashtag, o campo de busca aceita `termo1;termo2;termo3`
- cada termo vira uma chamada separada de `channels.SearchPosts` (sequencial,
nao em paralelo, pra nao arriscar flood wait geral mesmo sem o limite de
cota/Premium entrar em jogo), os resultados de todos os termos entram na
MESMA lista, sem reordenar entre si, com dedup por chatId+messageId (evita
mostrar a mesma mensagem duas vezes se ela bater com mais de uma hashtag).
Cada item mostra qual hashtag bateu, mas SO quando a busca tem mais de um
termo (com um so, ja fica implicito). "Carregar mais" agora pagina todos os
termos que ainda tem pagina em aberto ao mesmo tempo - cada termo guarda o
proprio cursor de paginacao (`offsetRate`/`offsetPeer`/`offsetId`) de forma
independente num Map, em vez de uma variavel unica como antes; termo que
deu erro ou esgotou as paginas para de ser tentado nas proximas rodadas,
sem travar os outros. Limite de 10 termos por busca - seguranca de bom
senso contra flood, nao documentada como necessaria em lugar nenhum.
Modo texto livre continua tratando ";" como parte literal do termo unico
(nao separa nada) - separar la multiplicaria o consumo da cota diaria/Stars
por termo extra, o oposto do que faria sentido dado que esse modo ja e
escasso.

Pendente, levantado na mesma conversa mas ainda sem resposta confirmada em
documentacao oficial: se o parametro `hashtag` exige correspondencia exata
com uma hashtag que alguem de fato usou (ao contrario de busca por
substring), se e case-sensitive, e se aceita espaco/mais de uma palavra
(hashtag de verdade nao aceita espaco, entao a expectativa e que isso falhe
ou simplesmente nao ache nada - mas isso nao esta confirmado em nenhuma doc
oficial encontrada, so inferencia de como hashtag funciona em geral).

Versao 2026.10.09.17.

## v2026.10.09.18: reauditoria do bug do grupo excluido (nenhum bug novo encontrado) + painel mais largo

Usuario reportou que, mesmo depois do fix da v16, um grupo desmarcado em
"Configurar grupos" continua aparecendo tanto no scan quanto nas listas.
Reauditoria completa de TODO ponto do codigo que le `carregarGruposExcluidos()`
(7 ocorrencias): dropdown de escaneamento (`telaScanner`), loop real do scan
"Todos" (`escanearTudo`), tabela de status "O que ja esta salvo"
(`renderizarTabelaChats`), seletor de grupo em "Top reacoes"
(`telaResultados`), em "Buscar mensagens", em "Verificar mensagem", e a
propria tela "Configurar grupos" (que mostra todos, excluidos inclusive, de
proposito - e ali que voce desmarca/marca de novo). Em todas as 7, o filtro
`!excluidos.has(c.chatId)` (ou equivalente) esta presente e correto.

Tambem conferido: o `chatId` usado no checkbox de exclusao
(`String(dialog.id)`, vindo de `carregarGruposParaSelecao()`) e exatamente o
mesmo formato usado no loop do scan (`escanearTudo`, mesma fonte
`String(dialog.id)`) - ou seja, nao tem descompasso de formato de ID entre
marcar um grupo como excluido e o scan reconhecer esse mesmo ID depois. O
toggle salva na hora (`GM_setValue`) a cada clique, sem precisar de botao de
salvar.

Conclusao: nao foi encontrado nenhum bug no codigo atual - o comportamento
de exclusao esta consistente em todo lugar. A explicacao mais provavel pro
que o usuario esta vendo e o Tampermonkey ainda rodando uma versao antiga
(anterior a v16) - o auto-update dele nao e instantaneo. Recomendado
conferir o numero de versao mostrado dentro do proprio painel (deve bater
com o `@version` mais recente) e, se estiver desatualizado, forcar manualmente
em Tampermonkey Dashboard > Check for userscript updates (ou sobrescrever a
aba do Telegram Web). Se depois disso o grupo ainda aparecer, e um bug
diferente do que foi auditado aqui e precisa de mais informacao (qual tela
exatamente, nome do grupo, se acontece so com "Todos" ou tambem escaneando
ele especificamente).

Tambem aumentada a largura do painel de 460px para 510px (+~11%), a pedido
do usuario (ainda tinha conteudo cortado mesmo depois do aumento da v12).

Versao 2026.10.09.18.

## v2026.10.09.19: causa provavel do bug do grupo excluido achada (grupo arquivado/orfao nunca aparecia em Configurar grupos), historico de buscas gerenciavel, painel +15%

Usuario insistiu que a exclusao de grupo continuava sem efeito em "todo o
projeto", mesmo depois de duas auditorias (v16, v18) que confirmaram o
codigo de filtragem correto em todo lugar. Reexaminando o problema por outro
angulo - o que faz um grupo ja escaneado parar de aparecer na propria tela
"Configurar grupos" (onde a exclusao e marcada) - achei duas causas reais:

1. `carregarGruposParaSelecao()`, `encontrarEntidadePorChatId()` e
   `buscarUltimaMensagemPorChat()` chamavam `cliente.iterDialogs({})` sem
   nenhum parametro - isso so devolve a pasta PRINCIPAL de conversas do
   Telegram. Um grupo arquivado (pasta "Arquivados") nunca entra nessa
   lista. Resultado: se o usuario arquiva um grupo depois de ja te-lo
   escaneado, esse grupo some de "Configurar grupos" (nao da mais pra
   marcar/desmarcar ele) mas os dados dele continuam aparecendo pra sempre
   nas outras telas, que leem direto do IndexedDB sem ligar pra pasta atual.
2. Grupo que o usuario SAIU, ou grupo comum que foi promovido a supergrupo
   (o Telegram troca o chatId nessa promocao) tambem nunca aparece em
   `carregarGruposParaSelecao()` (que so ve a conta HOJE), pelo mesmo motivo.

Corrigido: nova funcao `iterTodosOsDialogs()` (gerador que junta a pasta
principal com a pasta "Arquivados") substituiu `cliente.iterDialogs({})` em
toda funcao que precisa enumerar "todos os grupos/canais da conta" (scan,
selecao, ultima mensagem). "Configurar grupos" tambem ganhou uma
reconciliacao: qualquer chatId que esteja salvo no IndexedDB (ja escaneado
antes) mas que nao apareca mais em nenhuma pasta da conta agora entra na
lista mesmo assim, marcado "(nao esta mais na sua lista de conversas - saiu
do grupo ou ele mudou de id)" - cobre o caso 2, que nenhuma chamada de API
sozinha resolve (o chatId antigo simplesmente nao existe mais pra consultar).

Isso nao e garantia de que FOI essa a causa exata do caso do usuario (nao
da pra confirmar sem saber se o grupo dele estava arquivado ou foi
promovido a supergrupo), mas cobre os dois jeitos reais, ja identificados no
schema/biblioteca, de um grupo escaneado ficar "preso" fora do alcance da
tela de exclusao - o que bate com o sintoma relatado ("nao esta em lugar
nenhum pra eu desmarcar, mas continua aparecendo").

Tambem nessa versao:
- Historico de buscas (autocompletar de "Buscar mensagens" e "Busca
  avancada") agora tem tela propria ("Historico de buscas") pra tirar um
  termo especifico (botao "x" por item) ou limpar tudo de uma lista -
  antes so dava pra limpar tudo de uma vez, apagando o storage por fora do
  app.
- Largura do painel aumentada de 510px para 590px (+15%), a pedido do
  usuario (badge "completo" da tabela de status ainda quebrava em 2 linhas).

Versao 2026.10.09.19.

## v2026.10.09.20: busca de grupo/canal/usuario por nome, conferir link colado (tg://join), filtro "so com link"

Usuario testou a busca por conteudo (hashtag/texto livre) com termo generico
e so achou grupo em idioma/assunto aleatorio - fez sentido explicar que
channels.SearchPosts busca DENTRO do texto do post, nao pelo NOME do grupo
(por isso "palmeiras" acha qualquer post que cite a palavra, nao
necessariamente um grupo sobre o Palmeiras). O que o usuario realmente
queria - "existe grupo do Palmeiras, deve ter como achar ele" - e busca por
nome, nao por conteudo. Pesquisado e confirmado no schema oficial:
contacts.search faz exatamente isso (mesma busca que a lupa nativa do
Telegram usa) - sem cota, sem Premium, sem Stars documentado, devolve
grupos/canais E usuarios que batem com o nome/username. Nao existe (nem no
schema, nem documentado) nenhum metodo que busque por palavra-chave e
devolva link de CONVITE diretamente - convite por natureza nao e indexado
(so @usuario publico e buscavel), link de convite e sempre compartilhado por
fora do Telegram.

Implementado:

- Nova secao "Buscar grupo/canal/usuario por NOME" no topo da tela "Busca
  avancada", usando contacts.search - campo + botao, mostra grupos/canais
  (com membros, quando disponivel) e usuarios separadamente. Complementar
  (nao substitui) a busca por conteudo que ja existia, que continua logo
  abaixo, agora com titulo proprio ("Buscar por conteudo de post") pra
  marcar a diferenca.
- extrairLinksTelegram() agora tambem reconhece tg://join?invite=XXX (alem
  de t.me/...) e decodifica URL uma vez antes de rodar os regex - cobre o
  formato que a maioria dos sites externos que agregam link de grupo por
  categoria usa, e tambem o jeito que o proprio Telegram Web representa um
  tg://join colado na barra de enderecos
  (web.telegram.org/k/#?tgaddr=tg%3A%2F%2F...).
- Nova caixa "Conferir link de fora do Telegram" (mesma tela) - cola o
  texto com o(s) link(s) achado(s) em outro lugar e cada um e checado (sem
  entrar no grupo) com a mesma logica que ja existia pra links achados
  dentro dos resultados de busca. A logica de "criar item, verificar,
  atualizar linha" foi extraida pra uma funcao compartilhada
  (criarItemDeLink) entre os dois usos.
- Novo filtro "Mostrar so posts que citam algum link (esconde o resto)" na
  busca por conteudo - filtra a lista principal pra só os posts que
  mencionam t.me/tg://join, junto com o checkbox ja existente de extrair e
  verificar; juntos cobrem a ideia do usuario de "buscar um assunto e ja
  sair com os links de grupo relacionados mencionados em posts publicos".

Versao 2026.10.09.20.
