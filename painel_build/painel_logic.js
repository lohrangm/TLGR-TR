(function () {
    "use strict";

    // Este trecho roda logo apos o bundle do teleproto (cliente MTProto em
    // JS puro) ter sido carregado nesse mesmo arquivo. Tudo acontece dentro
    // do proprio navegador, na mesma sessao do Telegram Web - sem servidor
    // local, sem Python, sem conexao externa de IP pra manter aberta.

    const { TelegramClient, StringSession, PromisedWebSockets, Api } = window.TeleprotoBridge;

    // Numero da versao, pra saber na hora (olhando o topo do painel) se o
    // Tampermonkey ja pegou a atualizacao mais nova ou se ainda esta rodando
    // uma versao antiga - sem isso nao tinha como diferenciar "a correcao
    // nao funcionou" de "o script antigo ainda nao foi atualizado de
    // verdade". window.TRP_VERSAO e definido por montar_userscript.mjs (uma
    // unica fonte da verdade, usada tambem no @version do cabecalho
    // ==UserScript==) - "dev" aqui e so um fallback se alguem rodar
    // painel_logic.js fora do userscript montado.
    const VERSAO_PAINEL = window.TRP_VERSAO || "dev";

    const CHAVE_API_ID = "trp_api_id";
    const CHAVE_API_HASH = "trp_api_hash";
    const CHAVE_SESSAO = "trp_session";
    const CHAVE_GRUPOS_EXCLUIDOS = "trp_grupos_excluidos";
    const CHAVE_HISTORICO_BUSCA_LOCAL = "trp_historico_busca_local";
    const CHAVE_HISTORICO_BUSCA_GLOBAL = "trp_historico_busca_global";

    // So guarda a lista de EXCLUIDOS (nao a de incluidos) - assim, por
    // padrao, tudo entra no scan "Todos", e grupo novo que a conta entrar
    // ja aparece incluido sozinho, sem precisar marcar nada.
    function carregarGruposExcluidos() {
        try {
            return new Set(JSON.parse(GM_getValue(CHAVE_GRUPOS_EXCLUIDOS, "[]")));
        } catch (erro) {
            return new Set();
        }
    }

    function salvarGruposExcluidos(excluidos) {
        GM_setValue(CHAVE_GRUPOS_EXCLUIDOS, JSON.stringify([...excluidos]));
    }

    // ---- Historico de termos buscados (preenchimento automatico do navegador) ----

    function carregarHistoricoBusca(chave) {
        try {
            return JSON.parse(GM_getValue(chave, "[]"));
        } catch (erro) {
            return [];
        }
    }

    // Mais recente primeiro, sem repetir o mesmo termo duas vezes, capado
    // em 20 pra nao crescer pra sempre.
    function salvarTermoNoHistorico(chave, termo) {
        if (!termo) return;
        const historico = carregarHistoricoBusca(chave).filter((t) => t !== termo);
        historico.unshift(termo);
        GM_setValue(chave, JSON.stringify(historico.slice(0, 20)));
    }

    // Tira um termo especifico do historico (pedido do usuario: as vezes um
    // termo digitado errado, ou que nao interessa mais, fica poluindo o
    // autocompletar pra sempre - sem isso so dava pra limpar tudo de uma vez,
    // nunca um item so). Ver telaHistoricoBusca().
    function removerTermoDoHistorico(chave, termo) {
        const historico = carregarHistoricoBusca(chave).filter((t) => t !== termo);
        GM_setValue(chave, JSON.stringify(historico));
    }

    // Liga um <input> de busca a um <datalist> com o historico de termos ja
    // buscados antes (persistido entre sessoes via GM_getValue/GM_setValue) -
    // o proprio navegador mostra isso como sugestao/preenchimento automatico
    // nativo ao digitar, sem precisar de nenhum componente customizado.
    // "Capricho" pedido pelo usuario - simples de fazer com HTML puro (sem
    // essa lista, cada busca comeca sempre do zero, sem nenhum lembrete do
    // que ja foi pesquisado antes).
    let contadorDatalistHistorico = 0;
    function ligarHistoricoBusca(input, chave) {
        const idDatalist = "trp-historico-" + contadorDatalistHistorico++;
        const datalist = document.createElement("datalist");
        datalist.id = idDatalist;
        input.insertAdjacentElement("afterend", datalist);
        input.setAttribute("list", idDatalist);

        function repopular() {
            datalist.innerHTML = "";
            for (const termo of carregarHistoricoBusca(chave)) {
                const opcao = document.createElement("option");
                opcao.value = termo;
                datalist.appendChild(opcao);
            }
        }
        repopular();

        return {
            registrar(termo) {
                salvarTermoNoHistorico(chave, termo);
                repopular();
            },
        };
    }

    const NOME_BANCO = "TopReacoesTelegram";
    const VERSAO_BANCO = 1;

    let cliente = null; // instancia conectada, reaproveitada entre aberturas do painel
    let painel = null;
    let areaRolavel = null; // unico filho de painel que de fato rola - ver montarPainel()
    let bancoPromessa = null;
    let scanEmAndamento = false;
    let cancelarScanSolicitado = false;
    let saidaPendente = false; // true = usuario ja clicou "sair" uma vez, espera o segundo clique pra confirmar
    let timeoutSaida = null;

    // ---- IndexedDB: guarda tudo que o scan encontra, direto no navegador ----

    function abrirBanco() {
        if (bancoPromessa) return bancoPromessa;
        bancoPromessa = new Promise((resolve, reject) => {
            const pedido = indexedDB.open(NOME_BANCO, VERSAO_BANCO);
            pedido.onupgradeneeded = () => {
                const db = pedido.result;
                if (!db.objectStoreNames.contains("chats")) {
                    db.createObjectStore("chats", { keyPath: "chatId" });
                }
                if (!db.objectStoreNames.contains("mensagens")) {
                    const store = db.createObjectStore("mensagens", { keyPath: "key" });
                    store.createIndex("por_reacoes", "reactionTotal");
                    store.createIndex("por_chat", "chatId");
                }
            };
            pedido.onsuccess = () => resolve(pedido.result);
            pedido.onerror = () => reject(pedido.error);
        });
        return bancoPromessa;
    }

    function transacao(db, loja, modo) {
        return db.transaction(loja, modo).objectStore(loja);
    }

    function salvarChat(db, registro) {
        return new Promise((resolve, reject) => {
            const pedido = transacao(db, "chats", "readwrite").put(registro);
            pedido.onsuccess = () => resolve();
            pedido.onerror = () => reject(pedido.error);
        });
    }

    function buscarChat(db, chatId) {
        return new Promise((resolve, reject) => {
            const pedido = transacao(db, "chats", "readonly").get(chatId);
            pedido.onsuccess = () => resolve(pedido.result || null);
            pedido.onerror = () => reject(pedido.error);
        });
    }

    // Busca uma mensagem especifica pela chave (chatId:messageId) - usado
    // pela tela "Verificar mensagem" pra checar se algo que apareceu na
    // busca nativa do Telegram esta (ou nao) no nosso banco local.
    function buscarMensagem(db, key) {
        return new Promise((resolve, reject) => {
            const pedido = transacao(db, "mensagens", "readonly").get(key);
            pedido.onsuccess = () => resolve(pedido.result || null);
            pedido.onerror = () => reject(pedido.error);
        });
    }

    function listarChats(db) {
        return new Promise((resolve, reject) => {
            const pedido = transacao(db, "chats", "readonly").getAll();
            pedido.onsuccess = () => resolve(pedido.result || []);
            pedido.onerror = () => reject(pedido.error);
        });
    }

    function salvarMensagem(db, registro) {
        return new Promise((resolve, reject) => {
            const pedido = transacao(db, "mensagens", "readwrite").put(registro);
            pedido.onsuccess = () => resolve();
            pedido.onerror = () => reject(pedido.error);
        });
    }

    // Marca (ou desmarca) uma mensagem como "ja vista" - controle 100%
    // manual do usuario (nao e automatico, nao expira, nao tem logica por
    // tras). Usado pela caixinha em cada item das listas de resultado (top
    // reacoes e busca).
    function marcarVisto(db, key, visto) {
        return new Promise((resolve, reject) => {
            const loja = transacao(db, "mensagens", "readwrite");
            const pedidoGet = loja.get(key);
            pedidoGet.onsuccess = () => {
                const registro = pedidoGet.result;
                if (!registro) {
                    resolve();
                    return;
                }
                registro.visto = visto;
                const pedidoPut = loja.put(registro);
                pedidoPut.onsuccess = () => resolve();
                pedidoPut.onerror = () => reject(pedidoPut.error);
            };
            pedidoGet.onerror = () => reject(pedidoGet.error);
        });
    }

    // Conta quantas mensagens com reacao ja estao salvas de um chat - usado
    // pra mostrar "o que ja foi salvo", sem precisar confiar num contador
    // separado que poderia ficar desatualizado.
    function contarMensagensDoChat(db, chatId) {
        return new Promise((resolve, reject) => {
            const indice = transacao(db, "mensagens", "readonly").index("por_chat");
            const pedido = indice.count(IDBKeyRange.only(chatId));
            pedido.onsuccess = () => resolve(pedido.result);
            pedido.onerror = () => reject(pedido.error);
        });
    }

    // Percorre o indice por_reacoes do maior pro menor, filtrando por chat (se
    // informado), por reactionTotal minimo e por periodo (dataDe/dataAte, se
    // informados), ate juntar "limite" resultados. Filtro de data aqui e so
    // visual/de recorte, igual ao de buscarTexto() - nao afeta o que fica
    // salvo, so o que aparece nesta lista.
    //
    // ordenarPor="data" usa um caminho BEM mais caro (buscarTopPorData, logo
    // abaixo) - esse aqui (o padrao, ordenarPor="reacoes" ou omitido) e
    // rapido porque o indice ja vem ordenado por reacoes: da pra parar assim
    // que acha um valor abaixo do minimo, sem visitar o resto. Ordenar por
    // data perde essa vantagem (ver comentario em buscarTopPorData).
    function buscarTop(db, { chatId, minimo, limite, dataDe, dataAte, ordenarPor }) {
        if (ordenarPor === "data") {
            return buscarTopPorData(db, { chatId, minimo, limite, dataDe, dataAte });
        }
        return new Promise((resolve, reject) => {
            const resultados = [];
            const indice = transacao(db, "mensagens", "readonly").index("por_reacoes");
            const pedido = indice.openCursor(null, "prev");
            let visitados = 0;
            const LIMITE_VISITAS = 50000; // trava de seguranca, evita loop gigante
            pedido.onsuccess = () => {
                const cursor = pedido.result;
                if (!cursor || resultados.length >= limite || visitados >= LIMITE_VISITAS) {
                    resolve(resultados);
                    return;
                }
                visitados++;
                const valor = cursor.value;
                if (valor.reactionTotal < minimo) {
                    resolve(resultados); // indice esta ordenado, dai pra baixo so vem menor ainda
                    return;
                }
                const dataDaMensagem = (valor.dateUtc || "").slice(0, 10);
                const bateData = (!dataDe || dataDaMensagem >= dataDe) && (!dataAte || dataDaMensagem <= dataAte);
                if ((!chatId || valor.chatId === chatId) && bateData) {
                    resultados.push(valor);
                }
                cursor.continue();
            };
            pedido.onerror = () => reject(pedido.error);
        });
    }

    // Mesmo filtro de buscarTop(), mas ordenado por data (mais recente
    // primeiro) em vez de reacoes. Sem indice por data, entao nao da pra usar
    // o truque de "parar assim que passar do minimo" (o indice por_reacoes
    // nao esta em ordem de data) - percorre tudo que bater com chat/periodo
    // ate uma trava de seguranca, junta num array e so ai ordena e corta pro
    // "limite". Mais caro que o caminho padrao, principalmente com "Todos os
    // grupos" e minimo baixo (quase toda mensagem bate) - mesma trava
    // (LIMITE_VISITAS) e mesmo espirito do full-scan que buscarTexto() ja
    // fazia pra busca por palavra-chave.
    function buscarTopPorData(db, { chatId, minimo, limite, dataDe, dataAte }) {
        return new Promise((resolve, reject) => {
            const resultados = [];
            let visitados = 0;
            const LIMITE_VISITAS = 50000;
            const loja = transacao(db, "mensagens", "readonly");
            const pedido = chatId ? loja.index("por_chat").openCursor(IDBKeyRange.only(chatId)) : loja.openCursor();
            pedido.onsuccess = () => {
                const cursor = pedido.result;
                if (!cursor || visitados >= LIMITE_VISITAS) {
                    resultados.sort((a, b) => (a.dateUtc < b.dateUtc ? 1 : -1));
                    resolve(resultados.slice(0, limite));
                    return;
                }
                visitados++;
                const valor = cursor.value;
                const dataDaMensagem = (valor.dateUtc || "").slice(0, 10);
                const bateData = (!dataDe || dataDaMensagem >= dataDe) && (!dataAte || dataDaMensagem <= dataAte);
                if ((valor.reactionTotal || 0) >= minimo && bateData) {
                    resultados.push(valor);
                }
                cursor.continue();
            };
            pedido.onerror = () => reject(pedido.error);
        });
    }

    // Busca por substring (acentuacao/caixa ignoradas) no texto completo das
    // mensagens ja escaneadas - existe porque a busca nativa do Telegram e
    // por palavra inteira, as vezes nao acha mensagem que claramente existe
    // (ver HISTORICO_TECNICO.md). So enxerga o que ja foi salvo localmente.
    //
    // Termo com mais de uma palavra ("arlene lee") NAO exige frase exata
    // nem que todas as palavras apareçam - cada palavra e checada separado,
    // e a mensagem entra se QUALQUER UMA delas aparecer em algum lugar do
    // texto (OU logico). Essa ferramenta existe pra achar o maximo possivel
    // (o problema real e mensagem que deveria aparecer e nao aparece, nao o
    // contrario) - entao, de proposito, prioriza nao perder nada a filtrar
    // demais: "arlene lee" tambem traz "Darlene amaro" e "Marlene soares"
    // (so tem "arlene"), e eventualmente mensagem que so tem "lee" sem
    // nenhuma relacao com "arlene". Isso e intencional, pedido pelo usuario -
    // ele prefere resultado a mais (filtra visualmente depois) a resultado
    // a menos. Buscar uma palavra so (sem espaco) se comporta exatamente
    // como sempre: substring simples.
    //
    // Sem chatId, o cursor percorre a loja inteira pela chave primaria (que
    // comeca com o chatId), entao visita TODAS as mensagens de um grupo antes
    // de passar pro proximo. Se esse primeiro grupo sozinho ja tiver
    // "limite" ou mais mensagens batendo com o termo, a busca para ali e
    // nunca chega nos outros grupos - e exatamente por isso que existe
    // paginacao (chamar nessa funcao de novo com "limite" maior) em vez de
    // so aumentar um limite fixo de uma vez: ela deixa o cursor avançar o
    // suficiente pra sair do primeiro grupo e alcançar os demais.
    function buscarTexto(db, { termo, chatId, minimo, limite, ordenarPor, dataDe, dataAte }) {
        return new Promise((resolve, reject) => {
            const palavras = normalizarTexto(termo)
                .split(/\s+/)
                .filter(Boolean);
            const minimoReacoes = minimo || 0;
            const resultados = [];
            let visitados = 0;
            const LIMITE_VISITAS = 300000; // trava de seguranca, evita travar o navegador

            const loja = transacao(db, "mensagens", "readonly");
            const pedido = chatId ? loja.index("por_chat").openCursor(IDBKeyRange.only(chatId)) : loja.openCursor();

            pedido.onsuccess = () => {
                const cursor = pedido.result;
                // So para quando o cursor acaba ou bate a trava de seguranca
                // - NUNCA so por ja ter "limite" resultados. Se parasse ali,
                // "ordenarPor" (reacoes OU data) so reordenaria o primeiro
                // punhado de mensagens que bateram com o termo (as mais
                // antigas do chat, ja que o indice por_chat visita em ordem
                // crescente de messageId) e nunca enxergaria o resto do
                // historico - foi o bug que deixava "mais reacoes" devolver
                // numero baixo/errado com um termo muito comum (ex.: uma
                // letra sozinha) num chat grande. Mesmo espirito/custo do
                // full-scan que buscarTopPorData() ja faz.
                if (!cursor || visitados >= LIMITE_VISITAS) {
                    if (ordenarPor === "reacoes") {
                        resultados.sort((a, b) => (b.reactionTotal || 0) - (a.reactionTotal || 0));
                    } else {
                        resultados.sort((a, b) => (a.dateUtc < b.dateUtc ? 1 : -1));
                    }
                    resolve(resultados.slice(0, limite));
                    return;
                }
                visitados++;
                const valor = cursor.value;
                const texto = valor.texto || valor.textPreview || "";
                const textoNormalizado = normalizarTexto(texto);
                // palavras.length === 0 (termo em branco/so espaco) agora
                // conta como "bate com tudo", de proposito - pedido do
                // usuario pra poder deixar o campo vazio e usar esta busca
                // como um "mostra tudo" (igual a ideia dele de digitar uma
                // letra quase universal tipo "a", so que sem ficar cego a
                // mensagem que por acaso nao tem essa letra).
                const bateAlgumaPalavra = palavras.length === 0 || palavras.some((p) => textoNormalizado.includes(p));
                const dataDaMensagem = (valor.dateUtc || "").slice(0, 10);
                const bateData = (!dataDe || dataDaMensagem >= dataDe) && (!dataAte || dataDaMensagem <= dataAte);
                if ((valor.reactionTotal || 0) >= minimoReacoes && bateAlgumaPalavra && bateData) {
                    resultados.push(valor);
                }
                cursor.continue();
            };
            pedido.onerror = () => reject(pedido.error);
        });
    }

    // Agrupa uma lista de mensagens por chat, preservando a ordem de
    // primeira aparicao de cada chat (ou seja, se a lista ja vier ordenada
    // por reacoes ou data, o grupo com o resultado mais relevante aparece
    // primeiro). Usado pra renderizar resultados de busca agrupados por
    // grupo/canal quando a busca e feita em "Todos".
    function agruparPorChat(mensagens) {
        const ordemChats = [];
        const porChat = new Map();
        for (const m of mensagens) {
            if (!porChat.has(m.chatId)) {
                porChat.set(m.chatId, { chatId: m.chatId, chatTitle: m.chatTitle, itens: [] });
                ordemChats.push(m.chatId);
            }
            porChat.get(m.chatId).itens.push(m);
        }
        return ordemChats.map((chatId) => porChat.get(chatId));
    }

    // ---- Extracao de dados da mensagem/dialogo, espelhando o scan.py ----

    function extrairReacoes(mensagem) {
        const reactions = [];
        let total = 0;
        if (mensagem.reactions && mensagem.reactions.results) {
            for (const r of mensagem.reactions.results) {
                const emoji = (r.reaction && r.reaction.emoticon) || "custom";
                reactions.push({ emoji, count: r.count });
                total += r.count;
            }
        }
        return { reactions, total };
    }

    // Texto completo da mensagem, sem truncar - e o que a busca por palavra-
    // chave usa. truncar() abaixo e so pra exibicao nas listas.
    function textoCompleto(mensagem) {
        const texto = (mensagem.message || "").trim().replace(/\s+/g, " ");
        return texto || "[midia ou mensagem sem texto]";
    }

    // Acha links do Telegram num texto - t.me de @usuario (t.me/nome), t.me
    // de convite por hash (t.me/joinchat/XXX ou t.me/+XXX), e tambem o
    // esquema nativo tg://join?invite=XXX (formato que a maioria dos sites
    // externos que agregam link de grupo publico usa, ex. diretorios de
    // grupo por categoria). Usado pelo filtro "links de grupo" da Busca
    // avancada (telaBuscaAvancada) e pela caixa de "conferir link colado" -
    // pra oferecer verificar se o link ainda e valido em vez do usuario
    // precisar abrir cada um so pra descobrir. new RegExp() a cada chamada
    // (em vez de um regex /g compartilhado no modulo) de proposito - regex
    // com /g guarda posicao entre chamadas (lastIndex), e reusar o mesmo
    // objeto entre textos diferentes e um jeito classico de perder ou
    // duplicar match por engano.
    function extrairLinksTelegram(texto) {
        const links = [];
        if (!texto) return links;
        const vistos = new Set();
        const adicionar = (ehConvite, valor) => {
            const chave = (ehConvite ? "c:" : "u:") + valor.toLowerCase();
            if (vistos.has(chave)) return;
            vistos.add(chave);
            links.push({ ehConvite, valor });
        };

        // O link pode vir url-encoded (ex.: colado de dentro de uma URL do
        // tipo web.telegram.org/k/#?tgaddr=tg%3A%2F%2Fjoin%3Finvite%3DXXX,
        // que e como o proprio Telegram Web representa um tg://join colado
        // na barra de enderecos) - decodifica uma vez antes de rodar os
        // regex, assim o formato puro e o encoded caem no mesmo caminho. Se
        // o texto tiver um "%" que nao e um escape valido, decodeURIComponent
        // lanca erro - nesse caso segue com o texto original, sem decodificar.
        let textoDecodificado = texto;
        try {
            textoDecodificado = decodeURIComponent(texto);
        } catch (erro) {
            // nao e url-encoded (ou esta mal formado) - usa o texto como veio
        }

        const regexTMe = /(?:https?:\/\/)?t\.me\/(\+|joinchat\/)?([a-zA-Z0-9_]{3,})/g;
        let m;
        while ((m = regexTMe.exec(textoDecodificado))) {
            adicionar(!!m[1], m[2]);
        }

        const regexTgJoin = /tg:\/\/join\?invite=([a-zA-Z0-9_-]+)/g;
        while ((m = regexTgJoin.exec(textoDecodificado))) {
            adicionar(true, m[1]);
        }

        return links;
    }

    // Confere se um link de grupo/canal ainda e valido SEM abrir nada no
    // navegador - link de @usuario usa contacts.ResolveUsername (o usuario
    // ainda existe?), link de convite por hash usa messages.CheckChatInvite
    // (o hash ainda e valido? convite pode ser revogado ou expirar). Os dois
    // dao erro RPC (USERNAME_NOT_OCCUPIED/USERNAME_INVALID,
    // INVITE_HASH_EXPIRED/INVITE_HASH_INVALID) quando o link nao presta mais -
    // e isso que vira "invalido" aqui, nao um campo separado na resposta.
    async function verificarLinkTelegram(link) {
        try {
            if (link.ehConvite) {
                const resultado = await cliente.invoke(new Api.messages.CheckChatInvite({ hash: link.valor }));
                const titulo = resultado.title || (resultado.chat && resultado.chat.title) || null;
                const participantes =
                    typeof resultado.participantsCount === "number" ? resultado.participantsCount : null;
                return { valido: true, titulo, participantes };
            }
            const resultado = await cliente.invoke(new Api.contacts.ResolveUsername({ username: link.valor }));
            const chat = (resultado.chats && resultado.chats[0]) || null;
            return {
                valido: true,
                titulo: chat ? chat.title : null,
                participantes: chat && typeof chat.participantsCount === "number" ? chat.participantsCount : null,
            };
        } catch (erro) {
            return { valido: false, erro: erro && erro.message ? erro.message : String(erro) };
        }
    }

    // Cria a linha "verificando..." pra um link achado (por
    // extrairLinksTelegram), dispara verificarLinkTelegram nele e atualiza a
    // propria linha quando o resultado volta - valido (com titulo/qtd de
    // participantes, se vierem) ou invalido/expirado. Compartilhado entre o
    // "links encontrados nos resultados da busca" (telaBuscaAvancada) e a
    // caixa de "conferir link colado" (mesma tela) - os dois so diferem em
    // ONDE o link veio de, a verificacao e a apresentacao sao identicas.
    // "mapaVistos" (valor normalizado -> elemento) evita duplicar o mesmo
    // link na mesma lista.
    function criarItemDeLink(link, container, mapaVistos) {
        const chave = (link.ehConvite ? "convite:" : "usuario:") + link.valor.toLowerCase();
        if (mapaVistos.has(chave)) return;

        const item = document.createElement("div");
        item.style.cssText = "padding:6px 0;border-bottom:1px solid #2a2f3a;font-size:12px;";
        item.textContent = "t.me/" + (link.ehConvite ? "+" : "") + link.valor + " - verificando...";
        container.appendChild(item);
        mapaVistos.set(chave, item);

        verificarLinkTelegram(link).then((resultado) => {
            const enderecoLink = "t.me/" + (link.ehConvite ? "+" : "") + link.valor;
            if (resultado.valido) {
                const detalhes = [];
                if (resultado.titulo) detalhes.push(escapeHtml(resultado.titulo));
                if (resultado.participantes != null) detalhes.push(resultado.participantes + " participantes");
                item.innerHTML =
                    '<span style="color:#5ec26a;">valido</span> - ' +
                    escapeHtml(enderecoLink) +
                    (detalhes.length ? " (" + detalhes.join(", ") + ")" : "") +
                    ' <span style="color:#4da3ff;cursor:pointer;" class="trp-abrir-link">abrir</span>';
                item.querySelector(".trp-abrir-link").addEventListener("click", () => {
                    window.open("https://" + enderecoLink, "_blank");
                });
            } else {
                item.innerHTML =
                    '<span style="color:#ff6b6b;">invalido ou expirado</span> - ' +
                    escapeHtml(enderecoLink) +
                    ' <span style="color:#8b92a3;font-size:11px;">(' + escapeHtml(resultado.erro || "") + ")</span>";
            }
        });
    }

    function truncar(texto, tamanho) {
        if (!texto) return "";
        return texto.length > tamanho ? texto.slice(0, tamanho) + "..." : texto;
    }

    // Tira acentuacao e caixa, pra "informacao" encontrar "informação" (ou
    // "INFORMAÇÃO"). A busca nativa do Telegram e por palavra inteira, nao
    // por pedaco de palavra - essa normalizacao + o .includes() em
    // buscarTexto() cobrem exatamente esse buraco.
    function normalizarTexto(texto) {
        return (texto || "")
            .normalize("NFD")
            .replace(/[̀-ͯ]/g, "")
            .toLowerCase();
    }

    function dataIso(mensagem) {
        const d = mensagem.date instanceof Date ? mensagem.date : new Date(mensagem.date * 1000);
        return d.toISOString();
    }

    // O chatId que guardamos (dialog.id) segue a convencao da Bot API: grupos
    // basicos viram "-<id>", canais/supergrupos viram "-100<id>". Olhando o
    // codigo-fonte do proprio Telegram Web (github.com/morethanwords/tweb,
    // src/lib/appImManager.ts, funcao onHashChangeUnsafe), o link que abre a
    // MENSAGEM EXATA (nao so o grupo) e "#<id puro, sem sinal e sem o
    // 100>?post=<id da mensagem>" - e'xatamente o mesmo id puro que aparece
    // nos links nativos de "copiar link da mensagem" (t.me/c/<id>/<msg>).
    // Essa funcao tira o sinal e o "100" do chatId que a gente guarda, pra
    // chegar nesse id puro.
    function idBaseDoChatId(chatId) {
        const texto = String(chatId);
        if (texto.startsWith("-100")) {
            return texto.slice(4);
        }
        if (texto.startsWith("-")) {
            return texto.slice(1);
        }
        return texto;
    }

    function criarBotao() {
        const botao = document.createElement("button");
        botao.textContent = "Top Reacoes";
        Object.assign(botao.style, {
            position: "fixed",
            bottom: "24px",
            right: "24px",
            zIndex: 999999,
            padding: "10px 16px",
            borderRadius: "999px",
            border: "none",
            background: "#4da3ff",
            color: "#fff",
            fontFamily: "sans-serif",
            fontWeight: "600",
            fontSize: "13px",
            cursor: "pointer",
            boxShadow: "0 2px 10px rgba(0,0,0,0.35)",
        });
        botao.addEventListener("click", alternarPainel);
        document.body.appendChild(botao);
    }

    function alternarPainel() {
        if (painel) {
            painel.remove(); // leva areaRolavel e os botoes de navegacao junto, todos filhos dele
            painel = null;
            areaRolavel = null;
            return;
        }
        montarPainel();
    }

    // O painel agora e so a caixa fixa (header + area com scroll proprio
    // dentro dela) - ver comentario de adicionarBotoesNavegacao() sobre o
    // motivo dessa separacao existir.
    function montarPainel() {
        painel = document.createElement("div");
        Object.assign(painel.style, {
            position: "fixed",
            top: "40px",
            right: "24px",
            width: "590px",
            maxHeight: "80vh",
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            background: "#171a21",
            color: "#e6e8ec",
            border: "1px solid #2a2f3a",
            borderRadius: "10px",
            zIndex: 999999,
            padding: "16px",
            fontFamily: "sans-serif",
            fontSize: "13px",
            boxShadow: "0 8px 30px rgba(0,0,0,0.5)",
        });
        document.body.appendChild(painel);
        renderizarCabecalho();

        // Unico filho de painel que de fato rola - "flex:1;min-height:0" e
        // o jeito padrao de fazer um filho de flex-column encolher e ganhar
        // scroll proprio em vez de estourar o pai. Com isso, o cabecalho
        // fica sempre visivel (fora da area rolavel) e os botoes de
        // navegacao (filhos de painel, nao de areaRolavel) nunca ficam
        // tampados pelo conteudo nem precisam fugir do painel pra escapar
        // de corte nenhum.
        areaRolavel = document.createElement("div");
        areaRolavel.id = "trp-area-rolavel";
        // overflow-x:hidden e cinto-de-seguranca contra mensagem com palavra
        // comprida sem espaco (link, texto colado) que force a largura da
        // caixa alem do previsto - sem isso aparecia uma barra de rolagem
        // horizontal, empurrando o usuario pra uma area vazia a direita. A
        // quebra de linha forcada nos textos (overflow-wrap:anywhere, ver
        // criarItemResultado() e as listas de resultado) ja deveria evitar
        // que isso aconteça, mas o corte aqui garante mesmo se algum texto
        // escapar.
        areaRolavel.style.cssText = "overflow-y:auto;overflow-x:hidden;flex:1;min-height:0;";
        painel.appendChild(areaRolavel);

        adicionarBotoesNavegacao();
        decidirTela();
    }

    // Botoes flutuantes (voltar ao topo / ir pro fim) da area de
    // resultado, sem precisar arrastar o mouse rolando. Sao filhos do
    // PAINEL (posicionados com position:absolute, ancorados no canto
    // inferior direito dele - painel tem position:fixed, entao serve de
    // referencia pra esse absolute), nao filhos de areaRolavel nem do
    // document.body:
    // - filho de areaRolavel rolaria junto com o conteudo (sumiria de
    //   vista ao rolar pra baixo).
    // - filho do document.body com position:fixed foi tentado antes e
    //   saiu errado: o Telegram Web pode ter algum ancestral com
    //   transform/filter la em cima que muda a base de calculo de um
    //   "fixed", fazendo o botao aparecer em qualquer canto da pagina real
    //   em vez do canto do NOSSO painel.
    // Como filho do painel, painel.remove() leva os dois junto - nao
    // precisa remover na mao ao fechar.
    function adicionarBotoesNavegacao() {
        const estiloBase = {
            position: "absolute",
            right: "16px",
            zIndex: 1,
            width: "32px",
            height: "32px",
            borderRadius: "50%",
            border: "none",
            background: "#4da3ff",
            color: "#fff",
            fontSize: "16px",
            fontWeight: "700",
            cursor: "pointer",
            boxShadow: "0 2px 10px rgba(0,0,0,0.35)",
            // Comecam escondidos - so fazem sentido quando a area rolavel tem
            // mais conteudo do que cabe na tela. atualizarVisibilidadeBotoesNavegacao()
            // (chamada pelo ResizeObserver em corpoDoPainel()) mostra os dois
            // assim que detecta rolagem de verdade disponivel, e esconde de
            // volta se o conteudo encolher a ponto de nao precisar mais.
            display: "none",
        };

        const botaoTopo = document.createElement("button");
        botaoTopo.id = "trp-botao-nav-topo";
        botaoTopo.textContent = "↑";
        botaoTopo.title = "Voltar ao topo";
        Object.assign(botaoTopo.style, estiloBase, { bottom: "56px" });
        botaoTopo.addEventListener("click", () => {
            areaRolavel.scrollTop = 0;
        });
        painel.appendChild(botaoTopo);

        const botaoFim = document.createElement("button");
        botaoFim.id = "trp-botao-nav-fim";
        botaoFim.textContent = "↓";
        botaoFim.title = "Ir pro fim";
        Object.assign(botaoFim.style, estiloBase, { bottom: "16px" });
        botaoFim.addEventListener("click", () => {
            areaRolavel.scrollTop = areaRolavel.scrollHeight;
        });
        painel.appendChild(botaoFim);
    }

    // Mostra as setinhas de navegacao so quando a area rolavel realmente tem
    // mais conteudo do que cabe na tela (ou seja, so quando rolar faz
    // sentido) - escondidas na tela inicial e em qualquer lista curta. +1 e
    // margem pra arredondamento de subpixel nao contar como "tem rolagem" por
    // 1px de diferenca.
    function atualizarVisibilidadeBotoesNavegacao() {
        if (!painel || !areaRolavel) return;
        const temRolagem = areaRolavel.scrollHeight > areaRolavel.clientHeight + 1;
        const exibir = temRolagem ? "" : "none";
        const botaoTopo = painel.querySelector("#trp-botao-nav-topo");
        const botaoFim = painel.querySelector("#trp-botao-nav-fim");
        if (botaoTopo) botaoTopo.style.display = exibir;
        if (botaoFim) botaoFim.style.display = exibir;
    }

    function renderizarCabecalho() {
        saidaPendente = false;
        if (timeoutSaida) clearTimeout(timeoutSaida);
        timeoutSaida = null;

        const cabecalho = document.createElement("div");
        cabecalho.style.cssText =
            "display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;";
        cabecalho.innerHTML =
            '<strong id="trp-titulo-tela">Top Reacoes</strong>' +
            '<span style="color:#8b92a3;font-size:11px;margin-left:6px;">v' +
            escapeHtml(VERSAO_PAINEL) +
            "</span>" +
            '<div style="display:flex;align-items:center;gap:12px;">' +
            '<button id="trp-sair" style="display:none;background:none;border:none;color:#8b92a3;cursor:pointer;font-size:11px;padding:0;">sair</button>' +
            '<button id="trp-fechar" style="background:none;border:none;color:#8b92a3;cursor:pointer;font-size:16px;">x</button>' +
            "</div>";
        painel.appendChild(cabecalho);
        cabecalho.querySelector("#trp-fechar").addEventListener("click", alternarPainel);
        cabecalho.querySelector("#trp-sair").addEventListener("click", aoClicarSair);
    }

    // Antes o cabecalho sempre mostrava so "Top Reacoes", igual em
    // qualquer tela - sem olhar o corpo, nao dava pra saber em qual tela
    // o painel estava (ex. depois de rolar pro topo). Cada tela chama isso
    // logo no inicio com seu proprio nome; telaLogado() (o menu) chama
    // com null, que volta a mostrar so o nome do app.
    function definirTituloTela(nomeTela) {
        const titulo = painel && painel.querySelector("#trp-titulo-tela");
        if (titulo) titulo.textContent = nomeTela ? "Top Reacoes - " + nomeTela : "Top Reacoes";
    }

    // So aparece quando tem sessao ativa (telaLogado chama isso). Fica
    // escondido nas telas de credenciais/login, onde ainda nao tem o que sair.
    function atualizarVisibilidadeSair(visivel) {
        const botao = painel && painel.querySelector("#trp-sair");
        if (botao) botao.style.display = visivel ? "inline" : "none";
    }

    // Primeiro clique so avisa ("confirmar?", em vermelho, por 3s); segundo
    // clique dentro desse tempo e que de fato sai. Evita sair sem querer ao
    // clicar perto do "x" de fechar o painel.
    function aoClicarSair() {
        const botao = painel.querySelector("#trp-sair");
        if (!saidaPendente) {
            saidaPendente = true;
            botao.textContent = "confirmar?";
            botao.style.color = "#ff6b6b";
            timeoutSaida = setTimeout(() => {
                saidaPendente = false;
                botao.textContent = "sair";
                botao.style.color = "#8b92a3";
            }, 3000);
            return;
        }
        clearTimeout(timeoutSaida);
        saidaPendente = false;
        executarSaida();
    }

    async function executarSaida() {
        const botao = painel.querySelector("#trp-sair");
        botao.disabled = true;
        botao.textContent = "saindo...";
        try {
            await cliente.logOut();
        } catch (erro) {
            // se der erro no logOut remoto, ainda assim limpa localmente
        }
        cliente = null;
        GM_setValue(CHAVE_SESSAO, "");
        decidirTela();
    }

    function corpoDoPainel() {
        let corpo = areaRolavel.querySelector("#trp-corpo");
        if (!corpo) {
            corpo = document.createElement("div");
            corpo.id = "trp-corpo";
            // overflow-wrap:anywhere quebra ate uma palavra sem espaco (link,
            // texto colado) que de outra forma estouraria a largura da caixa -
            // ver comentario em areaRolavel sobre a barra de rolagem
            // horizontal que isso evita.
            corpo.style.cssText = "overflow-wrap:anywhere;word-break:break-word;";
            areaRolavel.appendChild(corpo);
            // O tamanho de #trp-corpo muda toda vez que uma tela troca de
            // conteudo ou uma lista e recarregada - observar ele (em vez de
            // cada call site que muda a lista) e o jeito mais simples de
            // saber, de forma centralizada, se a area rolavel ficou mais alta
            // que a parte visivel dela (ver atualizarVisibilidadeBotoesNavegacao).
            if (window.ResizeObserver) {
                new ResizeObserver(atualizarVisibilidadeBotoesNavegacao).observe(corpo);
            }
        }
        corpo.innerHTML = "";
        return corpo;
    }

    function campoTexto(corpo, rotulo, tipo, valorInicial) {
        const bloco = document.createElement("div");
        bloco.style.marginBottom = "10px";
        const label = document.createElement("label");
        label.textContent = rotulo;
        label.style.cssText = "display:block;color:#8b92a3;margin-bottom:4px;";
        const input = document.createElement("input");
        input.type = tipo || "text";
        input.value = valorInicial || "";
        input.style.cssText =
            "width:100%;background:#0c0e12;color:#e6e8ec;border:1px solid #2a2f3a;border-radius:6px;padding:8px;box-sizing:border-box;";
        bloco.appendChild(label);
        bloco.appendChild(input);
        corpo.appendChild(bloco);
        return input;
    }

    function botaoAcao(corpo, texto) {
        const botao = document.createElement("button");
        botao.textContent = texto;
        botao.style.cssText =
            "width:100%;padding:10px;border:none;border-radius:6px;background:#4da3ff;color:#fff;font-weight:600;cursor:pointer;margin-top:4px;";
        corpo.appendChild(botao);
        return botao;
    }

    // Quadrado marcavel feito na mao (nao usa <input type="checkbox">
    // nativo). O CSS global do Telegram Web reseta a aparencia de checkbox
    // nativo sem recolocar nada visivel no lugar - o elemento continua
    // funcional (por isso o cursor vira de "clicavel"), mas invisivel. Um
    // quadrado de verdade desenhado por nos nao depende do CSS do site.
    // Qualquer novo controle de formulario (checkbox, radio, etc.) deve
    // seguir esse mesmo padrao. Sem label proprio - o chamador decide o
    // layout em volta (usado como "marcar como visto" em cada item das
    // listas de resultado).
    function criarQuadradoMarcavel(valorInicial, aoAlternar) {
        const quadrado = document.createElement("div");
        quadrado.style.cssText =
            "width:18px;height:18px;flex-shrink:0;margin-top:2px;border:2px solid #8b92a3;border-radius:4px;" +
            "display:flex;align-items:center;justify-content:center;font-size:13px;line-height:1;color:#fff;" +
            "background:#0c0e12;cursor:pointer;user-select:none;";

        let marcado = !!valorInicial;
        const atualizarVisual = () => {
            quadrado.textContent = marcado ? "✓" : "";
            quadrado.style.background = marcado ? "#4da3ff" : "#0c0e12";
            quadrado.style.borderColor = marcado ? "#4da3ff" : "#8b92a3";
        };
        quadrado.addEventListener("click", (ev) => {
            ev.stopPropagation(); // nao deixa o clique vazar pro "abrir mensagem" do item
            marcado = !marcado;
            atualizarVisual();
            if (aoAlternar) aoAlternar(marcado);
        });
        atualizarVisual();

        return {
            elemento: quadrado,
            get checked() {
                return marcado;
            },
            set checked(valor) {
                marcado = !!valor;
                atualizarVisual();
            },
        };
    }

    // "i" pequeno com tooltip nativo (atributo title, o navegador mostra
    // sozinho ao passar o mouse por cima) - usado pra tirar explicacao
    // longa de cima da tela (fica tudo poluido com paragrafo grande
    // sempre visivel) sem perder a informacao, so escondendo ela atras de
    // um hover. Devolve uma STRING de HTML (nao um elemento), pra poder
    // ser concatenada direto num innerHTML ou injetada com
    // insertAdjacentHTML.
    function criarIconeInfoHtml(textoCompleto) {
        return (
            ' <span style="display:inline-block;width:14px;height:14px;line-height:13px;text-align:center;' +
            "border-radius:50%;border:1px solid #8b92a3;color:#8b92a3;font-size:10px;font-style:normal;" +
            'cursor:help;vertical-align:middle;" title="' +
            escapeHtml(textoCompleto) +
            '">i</span>'
        );
    }

    function textoAviso(corpo, mensagem, cor) {
        let aviso = corpo.querySelector(".trp-aviso");
        if (!aviso) {
            aviso = document.createElement("div");
            aviso.className = "trp-aviso";
            aviso.style.cssText = "margin-top:10px;font-size:12px;";
            corpo.appendChild(aviso);
        }
        aviso.style.color = cor || "#8b92a3";
        aviso.textContent = mensagem || "";
        return aviso;
    }

    // Pede um valor ao usuario dentro do proprio painel (ex.: codigo de
    // login, senha de duas etapas) e devolve uma Promise que resolve quando
    // ele confirma. Usado pelos callbacks do client.start().
    function pedirValor(rotulo, tipo) {
        return new Promise((resolve) => {
            const corpo = corpoDoPainel();
            const input = campoTexto(corpo, rotulo, tipo || "text");
            const botao = botaoAcao(corpo, "Confirmar");
            const confirmar = () => {
                const valor = input.value.trim();
                if (!valor) return;
                resolve(valor);
            };
            botao.addEventListener("click", confirmar);
            input.addEventListener("keydown", (ev) => {
                if (ev.key === "Enter") confirmar();
            });
            input.focus();
        });
    }

    function decidirTela() {
        atualizarVisibilidadeSair(false);
        const apiId = GM_getValue(CHAVE_API_ID, "");
        const apiHash = GM_getValue(CHAVE_API_HASH, "");
        if (!apiId || !apiHash) {
            return telaCredenciais();
        }
        const sessaoSalva = GM_getValue(CHAVE_SESSAO, "");
        if (sessaoSalva && cliente) {
            return telaLogado();
        }
        if (sessaoSalva) {
            return reconectarComSessaoSalva(apiId, apiHash, sessaoSalva);
        }
        return telaLogin(apiId, apiHash);
    }

    function telaCredenciais() {
        definirTituloTela(null);
        const corpo = corpoDoPainel();
        corpo.innerHTML =
            '<div style="color:#8b92a3;margin-bottom:10px;">' +
            "Antes do primeiro login, pegue suas credenciais de API em " +
            '<a href="https://my.telegram.org/apps" target="_blank" style="color:#4da3ff;">my.telegram.org/apps</a>' +
            " (login com seu numero, cria um app qualquer, anota api_id e api_hash). So precisa fazer isso uma vez." +
            "</div>";
        const apiId = campoTexto(corpo, "api_id", "text");
        const apiHash = campoTexto(corpo, "api_hash", "text");
        const botao = botaoAcao(corpo, "Salvar");
        botao.addEventListener("click", () => {
            const idValor = apiId.value.trim();
            const hashValor = apiHash.value.trim();
            if (!idValor || !hashValor) {
                textoAviso(corpo, "Preenche os dois campos.", "#ff6b6b");
                return;
            }
            GM_setValue(CHAVE_API_ID, idValor);
            GM_setValue(CHAVE_API_HASH, hashValor);
            decidirTela();
        });
    }

    function novoCliente(apiId, apiHash, sessaoSalva) {
        return new TelegramClient(new StringSession(sessaoSalva || ""), parseInt(apiId, 10), apiHash, {
            connectionRetries: 3,
            networkSocket: PromisedWebSockets,
            deviceModel: "Painel Top Reacoes",
            systemVersion: "Tampermonkey",
            useWSS: true,
        });
    }

    async function reconectarComSessaoSalva(apiId, apiHash, sessaoSalva) {
        definirTituloTela(null);
        const corpo = corpoDoPainel();
        textoAviso(corpo, "Reconectando com a sessao salva...");
        try {
            cliente = novoCliente(apiId, apiHash, sessaoSalva);
            await cliente.connect();
            const autorizado = await cliente.checkAuthorization();
            if (!autorizado) {
                cliente = null;
                GM_setValue(CHAVE_SESSAO, "");
                textoAviso(corpo, "Sessao salva nao e mais valida, faca login de novo.", "#ff6b6b");
                telaLogin(apiId, apiHash);
                return;
            }
            telaLogado();
        } catch (erro) {
            cliente = null;
            textoAviso(corpo, "Erro ao reconectar: " + (erro && erro.message ? erro.message : erro), "#ff6b6b");
        }
    }

    function telaLogin(apiId, apiHash) {
        definirTituloTela(null);
        const corpo = corpoDoPainel();
        const telefone = campoTexto(corpo, "Numero de telefone (com DDI, ex: +5511999999999)", "text");
        const botao = botaoAcao(corpo, "Entrar");
        botao.addEventListener("click", async () => {
            botao.disabled = true;
            textoAviso(corpo, "Conectando...");
            const numero = telefone.value.trim();
            if (!numero) {
                textoAviso(corpo, "Digita o numero de telefone.", "#ff6b6b");
                botao.disabled = false;
                return;
            }
            try {
                const novoClienteLogin = novoCliente(apiId, apiHash, "");
                await novoClienteLogin.start({
                    phoneNumber: async () => numero,
                    phoneCode: async (ehPeloApp, info) =>
                        pedirValor(
                            "Codigo de login recebido " + (ehPeloApp ? "no proprio Telegram" : "por SMS"),
                            "text"
                        ),
                    password: async (dica) =>
                        pedirValor(
                            "Senha de verificacao em duas etapas" + (dica ? " (dica: " + dica + ")" : ""),
                            "password"
                        ),
                    onError: async (erro) => {
                        textoAviso(corpo, "Erro: " + (erro && erro.message ? erro.message : erro), "#ff6b6b");
                        return false; // false = tenta de novo em vez de cancelar
                    },
                });
                cliente = novoClienteLogin;
                GM_setValue(CHAVE_SESSAO, cliente.session.save());
                telaLogado();
            } catch (erro) {
                textoAviso(corpo, "Erro ao entrar: " + (erro && erro.message ? erro.message : erro), "#ff6b6b");
                botao.disabled = false;
            }
        });
    }

    async function telaLogado() {
        definirTituloTela(null);
        const corpo = corpoDoPainel();
        textoAviso(corpo, "Carregando dados da conta...");
        try {
            const eu = await cliente.getMe();
            const nome = [eu.firstName, eu.lastName].filter(Boolean).join(" ") || "(sem nome)";
            const usuario = eu.username ? "@" + eu.username : "sem username publico";
            corpo.innerHTML =
                '<div style="margin-bottom:10px;">' +
                '<div style="color:#4da3ff;font-weight:600;">Logado como ' +
                escapeHtml(nome) +
                "</div>" +
                '<div style="color:#8b92a3;">' +
                escapeHtml(usuario) +
                "</div>" +
                "</div>";
            const botaoEscanear = botaoAcao(corpo, "Escanear grupos/canais");
            botaoEscanear.addEventListener("click", () => telaScanner());
            const botaoResultados = botaoAcao(corpo, "Ver top reacoes");
            botaoResultados.addEventListener("click", () => telaResultados());
            const botaoBusca = botaoAcao(corpo, "Buscar mensagens");
            botaoBusca.addEventListener("click", () => telaBusca());
            const botaoBuscaAvancada = botaoAcao(corpo, "Busca avancada (grupos/canais publicos)");
            botaoBuscaAvancada.addEventListener("click", () => telaBuscaAvancada());
            const botaoVerificar = botaoAcao(corpo, "Verificar mensagem (local vs. ao vivo)");
            botaoVerificar.addEventListener("click", () => telaVerificarMensagem());
            // Ultimo da lista de proposito - e um item de configuracao, nao
            // uma ferramenta do dia-a-dia como as de cima (pedido do usuario).
            const botaoConfigurarGrupos = botaoAcao(corpo, "Configurar grupos do scan (incluir/excluir)");
            botaoConfigurarGrupos.style.background = "#2a2f3a";
            botaoConfigurarGrupos.addEventListener("click", () => telaConfigurarGrupos());
            const botaoHistorico = botaoAcao(corpo, "Historico de buscas (gerenciar/limpar)");
            botaoHistorico.style.background = "#2a2f3a";
            botaoHistorico.addEventListener("click", () => telaHistoricoBusca());
            atualizarVisibilidadeSair(true);
        } catch (erro) {
            textoAviso(corpo, "Erro ao carregar a conta: " + (erro && erro.message ? erro.message : erro), "#ff6b6b");
        }
    }

    function botaoVoltar(corpo) {
        const botao = document.createElement("button");
        botao.textContent = "← Voltar";
        // Antes era texto puro sem fundo nem borda (font-size:12px) - dificil
        // de identificar rapido entre o resto da tela. Agora tem contorno e
        // area de clique maior, continua discreto (sem cor de destaque igual
        // os botoes de acao) mas facil de achar.
        botao.style.cssText =
            "background:#0c0e12;border:1px solid #2a2f3a;border-radius:6px;color:#c7cbd4;cursor:pointer;" +
            "font-size:13px;font-weight:600;margin-bottom:12px;padding:6px 12px;";
        botao.addEventListener("click", () => telaLogado());
        corpo.appendChild(botao);
        return botao;
    }

    // ---- Tela de scan ----

    // Itera TODOS os grupos/canais da conta, incluindo os que estao na
    // pasta "Arquivados" do Telegram - cliente.iterDialogs({}) sozinho so
    // devolve a pasta principal. Sem isso, um grupo que foi arquivado DEPOIS
    // de ja ter sido escaneado nunca mais aparece em "Configurar grupos" pra
    // poder ser excluido - ele fica preso pra sempre nas listas de
    // status/busca (que leem direto do que ja foi salvo no IndexedDB, sem
    // ligar se o grupo ainda esta na pasta principal) sem nenhum jeito de
    // tirar ele de la pela tela de configuracao. Toda funcao que precisa
    // enumerar "todos os grupos/canais da conta" usa essa, nunca
    // cliente.iterDialogs({}) direto.
    async function* iterTodosOsDialogs() {
        yield* cliente.iterDialogs({});
        yield* cliente.iterDialogs({ archived: true });
    }

    // Lista os grupos/canais da conta (pra popular o seletor de "qual grupo
    // escanear"). Separado de escanearTudo porque aqui so queremos
    // id+titulo, sem mexer no banco.
    async function carregarGruposParaSelecao() {
        const grupos = [];
        for await (const dialog of iterTodosOsDialogs()) {
            if (!(dialog.isGroup || dialog.isChannel)) continue;
            grupos.push({ chatId: String(dialog.id), titulo: dialog.title || dialog.name || String(dialog.id) });
        }
        grupos.sort((a, b) => a.titulo.localeCompare(b.titulo));
        return grupos;
    }

    // ---- Tela de configuracao: quais grupos/canais entram no "Todos" do scan ----

    // Grupo desmarcado aqui some de TODO lugar (tabela de status, seletores
    // de busca e tambem do dropdown "Grupo/canal a escanear" da tela de
    // scan) ate ser marcado de novo - um unico comportamento consistente em
    // vez de excecao por tela. Pra escanear um grupo excluido manualmente,
    // marca ele aqui de novo primeiro. A lista inclui grupos arquivados (ver
    // iterTodosOsDialogs) e tambem grupos que o usuario ja saiu / mudaram de
    // id (ver reconciliacao com listarChats(db) dentro da funcao) - sem isso
    // esses dois casos nunca apareciam aqui pra poder ser excluidos, mesmo
    // com dados ja escaneados deles poluindo as outras telas pra sempre.
    async function telaConfigurarGrupos() {
        definirTituloTela("Configurar grupos");
        const corpo = corpoDoPainel();
        botaoVoltar(corpo);

        const aviso = document.createElement("div");
        aviso.style.cssText = "display:flex;align-items:center;gap:4px;color:#8b92a3;margin-bottom:10px;";
        aviso.innerHTML =
            '<span>Desmarca os grupos/canais que voce NAO quer no scan.</span>' +
            criarIconeInfoHtml(
                'Desmarca os grupos/canais que voce NAO quer acompanhar. Grupo novo que voce entrar aparece aqui automaticamente, ja marcado pra escanear. Um grupo desmarcado aqui some de tudo ate ser marcado de novo: do scan com "Todos" selecionado, do dropdown "Grupo/canal a escanear" (pra escanear ele mesmo assim, marca de novo aqui primeiro), do seletor de grupo nas telas de busca, e da tabela "O que ja esta salvo" na tela de scan.'
            );
        corpo.appendChild(aviso);

        const lista = document.createElement("div");
        lista.style.cssText = "color:#8b92a3;";
        lista.textContent = "Carregando lista de grupos...";
        corpo.appendChild(lista);

        try {
            const grupos = await carregarGruposParaSelecao();
            const excluidos = carregarGruposExcluidos();

            // Reconciliacao com o que ja foi escaneado: um grupo que o
            // usuario SAIU, ou que mudou de chatId (grupo comum virou
            // supergrupo - Telegram troca o id nessa migracao), nao aparece
            // em carregarGruposParaSelecao() (que so ve a conta HOJE) mas os
            // dados escaneados dele continuam no IndexedDB pra sempre, e sem
            // aparecer aqui o usuario nunca consegue marcar ele como
            // excluido. Mostra esses tambem, separados, com o titulo salvo
            // na epoca do scan.
            const idsAtuais = new Set(grupos.map((g) => g.chatId));
            const db = await abrirBanco();
            const chatsSalvos = await listarChats(db);
            const orfaos = chatsSalvos.filter((c) => !idsAtuais.has(c.chatId));

            lista.innerHTML = "";
            if (!grupos.length && !orfaos.length) {
                lista.textContent = "Nenhum grupo/canal encontrado nessa conta.";
                return;
            }

            const criarLinha = (chatId, titulo, origemDesconhecida) => {
                const linha = document.createElement("div");
                linha.style.cssText =
                    "display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid #2a2f3a;";
                const quadrado = criarQuadradoMarcavel(!excluidos.has(chatId), (incluido) => {
                    if (incluido) excluidos.delete(chatId);
                    else excluidos.add(chatId);
                    salvarGruposExcluidos(excluidos);
                });
                const rotulo = document.createElement("span");
                rotulo.textContent = titulo;
                linha.appendChild(quadrado.elemento);
                linha.appendChild(rotulo);
                if (origemDesconhecida) {
                    const nota = document.createElement("span");
                    nota.style.cssText = "color:#8b92a3;font-size:11px;margin-left:4px;";
                    nota.textContent = "(nao esta mais na sua lista de conversas - saiu do grupo ou ele mudou de id)";
                    linha.appendChild(nota);
                }
                lista.appendChild(linha);
            };

            for (const g of grupos) criarLinha(g.chatId, g.titulo, false);
            for (const c of orfaos) criarLinha(c.chatId, c.chatTitle || c.chatId, true);
        } catch (erro) {
            lista.textContent = "Erro ao carregar grupos: " + (erro && erro.message ? erro.message : erro);
        }
    }

    // ---- Tela de configuracao: historico de termos pesquisados ----

    // So dava pra limpar o historico todo de uma vez (apagando o
    // GM_setValue direto no storage do Tampermonkey) - pedido do usuario:
    // poder tirar so um termo especifico da lista de sugestao, sem perder o
    // resto. Dois historicos separados (busca local "Buscar mensagens" e
    // busca global "Busca avancada"), cada um com seu botao de limpar tudo.
    function telaHistoricoBusca() {
        definirTituloTela("Historico de buscas");
        const corpo = corpoDoPainel();
        botaoVoltar(corpo);

        const renderizarBloco = (titulo, chave) => {
            const secao = document.createElement("div");
            secao.style.marginBottom = "16px";

            const cabecalho = document.createElement("div");
            cabecalho.style.cssText = "display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;";
            const rotulo = document.createElement("span");
            rotulo.style.cssText = "color:#8b92a3;font-weight:600;";
            rotulo.textContent = titulo;
            cabecalho.appendChild(rotulo);

            const botaoLimparTudo = document.createElement("button");
            botaoLimparTudo.textContent = "Limpar tudo";
            botaoLimparTudo.style.cssText =
                "background:none;border:1px solid #2a2f3a;border-radius:6px;color:#ff6b6b;cursor:pointer;" +
                "font-size:11px;padding:3px 8px;";
            cabecalho.appendChild(botaoLimparTudo);
            secao.appendChild(cabecalho);

            const lista = document.createElement("div");
            secao.appendChild(lista);
            corpo.appendChild(secao);

            const renderizarLista = () => {
                const termos = carregarHistoricoBusca(chave);
                lista.innerHTML = "";
                if (!termos.length) {
                    lista.innerHTML = '<div style="color:#8b92a3;font-size:12px;">Nenhum termo buscado ainda.</div>';
                    return;
                }
                for (const termo of termos) {
                    const linha = document.createElement("div");
                    linha.style.cssText =
                        "display:flex;align-items:center;justify-content:space-between;gap:8px;padding:5px 0;" +
                        "border-bottom:1px solid #2a2f3a;";
                    const texto = document.createElement("span");
                    texto.style.cssText = "overflow-wrap:anywhere;";
                    texto.textContent = termo;
                    const botaoRemover = document.createElement("button");
                    botaoRemover.textContent = "✕";
                    botaoRemover.title = "Tirar esse termo do historico";
                    botaoRemover.style.cssText =
                        "background:none;border:none;color:#8b92a3;cursor:pointer;font-size:13px;flex-shrink:0;";
                    botaoRemover.addEventListener("click", () => {
                        removerTermoDoHistorico(chave, termo);
                        renderizarLista();
                    });
                    linha.appendChild(texto);
                    linha.appendChild(botaoRemover);
                    lista.appendChild(linha);
                }
            };
            renderizarLista();

            botaoLimparTudo.addEventListener("click", () => {
                GM_setValue(chave, "[]");
                renderizarLista();
            });
        };

        renderizarBloco('Historico de "Buscar mensagens"', CHAVE_HISTORICO_BUSCA_LOCAL);
        renderizarBloco('Historico de "Busca avancada"', CHAVE_HISTORICO_BUSCA_GLOBAL);
    }

    // Acha o dialog.entity de um chat ja escaneado, pelo chatId guardado -
    // precisa disso (em vez de so o chatId numerico) pra poder chamar
    // cliente.getMessages, do mesmo jeito que escanearTudo usa
    // dialog.entity pra chamar iterMessages. So itera os dialogs ate achar
    // (nao da pra montar o InputPeer so com o chatId sem o access_hash).
    async function encontrarEntidadePorChatId(chatId) {
        for await (const dialog of iterTodosOsDialogs()) {
            if (String(dialog.id) === chatId) return dialog.entity;
        }
        return null;
    }

    // Pega, numa unica passada por iterDialogs (a mesma chamada ja usada em
    // carregarGruposParaSelecao/escanearTudo, sem custo extra de API por
    // chat), o id da ultima mensagem de verdade que existe HOJE em cada
    // grupo/canal - dialog.message.id, de graca junto com a lista de dialogs,
    // sem precisar abrir o historico de cada um. Comparado com
    // lastScannedMessageId (o que a gente salvou), da pra saber se um grupo
    // tem mensagem nova que o scan ainda nao viu, sem escanear nada - so
    // serve de aviso (badge "desatualizado"), nao substitui rodar o scan de
    // verdade.
    async function buscarUltimaMensagemPorChat() {
        const mapa = new Map();
        for await (const dialog of iterTodosOsDialogs()) {
            if (!(dialog.isGroup || dialog.isChannel)) continue;
            mapa.set(String(dialog.id), dialog.message ? dialog.message.id : null);
        }
        return mapa;
    }

    // Mostra o que ja esta salvo por grupo: quantas mensagens com reacao,
    // quando foi o ultimo scan e se terminou de verdade (concluido) ou ficou
    // parcial (cancelado no meio). Sem isso o usuario fica as cegas sobre o
    // que ja rodou. "ultimasMensagens" (opcional, vindo de
    // buscarUltimaMensagemPorChat) acrescenta o aviso de "desatualizado" -
    // calculado so uma vez por abertura da tela de scan (ver telaScanner()),
    // nao a cada vez que essa funcao e chamada de novo (ela e chamada varias
    // vezes durante um scan em andamento, repetir o iterDialogs a cada
    // checkpoint seria caro e sem necessidade).
    async function renderizarTabelaChats(container, db, ultimasMensagens) {
        // Grupo desmarcado em "Configurar grupos" some daqui tambem (e do
        // seletor de grupo nas telas de busca) - so volta a aparecer se o
        // usuario marcar ele de novo la. Pedido do usuario: grupo que ele
        // nao quer mais acompanhar nao devia continuar poluindo a lista de
        // status so porque foi escaneado um dia.
        const excluidos = carregarGruposExcluidos();
        const chats = (await listarChats(db)).filter((c) => !excluidos.has(c.chatId));
        chats.sort((a, b) => (a.chatTitle || "").localeCompare(b.chatTitle || ""));
        if (!chats.length) {
            container.innerHTML =
                '<div style="color:#8b92a3;">Nenhum grupo escaneado ainda (ou todos os escaneados estao desmarcados em "Configurar grupos").</div>';
            return;
        }
        const linhas = [];
        for (const c of chats) {
            const total = await contarMensagensDoChat(db, c.chatId);
            const quando = c.lastScannedAt ? new Date(c.lastScannedAt).toLocaleString() : "-";
            const backfillPendente = typeof c.backfillAlvo === "number" && (c.textoCompletoAte || 0) < c.backfillAlvo;
            const badge = !c.concluido
                ? '<span style="color:#e0a93a;">parcial</span>'
                : backfillPendente
                ? '<span style="color:#e0a93a;">completando historico antigo</span>'
                : '<span style="color:#5ec26a;">completo</span>';
            const ultimoIdReal = ultimasMensagens ? ultimasMensagens.get(c.chatId) : undefined;
            const desatualizado = ultimoIdReal != null && ultimoIdReal > (c.lastScannedMessageId || 0);
            const avisoDesatualizado = desatualizado
                ? ' <span style="color:#e0a93a;" title="Tem mensagem nova no grupo desde o ultimo scan - roda o scan de novo (e rapido, so busca o que e novo) pra essa mensagem entrar no calculo de reacoes.">⟳ tem mensagem nova</span>'
                : "";
            linhas.push(
                "<tr>" +
                    '<td style="padding:4px 6px;">' +
                    escapeHtml(c.chatTitle || c.chatId) +
                    "</td>" +
                    '<td style="padding:4px 6px;text-align:right;">' +
                    total +
                    "</td>" +
                    '<td style="padding:4px 6px;">' +
                    badge +
                    avisoDesatualizado +
                    "</td>" +
                    '<td style="padding:4px 6px;color:#8b92a3;font-size:11px;">' +
                    escapeHtml(quando) +
                    "</td>" +
                    "</tr>"
            );
        }
        // white-space:nowrap nos cabecalhos - eram so 1-2 palavras curtas
        // ("Status", "Ultimo scan") mas a coluna ficava estreita demais
        // (espremida pela coluna "Grupo", que precisa do espaco pro nome
        // do chat) e quebrava em 2 linhas, ficando com cara de erro.
        container.innerHTML =
            '<table style="width:100%;border-collapse:collapse;font-size:12px;">' +
            '<thead><tr style="color:#8b92a3;text-align:left;">' +
            '<th style="padding:4px 6px;white-space:nowrap;">Grupo</th>' +
            '<th style="padding:4px 6px;text-align:right;white-space:nowrap;">Salvas</th>' +
            '<th style="padding:4px 6px;white-space:nowrap;">Status</th>' +
            '<th style="padding:4px 6px;white-space:nowrap;">Ultimo scan</th>' +
            "</tr></thead><tbody>" +
            linhas.join("") +
            "</tbody></table>";
    }

    async function telaScanner() {
        definirTituloTela("Escanear");
        const corpo = corpoDoPainel();
        botaoVoltar(corpo);

        const db = await abrirBanco();

        const blocoSelecao = document.createElement("div");
        blocoSelecao.style.marginBottom = "10px";
        blocoSelecao.innerHTML =
            '<label style="display:block;color:#8b92a3;margin-bottom:4px;">Grupo/canal a escanear</label>' +
            '<select id="trp-select-grupo" style="width:100%;background:#0c0e12;color:#e6e8ec;border:1px solid #2a2f3a;border-radius:6px;padding:8px;box-sizing:border-box;">' +
            '<option value="">Todos (ordem que o Telegram devolver)</option>' +
            '<option value="" disabled id="trp-carregando-grupos">Carregando lista de grupos...</option>' +
            "</select>";
        corpo.appendChild(blocoSelecao);
        const selectGrupo = blocoSelecao.querySelector("#trp-select-grupo");

        // Grupo desmarcado em "Configurar grupos" nao aparece aqui tambem -
        // antes dessa correcao ele ficava escondido da tabela de status e
        // dos seletores de busca mas continuava aparecendo neste dropdown
        // (unica excecao que sobrou), o que o usuario reportou como
        // inconsistente. Pra escanear um grupo excluido manualmente agora e
        // so marcar ele de novo em "Configurar grupos" primeiro - mais
        // simples que manter uma excecao silenciosa so neste seletor.
        const excluidosParaDropdown = carregarGruposExcluidos();
        carregarGruposParaSelecao()
            .then((grupos) => {
                const carregando = selectGrupo.querySelector("#trp-carregando-grupos");
                if (carregando) carregando.remove();
                for (const g of grupos) {
                    if (excluidosParaDropdown.has(g.chatId)) continue;
                    const opcao = document.createElement("option");
                    opcao.value = g.chatId;
                    opcao.textContent = g.titulo;
                    selectGrupo.appendChild(opcao);
                }
            })
            .catch(() => {
                const carregando = selectGrupo.querySelector("#trp-carregando-grupos");
                if (carregando) carregando.textContent = "Erro ao carregar lista de grupos.";
            });

        // Texto longo de explicacao vira label curto + icone "i" (mesmo
        // padrao das outras telas) - separado do "status" logo abaixo, que e
        // so pra mensagem DINAMICA de progresso do scan (escanearTudo()
        // escreve direto em status.textContent durante o scan).
        const aviso = document.createElement("div");
        aviso.style.cssText = "display:flex;align-items:center;gap:4px;color:#8b92a3;margin-bottom:6px;";
        aviso.innerHTML =
            '<span>Escolhe um grupo especifico ou deixa em "Todos".</span>' +
            criarIconeInfoHtml(
                'Com "Todos" selecionado, respeita o que estiver desmarcado em "Configurar grupos do scan" (grupo desmarcado la nao entra). Escolher um grupo especifico aqui sempre escaneia ele, mesmo que esteja desmarcado em "Configurar grupos" - so precisa estar presente nesta lista (ou seja, marcado la). Continua de onde parou da ultima vez - pode parar e retomar a hora que quiser. Historico antigo que ainda nao tem texto completo salvo (grupos escaneados antes da busca por palavra-chave existir) e completado automaticamente, sem precisar marcar nada.'
            );
        corpo.appendChild(aviso);

        const status = document.createElement("div");
        status.style.cssText = "color:#8b92a3;margin-bottom:10px;white-space:pre-line;";
        status.textContent = scanEmAndamento ? "Scan ja esta rodando..." : "";
        corpo.appendChild(status);

        const botaoIniciar = botaoAcao(corpo, scanEmAndamento ? "Scan em andamento..." : "Iniciar scan");
        botaoIniciar.disabled = scanEmAndamento;

        const botaoParar = botaoAcao(corpo, "Parar");
        botaoParar.style.background = "#3a2f2f";
        botaoParar.style.display = scanEmAndamento ? "block" : "none";
        botaoParar.addEventListener("click", () => {
            cancelarScanSolicitado = true;
            botaoParar.disabled = true;
            botaoParar.textContent = "Parando...";
        });

        const tituloTabela = document.createElement("div");
        tituloTabela.style.cssText = "color:#8b92a3;margin:14px 0 6px;font-weight:600;";
        tituloTabela.textContent = "O que ja esta salvo:";
        corpo.appendChild(tituloTabela);

        const tabela = document.createElement("div");
        corpo.appendChild(tabela);

        // So uma passada por iterDialogs aqui, reaproveitada nos demais
        // renderizarTabelaChats() desta mesma abertura de tela (inclusive os
        // que disparam a cada checkpoint durante um scan em andamento) - ver
        // comentario em cima de renderizarTabelaChats().
        const ultimasMensagens = await buscarUltimaMensagemPorChat().catch(() => new Map());
        await renderizarTabelaChats(tabela, db, ultimasMensagens);

        botaoIniciar.addEventListener("click", async () => {
            botaoIniciar.disabled = true;
            botaoIniciar.textContent = "Escaneando...";
            botaoParar.style.display = "block";
            selectGrupo.disabled = true;
            const apenasChatId = selectGrupo.value || null;
            try {
                await escanearTudo(
                    (texto) => {
                        status.textContent = texto;
                    },
                    apenasChatId,
                    () => renderizarTabelaChats(tabela, db, ultimasMensagens)
                );
                status.textContent = cancelarScanSolicitado
                    ? "Scan interrompido - o que ja foi visto fica salvo, pode retomar depois."
                    : apenasChatId
                    ? "Scan completo nesse grupo."
                    : "Scan completo em todos os grupos/canais.";
            } catch (erro) {
                status.textContent = "Erro durante o scan: " + (erro && erro.message ? erro.message : erro);
            } finally {
                botaoIniciar.disabled = false;
                botaoIniciar.textContent = "Iniciar scan de novo";
                botaoParar.style.display = "none";
                selectGrupo.disabled = false;
                // Reconfere do zero (a lista anterior pode ter ficado velha -
                // o proprio scan que acabou de rodar muda o que conta como
                // "desatualizado").
                const ultimasMensagensPosScan = await buscarUltimaMensagemPorChat().catch(() => new Map());
                await renderizarTabelaChats(tabela, db, ultimasMensagensPosScan);
            }
        });
    }

    // apenasChatId: null/"" escaneia todos os grupos/canais (como antes); um
    // chatId especifico faz so aquele grupo, sem depender da ordem que
    // iterDialogs() devolve.
    // aoAtualizarChat: callback opcional chamado toda vez que um chat e
    // salvo (checkpoint ou fim), pra tela de scan atualizar a tabela ao vivo.
    //
    // Cada chat passa por duas fases, sem nenhum toggle manual:
    //
    // Fase 1 (backfill automatico): completa o texto das mensagens antigas,
    // de quando o chat foi escaneado antes da busca por palavra-chave
    // existir (so a mensagem com reacao era salva, o resto era descartado).
    // "backfillAlvo" congela, na primeira vez que o chat ganha essa
    // funcionalidade, o checkpoint antigo (o limite abaixo do qual o
    // historico pode estar incompleto); "textoCompletoAte" e o ponteiro
    // retomavel de ate onde esse backfill ja avancou. So roda enquanto
    // textoCompletoAte < backfillAlvo - uma vez que alcanca o alvo, nunca
    // mais roda de novo nesse chat.
    //
    // Fase 2 (scan incremental, igual sempre foi): continua de
    // lastScannedMessageId pra frente, pegando so mensagem nova. So comeca
    // se a fase 1 nao foi interrompida (senao o chat fica pra terminar o
    // backfill na proxima vez antes de seguir pra mensagem nova).
    async function escanearTudo(atualizarStatus, apenasChatId, aoAtualizarChat) {
        if (scanEmAndamento) return;
        scanEmAndamento = true;
        cancelarScanSolicitado = false;
        const db = await abrirBanco();
        // So vale a exclusao quando "Todos" esta rodando - escolher um
        // grupo especifico (apenasChatId) sempre escaneia ele, mesmo que
        // esteja desmarcado em "Configurar grupos do scan".
        const excluidos = apenasChatId ? null : carregarGruposExcluidos();
        try {
            for await (const dialog of iterTodosOsDialogs()) {
                if (cancelarScanSolicitado) break;
                if (!(dialog.isGroup || dialog.isChannel)) continue;

                const chatId = String(dialog.id);
                if (apenasChatId && chatId !== apenasChatId) continue;
                if (excluidos && excluidos.has(chatId)) continue;

                const chatTitle = dialog.title || dialog.name || chatId;
                const chatUsername = (dialog.entity && dialog.entity.username) || null;

                const chatSalvo = await buscarChat(db, chatId);

                let backfillAlvo = 0;
                let textoCompletoAte = 0;
                if (chatSalvo) {
                    if (typeof chatSalvo.backfillAlvo === "number") {
                        backfillAlvo = chatSalvo.backfillAlvo;
                        textoCompletoAte = chatSalvo.textoCompletoAte || 0;
                    } else {
                        // chat ja existia de antes dessa funcionalidade -
                        // assume o pior caso (nenhum texto completo do
                        // historico antigo foi salvo ainda)
                        backfillAlvo = chatSalvo.lastScannedMessageId || 0;
                        textoCompletoAte = 0;
                    }
                }
                let lastScannedMessageId = (chatSalvo && chatSalvo.lastScannedMessageId) || 0;
                let cancelado = false;
                const inicio = Date.now();

                console.log("[Top Reacoes] scan:", {
                    chatTitle,
                    chatId,
                    backfillAlvo,
                    textoCompletoAte,
                    lastScannedMessageId,
                });

                const salvarCheckpoint = async (concluido) => {
                    await salvarChat(db, {
                        chatId,
                        chatTitle,
                        chatUsername,
                        lastScannedMessageId,
                        lastScannedAt: new Date().toISOString(),
                        concluido,
                        backfillAlvo,
                        textoCompletoAte,
                    });
                    if (aoAtualizarChat) await aoAtualizarChat();
                };

                // ---- Fase 1: backfill automatico do historico antigo ----
                if (textoCompletoAte < backfillAlvo) {
                    let totalVistas = 0;
                    atualizarStatus(
                        `${chatTitle}: completando historico antigo (mensagem ${textoCompletoAte} ate ${backfillAlvo})...`
                    );
                    for await (const mensagem of cliente.iterMessages(dialog.entity, {
                        minId: textoCompletoAte,
                        maxId: backfillAlvo + 1,
                        reverse: true,
                    })) {
                        if (cancelarScanSolicitado) {
                            cancelado = true;
                            break;
                        }
                        totalVistas++;
                        textoCompletoAte = mensagem.id;

                        const { reactions, total } = extrairReacoes(mensagem);
                        await salvarMensagem(db, {
                            key: chatId + ":" + mensagem.id,
                            chatId,
                            messageId: mensagem.id,
                            dateUtc: dataIso(mensagem),
                            texto: textoCompleto(mensagem),
                            reactionTotal: total,
                            reactions,
                            chatTitle,
                        });

                        if (totalVistas % 500 === 0) {
                            const segundos = Math.round((Date.now() - inicio) / 1000);
                            atualizarStatus(
                                `${chatTitle}: completando historico antigo, ${totalVistas} mensagens (${segundos}s)...`
                            );
                            await salvarCheckpoint(false);
                        }
                    }
                    await salvarCheckpoint(false);
                }

                if (cancelado) {
                    if (apenasChatId) break;
                    continue; // backfill ficou parcial - termina na proxima vez antes de seguir pra mensagem nova
                }

                // ---- Fase 2: scan incremental normal (so mensagem nova) ----
                atualizarStatus(`Escaneando: ${chatTitle} (a partir da mensagem ${lastScannedMessageId})...`);
                let totalVistas = 0;
                let comReacao = 0;
                let terminouSemCancelar = true;

                for await (const mensagem of cliente.iterMessages(dialog.entity, {
                    minId: lastScannedMessageId,
                    reverse: true,
                })) {
                    if (cancelarScanSolicitado) {
                        terminouSemCancelar = false;
                        break;
                    }
                    totalVistas++;
                    lastScannedMessageId = Math.max(lastScannedMessageId, mensagem.id);

                    const { reactions, total } = extrairReacoes(mensagem);
                    // Salva toda mensagem, nao so as com reacao - o texto
                    // completo de tudo e o que permite a busca por palavra-
                    // chave (tela "Buscar mensagens"). reactionTotal fica 0
                    // quando nao tem reacao, e o ranking de "top reacoes"
                    // continua filtrando por ele normalmente.
                    await salvarMensagem(db, {
                        key: chatId + ":" + mensagem.id,
                        chatId,
                        messageId: mensagem.id,
                        dateUtc: dataIso(mensagem),
                        texto: textoCompleto(mensagem),
                        reactionTotal: total,
                        reactions,
                        chatTitle,
                    });
                    if (total > 0) comReacao++;

                    if (totalVistas % 500 === 0) {
                        const segundos = Math.round((Date.now() - inicio) / 1000);
                        atualizarStatus(
                            `${chatTitle}: ${totalVistas} mensagens verificadas (${segundos}s), ${comReacao} com reacao...`
                        );
                        await salvarCheckpoint(false);
                    }
                }

                await salvarCheckpoint(terminouSemCancelar);

                if (apenasChatId) break; // so o grupo escolhido, nao segue pros outros
            }
        } finally {
            scanEmAndamento = false;
        }
    }

    // ---- Tela de resultados ----

    async function telaResultados() {
        definirTituloTela("Top reacoes");
        const corpo = corpoDoPainel();
        botaoVoltar(corpo);

        const db = await abrirBanco();
        // Grupo desmarcado em "Configurar grupos" nao aparece no seletor -
        // ver comentario em renderizarTabelaChats().
        const excluidos = carregarGruposExcluidos();
        const chats = (await listarChats(db)).filter((c) => !excluidos.has(c.chatId));
        chats.sort((a, b) => (a.chatTitle || "").localeCompare(b.chatTitle || ""));

        const filtros = document.createElement("div");
        filtros.style.cssText = "display:flex;gap:8px;margin-bottom:10px;";
        filtros.innerHTML =
            '<select id="trp-filtro-grupo" style="flex:2;min-width:0;background:#0c0e12;color:#e6e8ec;border:1px solid #2a2f3a;border-radius:6px;padding:6px;">' +
            '<option value="">Todos os grupos</option>' +
            "</select>" +
            '<select id="trp-filtro-ordenar" style="flex:1;min-width:0;background:#0c0e12;color:#e6e8ec;border:1px solid #2a2f3a;border-radius:6px;padding:6px;">' +
            '<option value="reacoes">Mais reacoes</option>' +
            '<option value="data">Mais recentes</option>' +
            "</select>" +
            '<input id="trp-filtro-minimo" type="number" min="1" value="1" style="width:56px;flex-shrink:0;background:#0c0e12;color:#e6e8ec;border:1px solid #2a2f3a;border-radius:6px;padding:6px;">';
        corpo.appendChild(filtros);

        const selectGrupo = filtros.querySelector("#trp-filtro-grupo");
        for (const c of chats) {
            const opcao = document.createElement("option");
            opcao.value = c.chatId;
            opcao.textContent = (c.chatTitle || c.chatId) + " (ate msg " + (c.lastScannedMessageId || 0) + ")";
            selectGrupo.appendChild(opcao);
        }
        const selectOrdenar = filtros.querySelector("#trp-filtro-ordenar");
        const inputMinimo = filtros.querySelector("#trp-filtro-minimo");

        // Mesmo filtro de periodo de "Buscar mensagens" - replicado aqui
        // porque as duas telas de pesquisa compartilham praticamente todos
        // os recursos. Em branco nos dois lados = sem filtro de data.
        const filtrosData = document.createElement("div");
        filtrosData.style.cssText = "display:flex;gap:8px;margin-bottom:10px;";
        filtrosData.innerHTML =
            '<div style="flex:1;"><label style="display:block;color:#8b92a3;font-size:11px;margin-bottom:2px;">De (data)</label>' +
            '<input id="trp-top-data-de" type="date" style="width:100%;background:#0c0e12;color:#e6e8ec;border:1px solid #2a2f3a;border-radius:6px;padding:6px;box-sizing:border-box;"></div>' +
            '<div style="flex:1;"><label style="display:block;color:#8b92a3;font-size:11px;margin-bottom:2px;">Ate (data)</label>' +
            '<input id="trp-top-data-ate" type="date" style="width:100%;background:#0c0e12;color:#e6e8ec;border:1px solid #2a2f3a;border-radius:6px;padding:6px;box-sizing:border-box;"></div>';
        corpo.appendChild(filtrosData);
        const inputDataDe = filtrosData.querySelector("#trp-top-data-de");
        const inputDataAte = filtrosData.querySelector("#trp-top-data-ate");

        // Oculta (so na exibicao, nao apaga nada) as mensagens ja marcadas
        // como "visto" na caixinha individual de cada item - pra quem usa
        // essa lista como um "pra fazer" e nao quer ficar rolando por cima
        // do que ja viu toda vez que abre a tela de novo.
        let ocultarVistos = false;
        const blocoOcultarVistos = document.createElement("div");
        blocoOcultarVistos.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:12px;";
        const checkboxOcultarVistos = criarQuadradoMarcavel(false, (marcado) => {
            ocultarVistos = marcado;
            atualizarLista();
        });
        const labelOcultarVistos = document.createElement("span");
        labelOcultarVistos.style.color = "#8b92a3";
        labelOcultarVistos.textContent = "Ocultar as ja marcadas como vistas";
        blocoOcultarVistos.appendChild(checkboxOcultarVistos.elemento);
        blocoOcultarVistos.appendChild(labelOcultarVistos);
        corpo.appendChild(blocoOcultarVistos);

        // Indicador de carregamento SEPARADO da lista - desde que
        // atualizarLista() parou de esvaziar "lista" durante o
        // recarregamento (pra nao causar o salto de scroll), trocar de
        // filtro ou clicar "Mostrar mais" ficou sem nenhum sinal visivel de
        // que algo esta acontecendo enquanto o resultado anterior continua
        // na tela - podia parecer que travou. Esse texto muda sozinho, nunca
        // toca em "lista", entao nao reintroduz o problema de scroll.
        const statusCarregando = document.createElement("div");
        statusCarregando.style.cssText = "color:#8b92a3;font-size:11px;min-height:14px;margin-bottom:4px;";
        corpo.appendChild(statusCarregando);

        const lista = document.createElement("div");
        corpo.appendChild(lista);

        if (!chats.length) {
            lista.innerHTML = '<div style="color:#8b92a3;">Nenhum grupo escaneado ainda. Roda o scan primeiro.</div>';
            return;
        }

        // Limite cresce com "Mostrar mais" - comeca em 50. Esse limite (fixo
        // em 50 e sem jeito de pedir mais) era o motivo de mensagem com
        // reacao suficiente "sumir" da lista: com "Todos os grupos"
        // selecionado, o ranking mistura todo mundo, entao uma mensagem de
        // um grupo pode ficar fora dos top 50 globais mesmo tendo mais
        // reacao que mensagens exibidas de outro grupo.
        let limiteAtual = 50;

        async function atualizarLista() {
            // So mostra "Carregando..." quando a lista esta mesmo vazia (
            // primeira carga). Em "Mostrar mais" ou troca de filtro ja tem
            // conteudo antigo na tela - ele fica exibido sem mudanca ate os
            // dados novos chegarem, e so entao o conteudo e trocado tudo de
            // uma vez (sem await no meio). Antes disso aqui reescrevia
            // lista.innerHTML pra "Carregando..." antes do await: o
            // navegador tinha a chance de pintar essa lista vazia e
            // recalcular/zerar o scroll do painel antes da funcao
            // retomar - restaurar o scroll depois (mesmo com
            // requestAnimationFrame) nao bastava porque o salto ja tinha
            // acontecido. Nao esvaziar a lista enquanto busca elimina o
            // problema na raiz, em vez de tentar compensar depois.
            if (!lista.childNodes.length) {
                lista.innerHTML = '<div style="color:#8b92a3;">Carregando...</div>';
            }
            statusCarregando.textContent = "Carregando...";
            const chatId = selectGrupo.value || null;
            const minimo = parseInt(inputMinimo.value, 10) || 1;
            const dataDe = inputDataDe.value || null;
            const dataAte = inputDataAte.value || null;
            const ordenarPor = selectOrdenar.value;
            const mensagens = await buscarTop(db, { chatId, minimo, limite: limiteAtual, dataDe, dataAte, ordenarPor });
            statusCarregando.textContent = "";
            if (!mensagens.length) {
                lista.innerHTML = '<div style="color:#8b92a3;">Nenhuma mensagem encontrada com esse filtro.</div>';
                return;
            }
            // Filtro de exibicao, nao de dados - "Mostrar mais" (logo
            // abaixo) continua olhando mensagens.length (antes do filtro),
            // pra saber se tem mais resultado la na frente mesmo que tudo
            // que coube nesta pagina ja tenha sido visto.
            const visiveis = ocultarVistos ? mensagens.filter((m) => !m.visto) : mensagens;
            if (!visiveis.length) {
                lista.innerHTML =
                    '<div style="color:#8b92a3;">Todas as mensagens desse filtro ja foram marcadas como vistas.</div>';
                if (mensagens.length >= limiteAtual) {
                    const botaoMais = botaoAcao(lista, "Mostrar mais");
                    botaoMais.addEventListener("click", async () => {
                        limiteAtual += 50;
                        await atualizarLista();
                    });
                }
                return;
            }

            const novoConteudo = document.createDocumentFragment();
            for (const m of visiveis) {
                const item = document.createElement("div");
                item.style.cssText =
                    "padding:8px 0;border-bottom:1px solid #2a2f3a;display:flex;gap:8px;align-items:flex-start;" +
                    (m.visto ? "opacity:0.55;" : "");

                const quadrado = criarQuadradoMarcavel(m.visto, (novoValor) => {
                    marcarVisto(db, m.key, novoValor);
                    item.style.opacity = novoValor ? "0.55" : "1";
                });
                item.appendChild(quadrado.elemento);

                const conteudo = document.createElement("div");
                conteudo.style.cssText = "flex:1;min-width:0;";
                conteudo.innerHTML =
                    '<div style="color:#4da3ff;font-weight:600;cursor:pointer;" class="trp-abrir">' +
                    m.reactionTotal +
                    " reacoes - " +
                    escapeHtml(m.dateUtc.slice(0, 10)) +
                    "</div>" +
                    '<div style="color:#8b92a3;font-size:11px;">' +
                    escapeHtml(m.chatTitle) +
                    "</div>" +
                    "<div>" +
                    escapeHtml(truncar(m.texto || m.textPreview || "", 160)) +
                    "</div>";
                conteudo.querySelector(".trp-abrir").addEventListener("click", () => {
                    const url = "https://web.telegram.org/k/#" + idBaseDoChatId(m.chatId) + "?post=" + m.messageId;
                    console.log("[Top Reacoes] abrindo:", url);
                    window.open(url, "_blank");
                });
                item.appendChild(conteudo);
                novoConteudo.appendChild(item);
            }

            // Troca tudo de uma vez, sem await entre o esvaziar e o
            // repopular - o navegador nunca chega a pintar um estado vazio
            // no meio do caminho.
            lista.innerHTML = "";
            lista.appendChild(novoConteudo);

            if (mensagens.length >= limiteAtual) {
                const botaoMais = botaoAcao(lista, "Mostrar mais");
                botaoMais.addEventListener("click", async () => {
                    limiteAtual += 50;
                    await atualizarLista();
                });
            }
        }

        selectGrupo.addEventListener("change", () => {
            limiteAtual = 50;
            atualizarLista();
        });
        selectOrdenar.addEventListener("change", () => {
            limiteAtual = 50;
            atualizarLista();
        });
        inputMinimo.addEventListener("change", () => {
            limiteAtual = 50;
            atualizarLista();
        });
        inputDataDe.addEventListener("change", () => {
            limiteAtual = 50;
            atualizarLista();
        });
        inputDataAte.addEventListener("change", () => {
            limiteAtual = 50;
            atualizarLista();
        });
        await atualizarLista();
    }

    // ---- Tela de busca por palavra-chave ----

    async function telaBusca() {
        definirTituloTela("Buscar mensagens");
        const corpo = corpoDoPainel();
        botaoVoltar(corpo);

        const db = await abrirBanco();
        // Grupo desmarcado em "Configurar grupos" nao aparece no seletor -
        // ver comentario em renderizarTabelaChats().
        const excluidos = carregarGruposExcluidos();
        const chats = (await listarChats(db)).filter((c) => !excluidos.has(c.chatId));
        chats.sort((a, b) => (a.chatTitle || "").localeCompare(b.chatTitle || ""));

        const aviso = document.createElement("div");
        aviso.style.cssText = "display:flex;align-items:center;gap:4px;color:#8b92a3;margin-bottom:10px;";
        aviso.innerHTML =
            "<span>Busca so dentro do que ja foi escaneado.</span>" +
            criarIconeInfoHtml(
                'Grupo escaneado antes dessa funcao existir completa o texto do historico antigo sozinho na proxima vez que passar pelo scan (tela de scan mostra "completando historico antigo" enquanto isso roda).'
            );
        corpo.appendChild(aviso);

        const filtros = document.createElement("div");
        filtros.style.cssText = "display:flex;gap:8px;margin-bottom:10px;";
        filtros.innerHTML =
            '<select id="trp-busca-grupo" style="flex:2;min-width:0;background:#0c0e12;color:#e6e8ec;border:1px solid #2a2f3a;border-radius:6px;padding:6px;">' +
            '<option value="">Todos os grupos</option>' +
            "</select>" +
            '<select id="trp-busca-ordenar" style="flex:1;min-width:0;background:#0c0e12;color:#e6e8ec;border:1px solid #2a2f3a;border-radius:6px;padding:6px;">' +
            '<option value="data">Mais recentes</option>' +
            '<option value="reacoes">Mais reacoes</option>' +
            "</select>" +
            '<input id="trp-busca-minimo" type="number" min="0" value="0" title="Minimo de reacoes" style="width:56px;flex-shrink:0;background:#0c0e12;color:#e6e8ec;border:1px solid #2a2f3a;border-radius:6px;padding:6px;">';
        corpo.appendChild(filtros);
        const selectGrupo = filtros.querySelector("#trp-busca-grupo");
        const selectOrdenar = filtros.querySelector("#trp-busca-ordenar");
        const inputMinimo = filtros.querySelector("#trp-busca-minimo");
        for (const c of chats) {
            const opcao = document.createElement("option");
            opcao.value = c.chatId;
            opcao.textContent = c.chatTitle || c.chatId;
            selectGrupo.appendChild(opcao);
        }

        // Filtro por periodo - opcional, deixa os dois em branco pra nao
        // filtrar por data nenhuma. Compara contra dateUtc (ISO), entao
        // funciona so com o texto "AAAA-MM-DD" que o proprio <input
        // type="date"> devolve.
        const filtrosData = document.createElement("div");
        filtrosData.style.cssText = "display:flex;gap:8px;margin-bottom:10px;";
        filtrosData.innerHTML =
            '<div style="flex:1;"><label style="display:block;color:#8b92a3;font-size:11px;margin-bottom:2px;">De (data)</label>' +
            '<input id="trp-busca-data-de" type="date" style="width:100%;background:#0c0e12;color:#e6e8ec;border:1px solid #2a2f3a;border-radius:6px;padding:6px;box-sizing:border-box;"></div>' +
            '<div style="flex:1;"><label style="display:block;color:#8b92a3;font-size:11px;margin-bottom:2px;">Ate (data)</label>' +
            '<input id="trp-busca-data-ate" type="date" style="width:100%;background:#0c0e12;color:#e6e8ec;border:1px solid #2a2f3a;border-radius:6px;padding:6px;box-sizing:border-box;"></div>';
        corpo.appendChild(filtrosData);
        const inputDataDe = filtrosData.querySelector("#trp-busca-data-de");
        const inputDataAte = filtrosData.querySelector("#trp-busca-data-ate");

        const campoBusca = campoTexto(corpo, "Palavra ou trecho a buscar (em branco = todas as mensagens)", "text");
        const historicoBusca = ligarHistoricoBusca(campoBusca, CHAVE_HISTORICO_BUSCA_LOCAL);

        // Busca hibrida: alem do nosso banco local (substring, OU logico
        // entre as palavras), tambem pergunta ao vivo pro SERVIDOR do
        // Telegram (o mesmo messages.Search que a busca nativa usa, via
        // cliente.iterMessages com a opcao "search"). Os dois sistemas sao
        // independentes (ver HISTORICO_TECNICO.md, secao sobre a pesquisa
        // nessa diferenca) - um pega o que o outro perde, por razoes
        // diferentes. Mensagem que o servidor acha e a gente ainda nao
        // tinha salva localmente e salva na hora (conserta o buraco de
        // scan sozinho, de brinde). So funciona com um grupo especifico
        // selecionado - "Todos os grupos" faria uma chamada por grupo
        // escaneado, arriscando flood wait sem necessidade.
        const blocoServidor = document.createElement("div");
        blocoServidor.style.cssText = "display:flex;align-items:flex-start;gap:8px;margin:6px 0 10px;font-size:12px;";
        const checkboxServidor = criarQuadradoMarcavel(false, null);
        const labelServidor = document.createElement("span");
        labelServidor.style.color = "#8b92a3";
        labelServidor.textContent = "Tambem buscar ao vivo no servidor do Telegram";
        blocoServidor.appendChild(checkboxServidor.elemento);
        blocoServidor.appendChild(labelServidor);
        blocoServidor.insertAdjacentHTML(
            "beforeend",
            criarIconeInfoHtml(
                'Pega mensagem que o scan local ainda nao tem. Precisa de um grupo especifico selecionado - nao funciona com "Todos os grupos" (faria uma chamada por grupo escaneado, arriscando bloqueio temporario por excesso de pedidos).'
            )
        );
        corpo.appendChild(blocoServidor);

        // Oculta (so na exibicao) as mensagens ja marcadas como vista -
        // mesmo recurso de "Ver top reacoes", ver comentario la.
        let ocultarVistos = false;
        const blocoOcultarVistos = document.createElement("div");
        blocoOcultarVistos.style.cssText = "display:flex;align-items:center;gap:8px;margin-bottom:10px;font-size:12px;";
        const checkboxOcultarVistos = criarQuadradoMarcavel(false, (marcado) => {
            ocultarVistos = marcado;
            if (jaBuscou) executarBusca();
        });
        const labelOcultarVistos = document.createElement("span");
        labelOcultarVistos.style.color = "#8b92a3";
        labelOcultarVistos.textContent = "Ocultar as ja marcadas como vistas";
        blocoOcultarVistos.appendChild(checkboxOcultarVistos.elemento);
        blocoOcultarVistos.appendChild(labelOcultarVistos);
        corpo.appendChild(blocoOcultarVistos);

        // So funciona com um grupo especifico - com "Todos os grupos" a
        // caixa fica visivelmente desabilitada (nao so um aviso em texto que
        // da pra nao notar) e e desmarcada sozinha, pra nunca ficar marcada
        // enganando o usuario que ela esta fazendo busca ao vivo em tudo
        // quando na pratica nao faz nada nesse estado.
        function atualizarDisponibilidadeServidor() {
            const disponivel = !!selectGrupo.value;
            checkboxServidor.elemento.style.opacity = disponivel ? "1" : "0.35";
            checkboxServidor.elemento.style.pointerEvents = disponivel ? "" : "none";
            labelServidor.style.opacity = disponivel ? "1" : "0.55";
            if (!disponivel && checkboxServidor.checked) {
                checkboxServidor.checked = false;
            }
        }
        atualizarDisponibilidadeServidor();

        const botaoBuscar = botaoAcao(corpo, "Buscar");

        // Ver comentario igual em telaResultados() - indicador separado da
        // lista, pra trocar de termo/filtro continuar com algum sinal visual
        // de "carregando" mesmo que o resultado anterior fique exibido sem
        // mudanca ate o novo chegar (de propostio, pra nao repetir o salto de
        // scroll que existia antes).
        const statusCarregando = document.createElement("div");
        statusCarregando.style.cssText = "color:#8b92a3;font-size:11px;min-height:14px;margin-bottom:4px;";
        corpo.appendChild(statusCarregando);

        const lista = document.createElement("div");
        lista.innerHTML =
            '<div style="color:#8b92a3;">Digita algo pra buscar, ou deixa em branco e aperta "Buscar" pra trazer todas as mensagens (sujeito aos filtros de grupo/data/minimo).</div>';
        corpo.appendChild(lista);

        // Cresce com "Mostrar mais" - comeca em 100. buscarTexto() ja
        // devolve o conjunto inteiro de resultados ordenado (por reacoes ou
        // data) antes de cortar pro limite atual, entao "Mostrar mais" so
        // revela mais itens mais abaixo nessa lista ja ordenada - nao existe
        // mais risco de um grupo sozinho "engolir" o limite e esconder os
        // demais (ver nota em cima de buscarTexto()).
        let limiteAtual = 100;
        // Vira true na primeira vez que o usuario aperta "Buscar"/Enter -
        // so a partir dai os filtros (grupo/ordenar/minimo/data/ocultar
        // vistos) re-executam a busca sozinhos ao mudar. Antes disso, mudar
        // um filtro nao faz nada (a tela ainda nao tem nenhum resultado pra
        // atualizar). Campo em branco agora E uma busca valida (ver nota
        // em executarBusca()), entao nao da mais pra usar
        // "campoBusca.value.trim()" como sinal de "ja buscou alguma vez".
        let jaBuscou = false;

        function criarItemResultado(m) {
            const texto = m.texto || m.textPreview || "";
            const item = document.createElement("div");
            item.style.cssText =
                "padding:8px 0;border-bottom:1px solid #2a2f3a;display:flex;gap:8px;align-items:flex-start;" +
                (m.visto ? "opacity:0.55;" : "");

            const quadrado = criarQuadradoMarcavel(m.visto, (novoValor) => {
                marcarVisto(db, m.key, novoValor);
                item.style.opacity = novoValor ? "0.55" : "1";
            });
            item.appendChild(quadrado.elemento);

            const conteudo = document.createElement("div");
            conteudo.style.cssText = "flex:1;min-width:0;";
            conteudo.innerHTML =
                '<div style="color:#4da3ff;font-weight:600;cursor:pointer;" class="trp-abrir">' +
                escapeHtml(m.dateUtc.slice(0, 10)) +
                (m.reactionTotal ? " - " + m.reactionTotal + " reacoes" : "") +
                "</div>" +
                '<div style="color:#8b92a3;font-size:11px;">' +
                escapeHtml(m.chatTitle) +
                (m.achadoNoServidor
                    ? ' <span style="color:#5ec26a;">· achado ao vivo no servidor, salvo agora</span>'
                    : "") +
                "</div>" +
                "<div>" +
                escapeHtml(truncar(texto, 200)) +
                "</div>";
            conteudo.querySelector(".trp-abrir").addEventListener("click", () => {
                const url = "https://web.telegram.org/k/#" + idBaseDoChatId(m.chatId) + "?post=" + m.messageId;
                console.log("[Top Reacoes] abrindo:", url);
                window.open(url, "_blank");
            });
            item.appendChild(conteudo);
            return item;
        }

        // Cabecalho clicavel de grupo (maximizar/minimizar) usado quando a
        // busca e em "Todos" e o resultado tem mais de um grupo.
        function criarCabecalhoGrupo(chatTitle, quantidade) {
            const cabecalho = document.createElement("div");
            cabecalho.style.cssText =
                "display:flex;align-items:center;gap:6px;padding:6px 0;cursor:pointer;user-select:none;" +
                "color:#8b92a3;font-weight:600;font-size:12px;border-top:1px solid #2a2f3a;margin-top:4px;";
            const seta = document.createElement("span");
            seta.textContent = "▾";
            const texto = document.createElement("span");
            texto.textContent = chatTitle + " (" + quantidade + ")";
            cabecalho.appendChild(seta);
            cabecalho.appendChild(texto);
            return { cabecalho, seta };
        }

        // Busca ao vivo no servidor (messages.Search, o mesmo mecanismo da
        // busca nativa) pra UM grupo especifico - novas mensagens achadas
        // que nao estavam salvas localmente sao salvas na hora (conserta o
        // buraco sozinho). Separado de buscarTexto() porque e uma fonte de
        // dados completamente diferente (servidor, ao vivo) em vez de ler o
        // IndexedDB local.
        async function buscarAoVivoNoServidor(chatId, termo, minimoReacoes) {
            const entidade = await encontrarEntidadePorChatId(chatId);
            if (!entidade) {
                throw new Error("grupo nao encontrado entre os dialogs dessa conta agora");
            }
            const chatInfo = chats.find((c) => c.chatId === chatId);
            const chatTitle = (chatInfo && chatInfo.chatTitle) || chatId;
            const resultados = [];
            for await (const mensagem of cliente.iterMessages(entidade, { search: termo, limit: 50 })) {
                const { reactions, total } = extrairReacoes(mensagem);
                if (total < minimoReacoes) continue;
                resultados.push({
                    key: chatId + ":" + mensagem.id,
                    chatId,
                    messageId: mensagem.id,
                    dateUtc: dataIso(mensagem),
                    texto: textoCompleto(mensagem),
                    reactionTotal: total,
                    reactions,
                    chatTitle,
                });
            }
            return resultados;
        }

        async function executarBusca() {
            const termo = campoBusca.value.trim();
            jaBuscou = true;
            // Campo em branco agora e uma busca valida (de proposito -
            // pedido do usuario pra poder "mostrar tudo" sem precisar
            // digitar uma letra quase universal) - buscarTexto() trata
            // termo vazio como "bate com qualquer mensagem" (ver comentario
            // la). So nao registra no historico de autocomplete um termo
            // em branco, isso nao ajudaria ninguem.
            if (termo) historicoBusca.registrar(termo);
            // So mostra "Buscando..." na propria lista quando ela ja esta
            // vazia (primeira busca desse termo). Em "Mostrar mais" ou troca
            // de termo/filtro a lista ja tem resultado anterior na tela -
            // fica do jeito que esta, sem piscar pra vazio, ate os dados
            // novos chegarem prontos pra trocar tudo de uma vez (ver
            // comentario mais abaixo, perto do "Mostrar mais"). Isso faz o
            // "esta buscando" sumir visualmente nesses casos - statusCarregando
            // (elemento separado, nunca esvaziado por engano) cobre esse
            // aviso em todo clique de busca, inclusive quando a busca ao
            // vivo no servidor (mais lenta, round-trip de rede de verdade)
            // deixa a tela "parada" por um tempo sem nenhum sinal.
            if (!lista.childNodes.length) {
                lista.innerHTML = '<div style="color:#8b92a3;">Buscando...</div>';
            }
            statusCarregando.textContent = "Buscando...";
            try {
                await executarBuscaPorDentro();
            } finally {
                statusCarregando.textContent = "";
            }
        }

        async function executarBuscaPorDentro() {
            const termo = campoBusca.value.trim();
            const chatId = selectGrupo.value || null;
            const minimo = parseInt(inputMinimo.value, 10) || 0;
            const ordenarPor = selectOrdenar.value;
            const dataDe = inputDataDe.value || null;
            const dataAte = inputDataAte.value || null;
            const mensagens = await buscarTexto(db, {
                termo,
                chatId,
                minimo,
                limite: limiteAtual,
                ordenarPor,
                dataDe,
                dataAte,
            });

            let novasDoServidor = [];
            let erroServidor = null;
            if (checkboxServidor.checked && chatId) {
                try {
                    const chavesLocais = new Set(mensagens.map((m) => m.key));
                    const doServidor = await buscarAoVivoNoServidor(chatId, termo, minimo);
                    // Salva TODA mensagem que o servidor achou e a gente ainda
                    // nao tinha - o filtro de data abaixo e so pra exibicao
                    // nesta busca, nao deve impedir de consertar um buraco de
                    // scan que esteja fora do periodo escolhido agora.
                    const novasNoServidor = doServidor.filter((m) => !chavesLocais.has(m.key));
                    for (const m of novasNoServidor) {
                        await salvarMensagem(db, m);
                    }
                    novasDoServidor = novasNoServidor
                        .filter((m) => {
                            const dataDaMensagem = (m.dateUtc || "").slice(0, 10);
                            return (!dataDe || dataDaMensagem >= dataDe) && (!dataAte || dataDaMensagem <= dataAte);
                        })
                        .map((m) => ({ ...m, achadoNoServidor: true }));
                } catch (erro) {
                    erroServidor = erro && erro.message ? erro.message : String(erro);
                }
            }

            const todasAsMensagens = mensagens.concat(novasDoServidor);
            if (ordenarPor === "reacoes") {
                todasAsMensagens.sort((a, b) => (b.reactionTotal || 0) - (a.reactionTotal || 0));
            } else {
                todasAsMensagens.sort((a, b) => (a.dateUtc < b.dateUtc ? 1 : -1));
            }

            if (!todasAsMensagens.length) {
                lista.innerHTML = erroServidor
                    ? '<div style="color:#ff6b6b;">Nada encontrado local, e a busca ao vivo no servidor falhou: ' +
                      escapeHtml(erroServidor) +
                      "</div>"
                    : '<div style="color:#8b92a3;">Nada encontrado com esse termo.</div>';
                return;
            }
            // Filtro de exibicao (ocultarVistos), nao de dados - "Mostrar
            // mais" continua olhando mensagens.length (antes desse
            // filtro), ver mesmo comentario em telaResultados().
            const visiveis = ocultarVistos ? todasAsMensagens.filter((m) => !m.visto) : todasAsMensagens;
            if (!visiveis.length) {
                lista.innerHTML =
                    '<div style="color:#8b92a3;">Todas as mensagens encontradas ja foram marcadas como vistas.</div>';
                if (mensagens.length >= limiteAtual) {
                    const botaoMais = botaoAcao(lista, "Mostrar mais");
                    botaoMais.addEventListener("click", async () => {
                        limiteAtual += 100;
                        await executarBusca();
                    });
                }
                return;
            }
            // Monta tudo num fragmento fora da tela primeiro, e so troca o
            // conteudo real da lista no final, de uma vez (sem await no
            // meio). Antes disso aqui fazia lista.innerHTML = "" e ia
            // enchendo lista aos poucos - no "Mostrar mais" isso fazia a
            // lista ficar vazia (encolhendo o painel) bem no instante em
            // que o navegador podia pintar/recalcular o scroll, travando-o
            // em 0 antes do conteudo novo terminar de entrar. Com o
            // fragmento, a lista antiga fica exibida sem mudanca ate o
            // ultimo instante - nunca existe um estado vazio pro navegador
            // pintar, entao o scroll nunca precisa ser restaurado.
            const novoConteudo = document.createDocumentFragment();

            if (erroServidor) {
                const aviso = document.createElement("div");
                aviso.style.cssText = "color:#ff6b6b;font-size:11px;margin-bottom:6px;";
                aviso.textContent =
                    "Busca ao vivo no servidor falhou (" + erroServidor + ") - resultado abaixo e so o local.";
                novoConteudo.appendChild(aviso);
            }
            if (novasDoServidor.length) {
                const aviso = document.createElement("div");
                aviso.style.cssText = "color:#5ec26a;font-size:11px;margin-bottom:6px;";
                aviso.textContent =
                    novasDoServidor.length +
                    " mensagem(ns) achada(s) ao vivo no servidor que nao estavam salvas local - ja salvei agora.";
                novoConteudo.appendChild(aviso);
            }

            const maisDeUmGrupo = !chatId && visiveis.some((m) => m.chatId !== visiveis[0].chatId);
            if (maisDeUmGrupo) {
                for (const grupo of agruparPorChat(visiveis)) {
                    const { cabecalho, seta } = criarCabecalhoGrupo(grupo.chatTitle, grupo.itens.length);
                    const containerItens = document.createElement("div");
                    cabecalho.addEventListener("click", () => {
                        const estaAberto = containerItens.style.display !== "none";
                        containerItens.style.display = estaAberto ? "none" : "block";
                        seta.textContent = estaAberto ? "▸" : "▾";
                    });
                    novoConteudo.appendChild(cabecalho);
                    novoConteudo.appendChild(containerItens);
                    for (const m of grupo.itens) containerItens.appendChild(criarItemResultado(m));
                }
            } else {
                for (const m of visiveis) novoConteudo.appendChild(criarItemResultado(m));
            }

            lista.innerHTML = "";
            lista.appendChild(novoConteudo);

            if (mensagens.length >= limiteAtual) {
                const botaoMais = botaoAcao(lista, "Mostrar mais");
                botaoMais.addEventListener("click", async () => {
                    limiteAtual += 100;
                    await executarBusca();
                });
            }
        }

        botaoBuscar.addEventListener("click", () => {
            limiteAtual = 100;
            executarBusca();
        });
        campoBusca.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") {
                limiteAtual = 100;
                executarBusca();
            }
        });
        selectGrupo.addEventListener("change", () => {
            atualizarDisponibilidadeServidor();
            limiteAtual = 100;
            if (jaBuscou) executarBusca();
        });
        selectOrdenar.addEventListener("change", () => {
            limiteAtual = 100;
            if (jaBuscou) executarBusca();
        });
        inputMinimo.addEventListener("change", () => {
            limiteAtual = 100;
            if (jaBuscou) executarBusca();
        });
        inputDataDe.addEventListener("change", () => {
            limiteAtual = 100;
            if (jaBuscou) executarBusca();
        });
        inputDataAte.addEventListener("change", () => {
            limiteAtual = 100;
            if (jaBuscou) executarBusca();
        });
    }

    // ---- Tela de busca avancada: pesquisa global do Telegram (canais/grupos publicos que a conta nao participa) ----

    // Usa channels.SearchPosts, metodo oficial do Telegram pra busca global de
    // conteudo em canais/supergrupos publicos (inclusive os que a conta nao
    // participa) - so alcanca grupo/canal publico (com @usuario), nunca grupo
    // fechado. Dois modos, mutuamente exclusivos (a API exige exatamente um):
    // hashtag (sem custo documentado) ou texto livre (cada conta tem uma cota
    // diaria gratis, documentada via channels.CheckSearchPostsFlood; depois
    // da cota, cada busca cobra em Telegram Stars). Independente do scan local
    // - e so mais uma chamada na mesma conexao, da pra abrir essa tela com o
    // scan rodando em segundo plano sem nenhum problema.
    async function telaBuscaAvancada() {
        definirTituloTela("Busca avancada");
        const corpo = corpoDoPainel();
        botaoVoltar(corpo);

        const aviso = document.createElement("div");
        aviso.style.cssText = "display:flex;align-items:center;gap:4px;color:#8b92a3;margin-bottom:10px;";
        aviso.innerHTML =
            '<span>Busca GLOBAL em canais/grupos com (ou que ja tiveram) @usuario publico, mesmo sem a conta participar.</span>' +
            criarIconeInfoHtml(
                '"Publico" aqui e so isso, nao tem nada a ver com o grupo exigir aprovacao pra alguem entrar: um grupo pode pedir aprovacao de novo membro e mesmo assim aparecer aqui, porque ler/buscar nao exige ser membro, so mandar mensagem exige. Grupo sem @usuario nenhum (so com link de convite) nunca aparece aqui - precisaria ter entrado nele pra alcancar o conteudo (ver tela de "Buscar mensagens"). Segundo o proprio blog do Telegram (ago/2025), esse recurso "e inicialmente disponivel so pra contas Premium" - a documentacao oficial do metodo (core.telegram.org/method/channels.searchPosts) descreve a cota diaria gratis e o pagamento em Stars como algo que vale so pra "full text post searches (query)", sem mencionar nada parecido pra busca por hashtag; bate com o que foi testado aqui (busca por HASHTAG funcionou sem Premium, por TEXTO LIVRE deu erro de conta Premium exigida).'
            );
        corpo.appendChild(aviso);

        // Busca por NOME (contacts.search) - diferente da busca por
        // hashtag/texto livre logo abaixo, que procura DENTRO do conteudo
        // das mensagens (channels.SearchPosts). Pedido do usuario depois de
        // testar a busca por post com termo generico e so achar grupo em
        // outro idioma/assunto: ele queria achar O GRUPO (ex.: "tem grupo do
        // Palmeiras?"), nao um post que por acaso menciona a palavra. Isso
        // e exatamente pra isso - mesma ideia de diretorio de grupo que
        // sites externos (tipo agregador de link de convite por categoria)
        // oferecem, so que direto na API oficial do Telegram, sem precisar
        // de site nenhum. contacts.search e publico, sem cota/Premium/Stars
        // documentado (so erro de validacao se o texto vier vazio/curto
        // demais) - NAO entra em nada, so lista.
        const tituloPorNome = document.createElement("div");
        tituloPorNome.style.cssText =
            "color:#8b92a3;margin-bottom:6px;font-weight:600;display:flex;align-items:center;gap:4px;";
        tituloPorNome.innerHTML =
            "<span>Buscar grupo/canal/usuario por NOME</span>" +
            criarIconeInfoHtml(
                'Diferente da busca por hashtag/texto livre (mais abaixo), que procura DENTRO do conteudo das mensagens - por isso um termo generico acha post de qualquer assunto, ate em outro idioma. Essa aqui procura pelo NOME/username do proprio grupo/canal/usuario, igual a lupa de busca do Telegram - sem cota, sem Premium, sem Stars.'
            );
        corpo.appendChild(tituloPorNome);

        const campoBuscaPorNome = campoTexto(corpo, 'Nome ou @username (ex.: "Palmeiras")', "text");
        const botaoBuscarPorNome = botaoAcao(corpo, "Buscar por nome");
        const listaPorNome = document.createElement("div");
        listaPorNome.style.marginBottom = "16px";
        corpo.appendChild(listaPorNome);

        async function buscarPorNome() {
            const termo = campoBuscaPorNome.value.trim();
            if (!termo) {
                listaPorNome.innerHTML = '<div style="color:#ff6b6b;font-size:12px;">Digita um nome pra buscar.</div>';
                return;
            }
            listaPorNome.innerHTML = '<div style="color:#8b92a3;font-size:12px;">Buscando...</div>';
            try {
                const resultado = await cliente.invoke(new Api.contacts.Search({ q: termo, limit: 20 }));
                listaPorNome.innerHTML = "";
                const grupos = resultado.chats || [];
                const usuarios = resultado.users || [];
                if (!grupos.length && !usuarios.length) {
                    listaPorNome.innerHTML = '<div style="color:#8b92a3;font-size:12px;">Nada encontrado com esse nome.</div>';
                    return;
                }
                for (const chat of grupos) {
                    const linha = document.createElement("div");
                    linha.style.cssText = "padding:6px 0;border-bottom:1px solid #2a2f3a;font-size:12px;";
                    const membros =
                        typeof chat.participantsCount === "number" ? chat.participantsCount + " membros" : null;
                    const usuario = chat.username ? "@" + chat.username : null;
                    linha.innerHTML =
                        '<span style="color:#4da3ff;">[grupo/canal]</span> ' +
                        escapeHtml(chat.title || String(chat.id)) +
                        (usuario ? " (" + escapeHtml(usuario) + ")" : "") +
                        (membros ? ' <span style="color:#8b92a3;">- ' + membros + "</span>" : "");
                    listaPorNome.appendChild(linha);
                }
                for (const usr of usuarios) {
                    const linha = document.createElement("div");
                    linha.style.cssText = "padding:6px 0;border-bottom:1px solid #2a2f3a;font-size:12px;";
                    const nome = [usr.firstName, usr.lastName].filter(Boolean).join(" ") || "(sem nome)";
                    const usuario = usr.username ? "@" + usr.username : null;
                    linha.innerHTML =
                        '<span style="color:#8b92a3;">[usuario]</span> ' +
                        escapeHtml(nome) +
                        (usuario ? " (" + escapeHtml(usuario) + ")" : "");
                    listaPorNome.appendChild(linha);
                }
            } catch (erro) {
                listaPorNome.innerHTML =
                    '<div style="color:#ff6b6b;font-size:12px;">Erro: ' +
                    escapeHtml(erro && erro.message ? erro.message : String(erro)) +
                    "</div>";
            }
        }
        botaoBuscarPorNome.addEventListener("click", buscarPorNome);
        campoBuscaPorNome.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") buscarPorNome();
        });

        const tituloConteudo = document.createElement("div");
        tituloConteudo.style.cssText = "color:#8b92a3;margin-bottom:6px;font-weight:600;";
        tituloConteudo.textContent = "Buscar por conteudo de post (hashtag ou texto livre)";
        corpo.appendChild(tituloConteudo);

        const statusCota = document.createElement("div");
        statusCota.style.cssText = "color:#8b92a3;margin-bottom:10px;font-size:11px;";
        statusCota.textContent = "Verificando cota de busca por texto livre...";
        corpo.appendChild(statusCota);

        // Guarda a ultima cota conhecida (ver executarBuscaGlobal) pra
        // decidir, se a busca em texto livre falhar por cota esgotada, se
        // vale oferecer o botao de pagar em Stars - sem precisar checar nem
        // mostrar Stars antes de realmente precisar.
        let ultimaCota = null;

        cliente
            .invoke(new Api.channels.CheckSearchPostsFlood({}))
            .then((cota) => {
                ultimaCota = cota;
                if (cota.queryIsFree) {
                    statusCota.textContent = "Busca por texto livre: sem custo agora.";
                    return;
                }
                statusCota.textContent =
                    `Busca por texto livre: ${cota.remains ?? "?"} de ${cota.totalDaily ?? "?"} gratis restantes hoje` +
                    (cota.remains > 0 ? "." : ` - a proxima custa ${cota.starsAmount ?? "?"} Stars.`);
            })
            .catch((erro) => {
                statusCota.textContent =
                    "Nao consegui checar a cota de texto livre: " + (erro && erro.message ? erro.message : erro);
            });

        const blocoModo = document.createElement("div");
        blocoModo.style.cssText = "display:flex;align-items:flex-start;gap:8px;margin-bottom:10px;font-size:12px;";
        const checkboxHashtag = criarQuadradoMarcavel(false, null);
        const labelModo = document.createElement("span");
        labelModo.textContent = "Buscar por hashtag (sem #) em vez de texto livre";
        blocoModo.appendChild(checkboxHashtag.elemento);
        blocoModo.appendChild(labelModo);
        blocoModo.insertAdjacentHTML(
            "beforeend",
            criarIconeInfoHtml(
                'So no modo hashtag: da pra buscar VARIAS hashtags de uma vez, separadas por ";" (ex.: "promocao;oferta;desconto") - cada uma vira uma chamada separada pro servidor, os resultados saem juntos numa lista so, sem duplicata. So funciona assim no modo hashtag porque ele nao tem o limite de cota/Premium do texto livre (ver aviso no topo da tela) - no modo texto livre, ";" e tratado como parte literal do termo, nao separa nada (cada busca extra consumiria mais da cota diaria/Stars).'
            )
        );
        corpo.appendChild(blocoModo);

        // Extrai link t.me (de @usuario ou de convite) do TEXTO das mensagens
        // encontradas e confere se cada um ainda e valido - serve pra quem
        // esta procurando grupo/canal relacionado a um assunto (a palavra-
        // chave) sem precisar clicar em cada link achado so pra descobrir se
        // ainda existe. Mais lento (uma chamada de API por link novo), por
        // isso opcional.
        const blocoLinks = document.createElement("div");
        blocoLinks.style.cssText = "display:flex;align-items:flex-start;gap:8px;margin-bottom:10px;font-size:12px;";
        const checkboxLinks = criarQuadradoMarcavel(false, null);
        const labelLinks = document.createElement("span");
        labelLinks.textContent = "Tambem extrair e verificar link de grupo/canal nos resultados";
        blocoLinks.appendChild(checkboxLinks.elemento);
        blocoLinks.appendChild(labelLinks);
        blocoLinks.insertAdjacentHTML(
            "beforeend",
            criarIconeInfoHtml(
                "Extrai link t.me/... mencionado no texto de cada mensagem encontrada e confere se ainda e valido - mais lento, uma checagem de API por link novo."
            )
        );
        corpo.appendChild(blocoLinks);

        // Pedido do usuario: depois de buscar por um assunto (ex. "palmeiras"),
        // poder ver so os posts que JA citam um link de grupo/canal, em vez de
        // vasculhar post por post pra achar os poucos que tem link. So
        // some da lista principal (nao muda quantos posts o Telegram devolve
        // nem a paginacao) - combinado com o checkbox de cima (extrair e
        // verificar), fica igual a ideia de um botao so de "procurar links
        // recentes sobre esse termo".
        const blocoSoComLink = document.createElement("div");
        blocoSoComLink.style.cssText = "display:flex;align-items:flex-start;gap:8px;margin-bottom:10px;font-size:12px;";
        const checkboxSoComLink = criarQuadradoMarcavel(false, null);
        const labelSoComLink = document.createElement("span");
        labelSoComLink.textContent = "Mostrar so posts que citam algum link (esconde o resto)";
        blocoSoComLink.appendChild(checkboxSoComLink.elemento);
        blocoSoComLink.appendChild(labelSoComLink);
        blocoSoComLink.insertAdjacentHTML(
            "beforeend",
            criarIconeInfoHtml(
                'Filtra a lista de posts pra mostrar so os que mencionam t.me/... ou tg://join?invite=... no texto - util pra achar "grupo sobre esse assunto" direto, sem ler post que nao tem link nenhum. Marca o checkbox de cima junto pra esses links ja saírem conferidos.'
            )
        );
        corpo.appendChild(blocoSoComLink);

        const campoBusca = campoTexto(
            corpo,
            'Palavra-chave (texto livre) ou hashtag (varias: "a;b;c")',
            "text"
        );
        const historicoBuscaGlobal = ligarHistoricoBusca(campoBusca, CHAVE_HISTORICO_BUSCA_GLOBAL);

        // Ordena o que ja foi recebido (todas as paginas ja carregadas ate
        // agora via "Carregar mais"), sem precisar refazer a busca - pedido
        // do usuario, pra achar primeiro o canal/grupo maior sobre o
        // assunto, nao so o post mais recente.
        const blocoOrdenar = document.createElement("div");
        blocoOrdenar.style.cssText = "margin-bottom:10px;";
        const labelOrdenar = document.createElement("label");
        labelOrdenar.textContent = "Ordenar por: ";
        labelOrdenar.style.cssText = "color:#8b92a3;font-size:12px;";
        const selectOrdenarGlobal = document.createElement("select");
        selectOrdenarGlobal.style.cssText =
            "background:#0c0e12;color:#e6e8ec;border:1px solid #2a2f3a;border-radius:6px;padding:4px;font-size:12px;";
        selectOrdenarGlobal.innerHTML =
            '<option value="data">Mais recentes</option><option value="membros">Mais membros</option>';
        labelOrdenar.appendChild(selectOrdenarGlobal);
        blocoOrdenar.appendChild(labelOrdenar);
        corpo.appendChild(blocoOrdenar);

        const botaoBuscar = botaoAcao(corpo, "Buscar globalmente");

        const lista = document.createElement("div");
        corpo.appendChild(lista);

        const tituloLinks = document.createElement("div");
        tituloLinks.style.cssText = "color:#8b92a3;margin:14px 0 6px;font-weight:600;display:none;";
        tituloLinks.textContent = "Links de grupo/canal encontrados nos resultados:";
        corpo.appendChild(tituloLinks);

        const listaLinks = document.createElement("div");
        corpo.appendChild(listaLinks);

        // valor (hash ou username, em minusculo) -> elemento <div> ja criado
        // pra esse link - impede verificar ou listar o mesmo link duas vezes
        // quando ele aparece em mais de uma mensagem ou reaparece numa pagina
        // seguinte ("Carregar mais").
        const linksVistos = new Map();

        // Caixa separada pra conferir link achado FORA do Telegram (sites
        // que agregam convite publico de grupo por categoria, por ex.) sem
        // precisar rodar uma busca primeiro - cola o texto com o(s) link(s)
        // (t.me/..., t.me/+hash ou tg://join?invite=hash, um por linha ou
        // misturado em qualquer texto) e cada um e checado com a mesma
        // verificarLinkTelegram de cima: NAO entra no grupo, so confere se o
        // convite ainda e valido e traz titulo/qtd de participantes quando
        // disponivel.
        const tituloColar = document.createElement("div");
        tituloColar.style.cssText = "color:#8b92a3;margin:16px 0 6px;font-weight:600;display:flex;align-items:center;gap:4px;";
        tituloColar.innerHTML =
            "<span>Conferir link de fora do Telegram</span>" +
            criarIconeInfoHtml(
                "Cola aqui o link de grupo/canal que voce achou em outro lugar (site de diretorio de grupos, por ex.) - aceita t.me/usuario, t.me/+hash e tg://join?invite=hash, um por linha ou misturado em qualquer texto. So confere se o convite ainda e valido e mostra titulo/qtd de participantes - NAO entra no grupo."
            );
        corpo.appendChild(tituloColar);

        const campoColar = document.createElement("textarea");
        campoColar.placeholder = "Cola aqui um ou mais links (t.me/..., tg://join?invite=...)";
        campoColar.style.cssText =
            "width:100%;min-height:60px;background:#0c0e12;color:#e6e8ec;border:1px solid #2a2f3a;" +
            "border-radius:6px;padding:8px;box-sizing:border-box;font-family:inherit;font-size:12px;resize:vertical;";
        corpo.appendChild(campoColar);

        const botaoConferirColados = botaoAcao(corpo, "Conferir link(s) colado(s)");
        const avisoNenhumLink = document.createElement("div");
        avisoNenhumLink.style.cssText = "color:#8b92a3;font-size:12px;margin-top:6px;display:none;";
        avisoNenhumLink.textContent = "Nenhum link reconhecido nesse texto.";
        corpo.appendChild(avisoNenhumLink);
        const listaLinksColados = document.createElement("div");
        listaLinksColados.style.marginTop = "6px";
        corpo.appendChild(listaLinksColados);
        const linksColadosVistos = new Map();

        botaoConferirColados.addEventListener("click", () => {
            const encontrados = extrairLinksTelegram(campoColar.value);
            avisoNenhumLink.style.display = encontrados.length ? "none" : "block";
            for (const link of encontrados) criarItemDeLink(link, listaLinksColados, linksColadosVistos);
        });

        // Pagina do jeito que a doc da API manda: offsetRate = nextRate da
        // pagina anterior (ou a data da ultima mensagem, se nextRate nao
        // vier); offsetPeer/offsetId = peer+id da ultima mensagem recebida.
        // Segundo a doc da API, pedido de pagina seguinte (continuar=true)
        // nao conta na cota diaria gratis de busca por texto livre - so o
        // primeiro pedido de cada busca nova consome cota.
        //
        // Varios termos (modo hashtag, separados por ";"): cada termo tem o
        // SEU PROPRIO cursor de paginacao independente, guardado aqui -
        // termo -> {offsetRate, offsetPeer, offsetId} (ainda tem pagina) ou
        // null (esgotado, "Carregar mais" para de tentar esse termo). No
        // modo com um termo so (a imensa maioria dos casos, inclusive todo
        // texto livre), o Map tem uma entrada so e o comportamento e
        // identico ao de antes dessa mudanca.
        let paginasPorTermo = new Map();
        // chatId:messageId ja renderizado nesta busca - evita mostrar a
        // mesma mensagem duas vezes se ela bater com mais de uma hashtag.
        const chavesVistasGlobal = new Set();
        // Guarda TODAS as mensagens ja recebidas (de todas as paginas/termos
        // ja carregados nesta busca) - pedido do usuario: poder reordenar
        // por numero de membros do grupo/canal, sem precisar refazer a
        // chamada de API. "Carregar mais" so acrescenta aqui, a ordenacao e
        // sempre refeita em cima de tudo que ja foi recebido ate agora.
        let resultadosAcumulados = [];
        let houveInexact = false;

        function criarItemResultadoGlobal(m, chat, termoQueBateu) {
            const titulo = (chat && chat.title) || "Canal/grupo desconhecido";
            const username = chat && chat.username ? "@" + chat.username : null;
            const tipo = chat && chat.megagroup ? "grupo" : "canal";
            // A propria mensagem que o Telegram devolve aqui ja traz o campo
            // nativo "reactions" (o mesmo que o scan le em extrairReacoes()),
            // estruturado - nao e preciso "adivinhar" numero de reacao lendo
            // o TEXTO da mensagem (ideia que foi cogitada, mas desnecessaria:
            // o dado certo ja vem pronto, sem risco de confundir com um
            // numero qualquer digitado no texto, tipo um preco).
            const { total: totalReacoes } = extrairReacoes(m);
            // participantsCount TAMBEM ja vem de graca: channels.SearchPosts
            // devolve, junto com as mensagens, a lista "chats" com o objeto
            // Channel completo de cada canal/grupo referenciado (e'
            // exatamente isso que chatsPorId guarda) - e o Channel basico ja
            // inclui participantsCount, sem precisar de nenhuma chamada
            // extra (channels.GetFullChannel) so pra mostrar esse numero.
            const membros = chat && chat.participantsCount != null ? chat.participantsCount : null;

            const item = document.createElement("div");
            item.style.cssText = "padding:8px 0;border-bottom:1px solid #2a2f3a;";
            item.innerHTML =
                '<div style="color:#4da3ff;font-weight:600;">' +
                escapeHtml(titulo) +
                " (" +
                tipo +
                ")</div>" +
                (username ? '<div style="color:#8b92a3;font-size:11px;">' + escapeHtml(username) + "</div>" : "") +
                (membros != null
                    ? '<div style="color:#8b92a3;font-size:11px;">' + membros + " membros</div>"
                    : "") +
                (totalReacoes
                    ? '<div style="color:#8b92a3;font-size:11px;">' + totalReacoes + " reacoes</div>"
                    : "") +
                // So aparece quando a busca tem mais de uma hashtag ao mesmo
                // tempo (separadas por ";") - com uma so, ja esta implicito
                // qual termo bateu, nao precisa poluir cada item repetindo.
                (termoQueBateu
                    ? '<div style="color:#5ec26a;font-size:11px;">#' + escapeHtml(termoQueBateu) + "</div>"
                    : "") +
                "<div>" +
                escapeHtml(truncar((m.message || "").trim(), 200)) +
                "</div>";
            if (username) {
                const abrir = document.createElement("div");
                abrir.style.cssText = "color:#4da3ff;font-size:11px;cursor:pointer;margin-top:4px;";
                abrir.textContent = "abrir " + username;
                abrir.addEventListener("click", () => {
                    window.open("https://t.me/" + chat.username, "_blank");
                });
                item.appendChild(abrir);
            }
            return item;
        }

        // So no modo hashtag o ";" separa varios termos - cada um vira uma
        // chamada de API independente (ver comentario no icone "i" ao lado
        // do checkbox). No modo texto livre o ";" fica como parte literal
        // do termo unico, de proposito (nao multiplica o gasto de
        // cota/Stars). Dedup por versao normalizada (minusculo), mas a
        // chamada em si usa o texto original digitado (sem o "#" na
        // frente). Limite de 10 termos por busca - seguranca contra
        // flood/abuso, nao documentado em lugar nenhum como necessario, so
        // bom senso.
        function termosDaBusca(termoBruto) {
            if (!checkboxHashtag.checked) return [termoBruto];
            const vistos = new Set();
            const termos = [];
            for (const parte of termoBruto.split(";")) {
                const limpo = parte.trim().replace(/^#/, "");
                if (!limpo) continue;
                const chave = limpo.toLowerCase();
                if (vistos.has(chave)) continue;
                vistos.add(chave);
                termos.push(limpo);
                if (termos.length >= 10) break;
            }
            return termos;
        }

        // Redesenha "lista" inteira a partir de resultadosAcumulados (nunca
        // refaz chamada de API) - usada tanto no fim de cada busca/pagina
        // quanto quando o usuario so troca o "Ordenar por" sem buscar de
        // novo. Reaplicar a ordenacao em cima de TUDO que ja foi recebido
        // (nao so a pagina mais nova) e o que deixa "mais membros" util
        // mesmo depois de varios "Carregar mais".
        function renderizarListaGlobal() {
            lista.innerHTML = "";
            if (houveInexact) {
                lista.insertAdjacentHTML(
                    "beforeend",
                    '<div style="color:#8b92a3;font-size:11px;margin-bottom:6px;">Resultado aproximado (o Telegram marcou essa busca como "inexact").</div>'
                );
            }
            const itens = [...resultadosAcumulados];
            if (selectOrdenarGlobal.value === "membros") {
                const membrosDe = (item) =>
                    item.chat && item.chat.participantsCount != null ? item.chat.participantsCount : -1;
                itens.sort((a, b) => membrosDe(b) - membrosDe(a));
            }
            if (!itens.length) {
                lista.insertAdjacentHTML("beforeend", '<div style="color:#8b92a3;">Nada encontrado com esse termo.</div>');
            } else {
                for (const item of itens) {
                    lista.appendChild(criarItemResultadoGlobal(item.m, item.chat, item.termoQueBateu));
                }
            }
            const aindaTemPagina = [...paginasPorTermo.values()].some((p) => p != null);
            if (aindaTemPagina) {
                const botaoMais = botaoAcao(lista, "Carregar mais");
                botaoMais.className = "trp-carregar-mais";
                botaoMais.addEventListener("click", () => executarBuscaGlobal(true));
            }
        }

        async function executarBuscaGlobal(continuar) {
            const termoBruto = campoBusca.value.trim();
            if (!termoBruto) {
                lista.innerHTML = '<div style="color:#8b92a3;">Digita algo pra buscar.</div>';
                return;
            }
            const termos = termosDaBusca(termoBruto);
            if (!termos.length) {
                lista.innerHTML = '<div style="color:#8b92a3;">Digita pelo menos uma hashtag valida.</div>';
                return;
            }

            if (!continuar) {
                lista.innerHTML = '<div style="color:#8b92a3;">Buscando nos canais/grupos publicos do Telegram...</div>';
                paginasPorTermo = new Map(
                    termos.map((t) => [t, { offsetRate: 0, offsetPeer: new Api.InputPeerEmpty({}), offsetId: 0 }])
                );
                chavesVistasGlobal.clear();
                resultadosAcumulados = [];
                houveInexact = false;
                historicoBuscaGlobal.registrar(termoBruto);
                listaLinks.innerHTML = "";
                linksVistos.clear();
                tituloLinks.style.display = "none";
            }

            botaoBuscar.disabled = true;
            try {
                let erroDeAlgumTermo = null;
                // So pode estourar em modo texto livre (hashtag nao tem cota
                // documentada) - guarda o termo que precisaria pagar Stars
                // pra continuar, pra oferecer o botao de pagamento depois do
                // loop (nunca durante, nunca automatico).
                let termoComCotaEstourada = null;
                // Sequencial (nao em paralelo) de proposito - varios termos
                // disparando tudo de uma vez arrisca flood wait mesmo sem a
                // cota/Premium entrarem no caminho (todo metodo da API tem
                // controle geral de taxa de pedidos, documentado ou nao).
                for (const termoAtual of termos) {
                    const pagina = paginasPorTermo.get(termoAtual);
                    if (!pagina) continue; // esse termo ja esgotou as paginas dele
                    try {
                        const parametros = {
                            offsetRate: pagina.offsetRate,
                            offsetPeer: pagina.offsetPeer,
                            offsetId: pagina.offsetId,
                            limit: 20,
                        };
                        if (checkboxHashtag.checked) {
                            parametros.hashtag = termoAtual;
                        } else {
                            parametros.query = termoAtual;
                        }
                        const resultado = await cliente.invoke(new Api.channels.SearchPosts(parametros));
                        processarRespostaDeBusca(resultado, termoAtual, termos.length);
                    } catch (erro) {
                        paginasPorTermo.set(termoAtual, null);
                        const mensagemErro = erro && erro.message ? erro.message : String(erro);
                        // So em texto livre: cota diaria gratis acabou e a
                        // conta nao tem Premium - o unico jeito de continuar
                        // E PAGANDO em Stars (ver buscarPagandoStars). Modo
                        // hashtag nunca cai aqui (sem essa restricao).
                        if (!checkboxHashtag.checked && /PREMIUM_ACCOUNT_REQUIRED/i.test(mensagemErro)) {
                            termoComCotaEstourada = termoAtual;
                        } else {
                            erroDeAlgumTermo =
                                (termos.length > 1 ? termoAtual + ": " : "") + mensagemErro;
                        }
                    }
                }

                renderizarListaGlobal();
                if (erroDeAlgumTermo) {
                    lista.insertAdjacentHTML(
                        "beforeend",
                        '<div style="color:#ff6b6b;font-size:11px;">Um dos termos deu erro: ' +
                            escapeHtml(erroDeAlgumTermo) +
                            "</div>"
                    );
                }
                if (termoComCotaEstourada) {
                    mostrarBotaoPagarStars(termoComCotaEstourada);
                }
            } finally {
                botaoBuscar.disabled = false;
            }
        }

        // Processa UMA resposta de channels.SearchPosts (pago ou nao) -
        // compartilhado entre a busca normal (executarBuscaGlobal) e a busca
        // paga em Stars (buscarPagandoStars), pra garantir que os dois
        // caminhos atualizam resultadosAcumulados/paginasPorTermo do mesmo
        // jeito exato.
        function processarRespostaDeBusca(resultado, termoAtual, totalDeTermos) {
            const mensagens = resultado.messages || [];
            const chatsPorId = new Map();
            for (const c of resultado.chats || []) chatsPorId.set(String(c.id), c);

            if (resultado.inexact) houveInexact = true;

            for (const m of mensagens) {
                const chatIdMsg = m.peerId && m.peerId.channelId != null ? String(m.peerId.channelId) : "?";
                const chaveMsg = chatIdMsg + ":" + m.id;
                if (chavesVistasGlobal.has(chaveMsg)) continue;
                chavesVistasGlobal.add(chaveMsg);

                const linksDaMensagem = extrairLinksTelegram(m.message);
                if (checkboxSoComLink.checked && !linksDaMensagem.length) continue;

                resultadosAcumulados.push({
                    m,
                    chat: chatsPorId.get(chatIdMsg) || null,
                    termoQueBateu: totalDeTermos > 1 ? termoAtual : null,
                });
                if (checkboxLinks.checked) {
                    for (const link of linksDaMensagem) criarItemDeLink(link, listaLinks, linksVistos);
                    if (linksDaMensagem.length) tituloLinks.style.display = "block";
                }
            }

            if (mensagens.length) {
                const ultima = mensagens[mensagens.length - 1];
                const chatIdUltima = ultima.peerId && ultima.peerId.channelId != null ? String(ultima.peerId.channelId) : null;
                const chatUltima = chatIdUltima ? chatsPorId.get(chatIdUltima) : null;
                if (chatUltima && chatUltima.accessHash != null) {
                    paginasPorTermo.set(termoAtual, {
                        offsetRate: resultado.nextRate ?? ultima.date,
                        offsetPeer: new Api.InputPeerChannel({ channelId: chatUltima.id, accessHash: chatUltima.accessHash }),
                        offsetId: ultima.id,
                    });
                } else {
                    // sem accessHash do ultimo chat nao da pra montar o
                    // offsetPeer da proxima pagina - esgota esse termo.
                    paginasPorTermo.set(termoAtual, null);
                }
            } else {
                paginasPorTermo.set(termoAtual, null);
            }
        }

        // So chamado por uma acao explicita do usuario (clique no botao com
        // o valor exato de Stars escrito nele) - NUNCA automatico. A
        // primeira pagina de uma busca paga e a UNICA que cobra: a doc
        // oficial diz que toda paginacao seguinte da MESMA busca ("Carregar
        // mais") volta a ser gratis - por isso isso so roda uma vez por
        // busca nova, nunca de novo num "Carregar mais".
        async function buscarPagandoStars(termoAtual, botao) {
            botao.disabled = true;
            botao.textContent = "Pagando e buscando...";
            try {
                const cotaFresca = await cliente.invoke(new Api.channels.CheckSearchPostsFlood({}));
                if (cotaFresca.queryIsFree || cotaFresca.remains > 0) {
                    // Sobrou cota gratis entre a tentativa anterior e agora
                    // (pouco provavel, mas possivel) - nao cobra Stars a
                    // toa, so repete a busca normal.
                    paginasPorTermo.set(termoAtual, { offsetRate: 0, offsetPeer: new Api.InputPeerEmpty({}), offsetId: 0 });
                    const resultado = await cliente.invoke(
                        new Api.channels.SearchPosts({
                            offsetRate: 0,
                            offsetPeer: new Api.InputPeerEmpty({}),
                            offsetId: 0,
                            limit: 20,
                            query: termoAtual,
                        })
                    );
                    processarRespostaDeBusca(resultado, termoAtual, 1);
                } else {
                    const resultado = await cliente.invoke(
                        new Api.channels.SearchPosts({
                            offsetRate: 0,
                            offsetPeer: new Api.InputPeerEmpty({}),
                            offsetId: 0,
                            limit: 20,
                            query: termoAtual,
                            allowPaidStars: cotaFresca.starsAmount,
                        })
                    );
                    processarRespostaDeBusca(resultado, termoAtual, 1);
                }
                renderizarListaGlobal();
            } catch (erro) {
                lista.insertAdjacentHTML(
                    "beforeend",
                    '<div style="color:#ff6b6b;font-size:11px;">Erro ao pagar e buscar: ' +
                        escapeHtml(erro && erro.message ? erro.message : String(erro)) +
                        "</div>"
                );
                botao.disabled = false;
                botao.textContent =
                    ultimaCota && ultimaCota.starsAmount != null
                        ? `Pagar ${ultimaCota.starsAmount} Stars e buscar mesmo assim`
                        : "Pagar em Stars e buscar mesmo assim";
            }
        }

        function mostrarBotaoPagarStars(termoAtual) {
            const bloco = document.createElement("div");
            bloco.style.cssText = "margin-top:8px;padding-top:8px;border-top:1px solid #2a2f3a;";
            bloco.innerHTML =
                '<div style="color:#e0a93a;font-size:11px;margin-bottom:4px;">Cota diaria gratis de texto livre acabou hoje.</div>';
            const botaoPagar = document.createElement("button");
            botaoPagar.textContent =
                ultimaCota && ultimaCota.starsAmount != null
                    ? `Pagar ${ultimaCota.starsAmount} Stars e buscar mesmo assim`
                    : "Pagar em Stars e buscar mesmo assim";
            botaoPagar.style.cssText =
                "width:100%;padding:8px;border:none;border-radius:6px;background:#e0a93a;color:#1a1a1a;" +
                "font-weight:600;cursor:pointer;";
            bloco.appendChild(botaoPagar);
            lista.appendChild(bloco);
            botaoPagar.addEventListener("click", () => buscarPagandoStars(termoAtual, botaoPagar));
        }

        botaoBuscar.addEventListener("click", () => executarBuscaGlobal(false));
        campoBusca.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") executarBuscaGlobal(false);
        });
        selectOrdenarGlobal.addEventListener("change", () => {
            if (resultadosAcumulados.length) renderizarListaGlobal();
        });
    }

    // Confere se uma mensagem especifica (ex.: algo que apareceu na busca
    // NATIVA do Telegram mas nao na nossa busca local) ja esta salva no
    // nosso banco, comparando com o que existe ao vivo no Telegram agora.
    // Existe pra responder com certeza, sem chute, se um caso de "a busca
    // nativa acha e a nossa nao" e um buraco real no scan (mensagem existe
    // mas ainda nao foi escaneada) ou outra coisa (texto editado depois,
    // mensagem apagada, etc.).
    async function telaVerificarMensagem() {
        definirTituloTela("Verificar mensagem");
        const corpo = corpoDoPainel();
        botaoVoltar(corpo);

        const aviso = document.createElement("div");
        aviso.style.cssText = "display:flex;align-items:center;gap:4px;color:#8b92a3;margin-bottom:10px;";
        aviso.innerHTML =
            "<span>Confere se uma mensagem especifica ja esta no nosso banco local.</span>" +
            criarIconeInfoHtml(
                'Por exemplo, algo que voce viu na busca nativa do Telegram mas nao apareceu em "Buscar mensagens" aqui. Compara com o que existe ao vivo no Telegram agora - serve pra saber se e falta de scan (ainda nao chegou la) ou outra coisa (texto editado depois, mensagem apagada, etc.).'
            );
        corpo.appendChild(aviso);

        const db = await abrirBanco();
        // Mesmo filtro das demais telas - grupo desmarcado em "Configurar
        // grupos" nao aparece no seletor (ver comentario em
        // renderizarTabelaChats()).
        const excluidos = carregarGruposExcluidos();
        const chats = (await listarChats(db)).filter((c) => !excluidos.has(c.chatId));
        chats.sort((a, b) => (a.chatTitle || "").localeCompare(b.chatTitle || ""));

        if (!chats.length) {
            textoAviso(corpo, "Nenhum grupo escaneado ainda. Roda o scan primeiro.", "#ff6b6b");
            return;
        }

        const blocoGrupo = document.createElement("div");
        blocoGrupo.style.marginBottom = "10px";
        blocoGrupo.innerHTML =
            '<label style="display:block;color:#8b92a3;margin-bottom:4px;">Grupo/canal</label>' +
            '<select id="trp-verificar-grupo" style="width:100%;background:#0c0e12;color:#e6e8ec;border:1px solid #2a2f3a;border-radius:6px;padding:8px;box-sizing:border-box;"></select>';
        corpo.appendChild(blocoGrupo);
        const selectGrupo = blocoGrupo.querySelector("#trp-verificar-grupo");
        for (const c of chats) {
            const opcao = document.createElement("option");
            opcao.value = c.chatId;
            opcao.textContent = c.chatTitle || c.chatId;
            selectGrupo.appendChild(opcao);
        }

        const campoLink = campoTexto(
            corpo,
            'Cola o link da mensagem aqui (opcional, so pra preencher o ID e o grupo sozinho)',
            "text"
        );
        const campoId = campoTexto(
            corpo,
            'ID da mensagem (numero no final do link de "Copiar link da mensagem")',
            "number"
        );

        // Tenta reconhecer o link (t.me/c/<id>/<msg> ou o link que o proprio
        // botao "abrir" daqui gera, web.telegram.org/...#<id>?post=<msg>) e
        // preencher ID + grupo sozinho. Se nao reconhecer o formato, pelo
        // menos pega o ultimo numero colado como ID da mensagem.
        campoLink.addEventListener("input", () => {
            const texto = campoLink.value.trim();
            if (!texto) return;
            const selecionarGrupoPorIdBase = (idBase) => {
                const candidato = chats.find((c) => c.chatId === "-100" + idBase || c.chatId === "-" + idBase);
                if (candidato) selectGrupo.value = candidato.chatId;
            };
            const comC = texto.match(/\/c\/(\d+)\/(\d+)/);
            if (comC) {
                campoId.value = comC[2];
                selecionarGrupoPorIdBase(comC[1]);
                return;
            }
            const comPost = texto.match(/#-?(\d+)\?post=(\d+)/);
            if (comPost) {
                campoId.value = comPost[2];
                selecionarGrupoPorIdBase(comPost[1]);
                return;
            }
            const numeros = texto.match(/\d+/g);
            if (numeros && numeros.length) campoId.value = numeros[numeros.length - 1];
        });

        const botaoVerificar = botaoAcao(corpo, "Verificar");
        const resultado = document.createElement("div");
        resultado.style.marginTop = "10px";
        corpo.appendChild(resultado);

        function blocoResultado(titulo, cor, miolo) {
            return (
                '<div style="margin-bottom:10px;padding:8px;border:1px solid #2a2f3a;border-radius:6px;">' +
                '<div style="color:' +
                cor +
                ';font-weight:600;margin-bottom:4px;">' +
                escapeHtml(titulo) +
                "</div>" +
                miolo +
                "</div>"
            );
        }

        botaoVerificar.addEventListener("click", async () => {
            const chatId = selectGrupo.value;
            const messageId = parseInt(campoId.value, 10);
            if (!chatId || !messageId) {
                textoAviso(corpo, "Escolhe o grupo e preenche o ID da mensagem.", "#ff6b6b");
                return;
            }
            botaoVerificar.disabled = true;
            resultado.innerHTML = '<div style="color:#8b92a3;">Verificando no banco local...</div>';
            try {
                const key = chatId + ":" + messageId;
                const local = await buscarMensagem(db, key);

                const htmlLocal = local
                    ? blocoResultado(
                          "No nosso banco local: encontrada",
                          "#5ec26a",
                          '<div style="font-size:11px;color:#8b92a3;margin-bottom:2px;">' +
                              escapeHtml((local.dateUtc || "").slice(0, 10)) +
                              " - " +
                              (local.reactionTotal || 0) +
                              " reacoes</div><div>" +
                              escapeHtml(local.texto || "") +
                              "</div>"
                      )
                    : blocoResultado(
                          "No nosso banco local: nao encontrada",
                          "#ff6b6b",
                          '<div style="color:#8b92a3;">Essa mensagem ainda nao esta salva (scan nao chegou nela ainda, ou nunca vai chegar por algum motivo).</div>'
                      );

                resultado.innerHTML = htmlLocal + '<div style="color:#8b92a3;">Buscando ao vivo no Telegram...</div>';

                const entidade = await encontrarEntidadePorChatId(chatId);
                if (!entidade) {
                    resultado.innerHTML =
                        htmlLocal +
                        blocoResultado(
                            "Ao vivo no Telegram: erro",
                            "#ff6b6b",
                            '<div style="color:#8b92a3;">Nao achei esse grupo entre os dialogs dessa conta agora (saiu do grupo? mudou de id?).</div>'
                        );
                    return;
                }

                const mensagens = await cliente.getMessages(entidade, { ids: [messageId] });
                const mensagemAoVivo = mensagens && mensagens[0];

                const htmlAoVivo = mensagemAoVivo
                    ? blocoResultado(
                          "Ao vivo no Telegram agora: existe",
                          "#5ec26a",
                          '<div style="font-size:11px;color:#8b92a3;margin-bottom:2px;">' +
                              escapeHtml(dataIso(mensagemAoVivo).slice(0, 10)) +
                              " - " +
                              extrairReacoes(mensagemAoVivo).total +
                              " reacoes</div><div>" +
                              escapeHtml(textoCompleto(mensagemAoVivo)) +
                              "</div>"
                      )
                    : blocoResultado(
                          "Ao vivo no Telegram agora: nao existe",
                          "#e0a93a",
                          '<div style="color:#8b92a3;">Apagada, ou esse ID nao corresponde a nenhuma mensagem nesse grupo.</div>'
                      );

                resultado.innerHTML = htmlLocal + htmlAoVivo;

                if (!local && mensagemAoVivo) {
                    resultado.insertAdjacentHTML(
                        "beforeend",
                        '<div style="color:#e0a93a;font-size:12px;">Isso confirma um buraco real: a mensagem existe mas o scan ainda nao salvou ela. Se o ultimo scan desse grupo ja passou da data dela e mesmo assim nao achou, e bug de verdade - me avisa com esse caso.</div>'
                    );
                } else if (
                    local &&
                    mensagemAoVivo &&
                    normalizarTexto(local.texto || "") !== normalizarTexto(textoCompleto(mensagemAoVivo))
                ) {
                    resultado.insertAdjacentHTML(
                        "beforeend",
                        '<div style="color:#e0a93a;font-size:12px;">O texto salvo e diferente do texto ao vivo - ou a mensagem foi editada depois do scan, ou o texto nao foi capturado direito na hora.</div>'
                    );
                }
            } catch (erro) {
                resultado.innerHTML =
                    '<div style="color:#ff6b6b;">Erro: ' +
                    escapeHtml(erro && erro.message ? erro.message : String(erro)) +
                    "</div>";
            } finally {
                botaoVerificar.disabled = false;
            }
        });
    }

    function escapeHtml(texto) {
        const div = document.createElement("div");
        div.textContent = texto == null ? "" : texto;
        return div.innerHTML;
    }

    criarBotao();
})();
