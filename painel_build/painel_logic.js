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

    const NOME_BANCO = "TopReacoesTelegram";
    const VERSAO_BANCO = 1;

    let cliente = null; // instancia conectada, reaproveitada entre aberturas do painel
    let painel = null;
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
    // informado) e por reactionTotal minimo, ate juntar "limite" resultados.
    function buscarTop(db, { chatId, minimo, limite }) {
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
                if (!chatId || valor.chatId === chatId) {
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
                if (!cursor || resultados.length >= limite || visitados >= LIMITE_VISITAS) {
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
                // palavras.length === 0 (termo vazio/so espaco) nunca bate -
                // sem isso, .some() num array vazio da false, entao isso ja
                // seria seguro de qualquer jeito, mas deixa explicito.
                const bateAlgumaPalavra = palavras.length > 0 && palavras.some((p) => textoNormalizado.includes(p));
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
            painel.remove();
            removerBotoesNavegacao();
            painel = null;
            return;
        }
        montarPainel();
    }

    function montarPainel() {
        painel = document.createElement("div");
        Object.assign(painel.style, {
            position: "fixed",
            top: "40px",
            right: "24px",
            width: "420px",
            maxHeight: "80vh",
            overflow: "auto",
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
        adicionarBotoesNavegacao();
        decidirTela();
    }

    // Botoes flutuantes fixos na tela pra ir direto pro topo ou pro fim da
    // lista, sem arrastar o mouse rolando - util em listas longas de
    // resultado. Anexados direto no document.body, NAO no painel: o
    // painel tem overflow:auto, e um "position:fixed" filho de um
    // ancestral com overflow diferente de visible fica cortado pelos
    // limites desse ancestral (clipping segue o DOM, independente da
    // posicao calculada ser relativa a viewport) - isso deixava a setinha
    // de voltar ao topo praticamente invisivel na maioria dos tamanhos de
    // janela (so aparecia se o painel fosse baixo o bastante pra sobrar
    // espaco depois do fim dele). Por nao serem mais filhos do painel,
    // "painel.remove()" (fechar o painel) nao leva eles junto - por isso
    // alternarPainel() remove os dois na mao ao fechar.
    function adicionarBotoesNavegacao() {
        const estiloBase = {
            position: "fixed",
            right: "34px",
            zIndex: 1000000,
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
        };

        const botaoTopo = document.createElement("button");
        botaoTopo.id = "trp-ir-topo";
        botaoTopo.textContent = "↑";
        botaoTopo.title = "Voltar ao topo";
        Object.assign(botaoTopo.style, estiloBase, { bottom: "62px" });
        botaoTopo.addEventListener("click", () => {
            painel.scrollTop = 0;
        });
        document.body.appendChild(botaoTopo);

        const botaoFim = document.createElement("button");
        botaoFim.id = "trp-ir-fim";
        botaoFim.textContent = "↓";
        botaoFim.title = "Ir pro fim";
        Object.assign(botaoFim.style, estiloBase, { bottom: "24px" });
        botaoFim.addEventListener("click", () => {
            painel.scrollTop = painel.scrollHeight;
        });
        document.body.appendChild(botaoFim);
    }

    function removerBotoesNavegacao() {
        const topo = document.getElementById("trp-ir-topo");
        const fim = document.getElementById("trp-ir-fim");
        if (topo) topo.remove();
        if (fim) fim.remove();
    }

    // Restaura painel.scrollTop depois que o navegador terminar de
    // recalcular o layout da lista recem-recarregada. Atribuir o valor
    // logo em seguida ao await (sincrono) costuma funcionar, mas, com
    // bastante item novo de uma vez, o reflow pode nao ter terminado ainda
    // nesse instante, e o navegador acaba grudando o scroll num valor
    // errado de qualquer forma. Dois requestAnimationFrame seguidos (em
    // vez de so atribuir direto) garante que isso rode so depois de pelo
    // menos um ciclo completo de layout+pintura.
    function restaurarScrollDepoisDoReflow(valor) {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                painel.scrollTop = valor;
            });
        });
    }

    function renderizarCabecalho() {
        saidaPendente = false;
        if (timeoutSaida) clearTimeout(timeoutSaida);
        timeoutSaida = null;

        const cabecalho = document.createElement("div");
        cabecalho.style.cssText =
            "display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;";
        cabecalho.innerHTML =
            '<strong>Top Reacoes</strong>' +
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
        let corpo = painel.querySelector("#trp-corpo");
        if (!corpo) {
            corpo = document.createElement("div");
            corpo.id = "trp-corpo";
            painel.appendChild(corpo);
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
            const botaoConfigurarGrupos = botaoAcao(corpo, "Configurar grupos do scan (incluir/excluir)");
            botaoConfigurarGrupos.addEventListener("click", () => telaConfigurarGrupos());
            const botaoResultados = botaoAcao(corpo, "Ver top reacoes");
            botaoResultados.addEventListener("click", () => telaResultados());
            const botaoBusca = botaoAcao(corpo, "Buscar mensagens");
            botaoBusca.addEventListener("click", () => telaBusca());
            const botaoBuscaAvancada = botaoAcao(corpo, "Busca avancada (grupos/canais publicos)");
            botaoBuscaAvancada.addEventListener("click", () => telaBuscaAvancada());
            const botaoVerificar = botaoAcao(corpo, "Verificar mensagem (local vs. ao vivo)");
            botaoVerificar.addEventListener("click", () => telaVerificarMensagem());
            atualizarVisibilidadeSair(true);
        } catch (erro) {
            textoAviso(corpo, "Erro ao carregar a conta: " + (erro && erro.message ? erro.message : erro), "#ff6b6b");
        }
    }

    function botaoVoltar(corpo) {
        const botao = document.createElement("button");
        botao.textContent = "< Voltar";
        botao.style.cssText =
            "background:none;border:none;color:#8b92a3;cursor:pointer;font-size:12px;margin-bottom:10px;padding:0;";
        botao.addEventListener("click", () => telaLogado());
        corpo.appendChild(botao);
        return botao;
    }

    // ---- Tela de scan ----

    // Lista os grupos/canais da conta (pra popular o seletor de "qual grupo
    // escanear"). Separado de escanearTudo porque aqui so queremos
    // id+titulo, sem mexer no banco.
    async function carregarGruposParaSelecao() {
        const grupos = [];
        for await (const dialog of cliente.iterDialogs({})) {
            if (!(dialog.isGroup || dialog.isChannel)) continue;
            grupos.push({ chatId: String(dialog.id), titulo: dialog.title || dialog.name || String(dialog.id) });
        }
        grupos.sort((a, b) => a.titulo.localeCompare(b.titulo));
        return grupos;
    }

    // ---- Tela de configuracao: quais grupos/canais entram no "Todos" do scan ----

    // Escanear um grupo especifico (escolhendo ele no dropdown da propria
    // tela de scan) ignora essa lista de exclusao - ela so vale pra quando
    // "Todos" esta selecionado ali.
    async function telaConfigurarGrupos() {
        const corpo = corpoDoPainel();
        botaoVoltar(corpo);

        const aviso = document.createElement("div");
        aviso.style.cssText = "color:#8b92a3;margin-bottom:10px;";
        aviso.textContent =
            'Desmarca os grupos/canais que voce NAO quer que o scan com "Todos" selecionado inclua. Grupo novo que voce entrar aparece aqui automaticamente, ja marcado pra escanear. Escolher um grupo especifico na tela de scan ignora essa lista (sempre escaneia, mesmo desmarcado aqui).';
        corpo.appendChild(aviso);

        const lista = document.createElement("div");
        lista.style.cssText = "color:#8b92a3;";
        lista.textContent = "Carregando lista de grupos...";
        corpo.appendChild(lista);

        try {
            const grupos = await carregarGruposParaSelecao();
            const excluidos = carregarGruposExcluidos();
            lista.innerHTML = "";
            if (!grupos.length) {
                lista.textContent = "Nenhum grupo/canal encontrado nessa conta.";
                return;
            }
            for (const g of grupos) {
                const linha = document.createElement("div");
                linha.style.cssText =
                    "display:flex;align-items:flex-start;gap:8px;padding:6px 0;border-bottom:1px solid #2a2f3a;";
                const quadrado = criarQuadradoMarcavel(!excluidos.has(g.chatId), (incluido) => {
                    if (incluido) excluidos.delete(g.chatId);
                    else excluidos.add(g.chatId);
                    salvarGruposExcluidos(excluidos);
                });
                const rotulo = document.createElement("span");
                rotulo.textContent = g.titulo;
                linha.appendChild(quadrado.elemento);
                linha.appendChild(rotulo);
                lista.appendChild(linha);
            }
        } catch (erro) {
            lista.textContent = "Erro ao carregar grupos: " + (erro && erro.message ? erro.message : erro);
        }
    }

    // Acha o dialog.entity de um chat ja escaneado, pelo chatId guardado -
    // precisa disso (em vez de so o chatId numerico) pra poder chamar
    // cliente.getMessages, do mesmo jeito que escanearTudo usa
    // dialog.entity pra chamar iterMessages. So itera os dialogs ate achar
    // (nao da pra montar o InputPeer so com o chatId sem o access_hash).
    async function encontrarEntidadePorChatId(chatId) {
        for await (const dialog of cliente.iterDialogs({})) {
            if (String(dialog.id) === chatId) return dialog.entity;
        }
        return null;
    }

    // Mostra o que ja esta salvo por grupo: quantas mensagens com reacao,
    // quando foi o ultimo scan e se terminou de verdade (concluido) ou ficou
    // parcial (cancelado no meio). Sem isso o usuario fica as cegas sobre o
    // que ja rodou.
    async function renderizarTabelaChats(container, db) {
        const chats = await listarChats(db);
        chats.sort((a, b) => (a.chatTitle || "").localeCompare(b.chatTitle || ""));
        if (!chats.length) {
            container.innerHTML = '<div style="color:#8b92a3;">Nenhum grupo escaneado ainda.</div>';
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
                    "</td>" +
                    '<td style="padding:4px 6px;color:#8b92a3;font-size:11px;">' +
                    escapeHtml(quando) +
                    "</td>" +
                    "</tr>"
            );
        }
        container.innerHTML =
            '<table style="width:100%;border-collapse:collapse;font-size:12px;">' +
            '<thead><tr style="color:#8b92a3;text-align:left;">' +
            '<th style="padding:4px 6px;">Grupo</th><th style="padding:4px 6px;text-align:right;">Salvas</th>' +
            '<th style="padding:4px 6px;">Status</th><th style="padding:4px 6px;">Ultimo scan</th>' +
            "</tr></thead><tbody>" +
            linhas.join("") +
            "</tbody></table>";
    }

    async function telaScanner() {
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

        carregarGruposParaSelecao()
            .then((grupos) => {
                const carregando = selectGrupo.querySelector("#trp-carregando-grupos");
                if (carregando) carregando.remove();
                for (const g of grupos) {
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

        const status = document.createElement("div");
        status.style.cssText = "color:#8b92a3;margin-bottom:10px;white-space:pre-line;";
        status.textContent = scanEmAndamento
            ? "Scan ja esta rodando..."
            : 'Escolhe um grupo especifico ou deixa em "Todos" (respeita o que estiver desmarcado em "Configurar grupos do scan", na tela anterior). Continua de onde parou da ultima vez - pode parar e retomar a hora que quiser. Historico antigo que ainda nao tem texto completo salvo (grupos escaneados antes da busca por palavra-chave existir) e completado automaticamente, sem precisar marcar nada.';
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
        await renderizarTabelaChats(tabela, db);

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
                    () => renderizarTabelaChats(tabela, db)
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
                await renderizarTabelaChats(tabela, db);
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
            for await (const dialog of cliente.iterDialogs({})) {
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
        const corpo = corpoDoPainel();
        botaoVoltar(corpo);

        const db = await abrirBanco();
        const chats = await listarChats(db);
        chats.sort((a, b) => (a.chatTitle || "").localeCompare(b.chatTitle || ""));

        const filtros = document.createElement("div");
        filtros.style.cssText = "display:flex;gap:8px;margin-bottom:10px;";
        filtros.innerHTML =
            '<select id="trp-filtro-grupo" style="flex:1;background:#0c0e12;color:#e6e8ec;border:1px solid #2a2f3a;border-radius:6px;padding:6px;">' +
            '<option value="">Todos os grupos</option>' +
            "</select>" +
            '<input id="trp-filtro-minimo" type="number" min="1" value="1" style="width:60px;background:#0c0e12;color:#e6e8ec;border:1px solid #2a2f3a;border-radius:6px;padding:6px;">';
        corpo.appendChild(filtros);

        const selectGrupo = filtros.querySelector("#trp-filtro-grupo");
        for (const c of chats) {
            const opcao = document.createElement("option");
            opcao.value = c.chatId;
            opcao.textContent = (c.chatTitle || c.chatId) + " (ate msg " + (c.lastScannedMessageId || 0) + ")";
            selectGrupo.appendChild(opcao);
        }
        const inputMinimo = filtros.querySelector("#trp-filtro-minimo");

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
            lista.innerHTML = '<div style="color:#8b92a3;">Carregando...</div>';
            const chatId = selectGrupo.value || null;
            const minimo = parseInt(inputMinimo.value, 10) || 1;
            const mensagens = await buscarTop(db, { chatId, minimo, limite: limiteAtual });
            if (!mensagens.length) {
                lista.innerHTML = '<div style="color:#8b92a3;">Nenhuma mensagem encontrada com esse filtro.</div>';
                return;
            }
            lista.innerHTML = "";
            for (const m of mensagens) {
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
                lista.appendChild(item);
            }

            if (mensagens.length >= limiteAtual) {
                const botaoMais = botaoAcao(lista, "Mostrar mais");
                // Mesmo problema e mesmo conserto do "Mostrar mais" da tela
                // de busca: a lista esvaziar por um instante durante o
                // "Carregando..." faz o navegador zerar o scroll do painel
                // sozinho, entao guarda e restaura na mao.
                botaoMais.addEventListener("click", async () => {
                    const scrollAnterior = painel.scrollTop;
                    limiteAtual += 50;
                    await atualizarLista();
                    restaurarScrollDepoisDoReflow(scrollAnterior);
                });
            }
        }

        selectGrupo.addEventListener("change", () => {
            limiteAtual = 50;
            atualizarLista();
        });
        inputMinimo.addEventListener("change", () => {
            limiteAtual = 50;
            atualizarLista();
        });
        await atualizarLista();
    }

    // ---- Tela de busca por palavra-chave ----

    async function telaBusca() {
        const corpo = corpoDoPainel();
        botaoVoltar(corpo);

        const db = await abrirBanco();
        const chats = await listarChats(db);
        chats.sort((a, b) => (a.chatTitle || "").localeCompare(b.chatTitle || ""));

        const aviso = document.createElement("div");
        aviso.style.cssText = "color:#8b92a3;margin-bottom:10px;";
        aviso.textContent =
            "Busca so dentro do que ja foi escaneado. Grupo escaneado antes dessa funcao existir completa o texto do historico antigo sozinho na proxima vez que passar pelo scan (tela de scan mostra \"completando historico antigo\" enquanto isso roda).";
        corpo.appendChild(aviso);

        const filtros = document.createElement("div");
        filtros.style.cssText = "display:flex;gap:8px;margin-bottom:10px;";
        filtros.innerHTML =
            '<select id="trp-busca-grupo" style="flex:2;background:#0c0e12;color:#e6e8ec;border:1px solid #2a2f3a;border-radius:6px;padding:6px;">' +
            '<option value="">Todos os grupos</option>' +
            "</select>" +
            '<select id="trp-busca-ordenar" style="flex:1;background:#0c0e12;color:#e6e8ec;border:1px solid #2a2f3a;border-radius:6px;padding:6px;">' +
            '<option value="data">Mais recentes</option>' +
            '<option value="reacoes">Mais reacoes</option>' +
            "</select>" +
            '<input id="trp-busca-minimo" type="number" min="0" value="0" title="Minimo de reacoes" style="width:56px;background:#0c0e12;color:#e6e8ec;border:1px solid #2a2f3a;border-radius:6px;padding:6px;">';
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

        const campoBusca = campoTexto(corpo, "Palavra ou trecho a buscar", "text");

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
        labelServidor.textContent =
            "Tambem buscar ao vivo no servidor do Telegram (pega mensagem que o scan local ainda nao tem - precisa de um grupo especifico selecionado, nao funciona com \"Todos os grupos\")";
        blocoServidor.appendChild(checkboxServidor.elemento);
        blocoServidor.appendChild(labelServidor);
        corpo.appendChild(blocoServidor);

        const botaoBuscar = botaoAcao(corpo, "Buscar");

        const lista = document.createElement("div");
        corpo.appendChild(lista);

        // Cresce com "Mostrar mais" - comeca em 100. Com "Todos os grupos" e
        // uma palavra comum, o primeiro grupo (na ordem da chave primaria)
        // pode sozinho preencher esse limite e esconder os outros grupos -
        // "Mostrar mais" e o jeito de passar por ele e alcancar os demais
        // (ver nota em cima de buscarTexto()).
        let limiteAtual = 100;

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
            if (!termo) {
                lista.innerHTML = '<div style="color:#8b92a3;">Digita algo pra buscar.</div>';
                return;
            }
            lista.innerHTML = '<div style="color:#8b92a3;">Buscando...</div>';
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
            lista.innerHTML = "";

            if (erroServidor) {
                lista.insertAdjacentHTML(
                    "beforeend",
                    '<div style="color:#ff6b6b;font-size:11px;margin-bottom:6px;">Busca ao vivo no servidor falhou (' +
                        escapeHtml(erroServidor) +
                        ") - resultado abaixo e so o local.</div>"
                );
            }
            if (novasDoServidor.length) {
                lista.insertAdjacentHTML(
                    "beforeend",
                    '<div style="color:#5ec26a;font-size:11px;margin-bottom:6px;">' +
                        novasDoServidor.length +
                        " mensagem(ns) achada(s) ao vivo no servidor que nao estavam salvas local - ja salvei agora.</div>"
                );
            }

            const maisDeUmGrupo = !chatId && todasAsMensagens.some((m) => m.chatId !== todasAsMensagens[0].chatId);
            if (maisDeUmGrupo) {
                for (const grupo of agruparPorChat(todasAsMensagens)) {
                    const { cabecalho, seta } = criarCabecalhoGrupo(grupo.chatTitle, grupo.itens.length);
                    const containerItens = document.createElement("div");
                    cabecalho.addEventListener("click", () => {
                        const estaAberto = containerItens.style.display !== "none";
                        containerItens.style.display = estaAberto ? "none" : "block";
                        seta.textContent = estaAberto ? "▸" : "▾";
                    });
                    lista.appendChild(cabecalho);
                    lista.appendChild(containerItens);
                    for (const m of grupo.itens) containerItens.appendChild(criarItemResultado(m));
                }
            } else {
                for (const m of todasAsMensagens) lista.appendChild(criarItemResultado(m));
            }

            if (mensagens.length >= limiteAtual) {
                const botaoMais = botaoAcao(lista, "Mostrar mais");
                // "Buscando..." esvazia a lista por um instante, encolhendo a
                // altura do painel - como ele tem scroll proprio
                // (overflow:auto), o navegador trava o scrollTop em 0
                // sozinho nesse instante, e nao volta pra onde estava quando
                // a lista cheia volta a aparecer. Guarda e restaura na mao
                // pra nao jogar o usuario pro topo a cada "Mostrar mais".
                botaoMais.addEventListener("click", async () => {
                    const scrollAnterior = painel.scrollTop;
                    limiteAtual += 100;
                    await executarBusca();
                    restaurarScrollDepoisDoReflow(scrollAnterior);
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
            limiteAtual = 100;
            if (campoBusca.value.trim()) executarBusca();
        });
        selectOrdenar.addEventListener("change", () => {
            limiteAtual = 100;
            if (campoBusca.value.trim()) executarBusca();
        });
        inputMinimo.addEventListener("change", () => {
            limiteAtual = 100;
            if (campoBusca.value.trim()) executarBusca();
        });
        inputDataDe.addEventListener("change", () => {
            limiteAtual = 100;
            if (campoBusca.value.trim()) executarBusca();
        });
        inputDataAte.addEventListener("change", () => {
            limiteAtual = 100;
            if (campoBusca.value.trim()) executarBusca();
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
        const corpo = corpoDoPainel();
        botaoVoltar(corpo);

        const aviso = document.createElement("div");
        aviso.style.cssText = "color:#8b92a3;margin-bottom:10px;";
        aviso.textContent =
            'Busca GLOBAL do proprio Telegram em canais/supergrupos PUBLICOS que essa conta nao participa (grupo fechado nao e alcancado). Segundo o proprio blog do Telegram (ago/2025), esse recurso "e inicialmente disponivel so pra contas Premium" - sem Premium a busca falha com erro de conta Premium exigida, mesmo por hashtag. Com Premium, ainda tem uma cota diaria gratis e depois cobra em Telegram Stars.';
        corpo.appendChild(aviso);

        const statusCota = document.createElement("div");
        statusCota.style.cssText = "color:#8b92a3;margin-bottom:10px;font-size:11px;";
        statusCota.textContent = "Verificando cota de busca por texto livre...";
        corpo.appendChild(statusCota);

        cliente
            .invoke(new Api.channels.CheckSearchPostsFlood({}))
            .then((cota) => {
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
        corpo.appendChild(blocoModo);

        const campoBusca = campoTexto(corpo, "Palavra-chave (texto livre) ou hashtag", "text");
        const botaoBuscar = botaoAcao(corpo, "Buscar globalmente");

        const lista = document.createElement("div");
        corpo.appendChild(lista);

        // Pagina do jeito que a doc da API manda: offsetRate = nextRate da
        // pagina anterior (ou a data da ultima mensagem, se nextRate nao
        // vier); offsetPeer/offsetId = peer+id da ultima mensagem recebida.
        // null quando a busca ainda nao rodou ou quando a ultima pagina nao
        // trouxe como continuar. Segundo a doc da API, pedido de pagina
        // seguinte (com continuar=true) nao conta na cota diaria gratis de
        // busca por texto livre - so o primeiro pedido de cada busca nova
        // consome cota.
        let proximaPagina = null;

        function criarItemResultadoGlobal(m, chatsPorId) {
            const chatId = m.peerId && m.peerId.channelId != null ? String(m.peerId.channelId) : null;
            const chat = chatId ? chatsPorId.get(chatId) : null;
            const titulo = (chat && chat.title) || "Canal/grupo desconhecido";
            const username = chat && chat.username ? "@" + chat.username : null;
            const tipo = chat && chat.megagroup ? "grupo" : "canal";

            const item = document.createElement("div");
            item.style.cssText = "padding:8px 0;border-bottom:1px solid #2a2f3a;";
            item.innerHTML =
                '<div style="color:#4da3ff;font-weight:600;">' +
                escapeHtml(titulo) +
                " (" +
                tipo +
                ")</div>" +
                (username ? '<div style="color:#8b92a3;font-size:11px;">' + escapeHtml(username) + "</div>" : "") +
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

        async function executarBuscaGlobal(continuar) {
            const termo = campoBusca.value.trim();
            if (!termo) {
                lista.innerHTML = '<div style="color:#8b92a3;">Digita algo pra buscar.</div>';
                return;
            }
            if (!continuar) {
                lista.innerHTML = '<div style="color:#8b92a3;">Buscando nos canais/grupos publicos do Telegram...</div>';
                proximaPagina = { offsetRate: 0, offsetPeer: new Api.InputPeerEmpty({}), offsetId: 0 };
            }
            botaoBuscar.disabled = true;
            try {
                const parametros = {
                    offsetRate: proximaPagina.offsetRate,
                    offsetPeer: proximaPagina.offsetPeer,
                    offsetId: proximaPagina.offsetId,
                    limit: 20,
                };
                if (checkboxHashtag.checked) {
                    parametros.hashtag = termo.replace(/^#/, "");
                } else {
                    parametros.query = termo;
                }
                const resultado = await cliente.invoke(new Api.channels.SearchPosts(parametros));
                const mensagens = resultado.messages || [];
                const chatsPorId = new Map();
                for (const c of resultado.chats || []) chatsPorId.set(String(c.id), c);

                if (!continuar) lista.innerHTML = "";
                const botaoAntigo = lista.querySelector(".trp-carregar-mais");
                if (botaoAntigo) botaoAntigo.remove();

                if (!mensagens.length) {
                    if (!continuar) lista.innerHTML = '<div style="color:#8b92a3;">Nada encontrado com esse termo.</div>';
                    proximaPagina = null;
                    return;
                }

                if (resultado.inexact && !lista.querySelector(".trp-aviso-inexact")) {
                    const avisoInexact = document.createElement("div");
                    avisoInexact.className = "trp-aviso-inexact";
                    avisoInexact.style.cssText = "color:#8b92a3;font-size:11px;margin-bottom:6px;";
                    avisoInexact.textContent = 'Resultado aproximado (o Telegram marcou essa busca como "inexact").';
                    lista.insertBefore(avisoInexact, lista.firstChild);
                }

                for (const m of mensagens) {
                    lista.appendChild(criarItemResultadoGlobal(m, chatsPorId));
                }

                const ultima = mensagens[mensagens.length - 1];
                const chatIdUltima =
                    ultima.peerId && ultima.peerId.channelId != null ? String(ultima.peerId.channelId) : null;
                const chatUltima = chatIdUltima ? chatsPorId.get(chatIdUltima) : null;
                if (chatUltima && chatUltima.accessHash != null) {
                    proximaPagina = {
                        offsetRate: resultado.nextRate ?? ultima.date,
                        offsetPeer: new Api.InputPeerChannel({
                            channelId: chatUltima.id,
                            accessHash: chatUltima.accessHash,
                        }),
                        offsetId: ultima.id,
                    };
                    const botaoMais = botaoAcao(lista, "Carregar mais");
                    botaoMais.className = "trp-carregar-mais";
                    botaoMais.addEventListener("click", () => executarBuscaGlobal(true));
                } else {
                    // sem accessHash do ultimo chat nao da pra montar o
                    // offsetPeer da proxima pagina - para por aqui.
                    proximaPagina = null;
                }
            } catch (erro) {
                const mensagemErro =
                    '<div style="color:#ff6b6b;">Erro: ' +
                    escapeHtml(erro && erro.message ? erro.message : String(erro)) +
                    "</div>";
                if (continuar) {
                    lista.insertAdjacentHTML("beforeend", mensagemErro);
                } else {
                    lista.innerHTML = mensagemErro;
                }
                proximaPagina = null;
            } finally {
                botaoBuscar.disabled = false;
            }
        }

        botaoBuscar.addEventListener("click", () => executarBuscaGlobal(false));
        campoBusca.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") executarBuscaGlobal(false);
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
        const corpo = corpoDoPainel();
        botaoVoltar(corpo);

        const aviso = document.createElement("div");
        aviso.style.cssText = "color:#8b92a3;margin-bottom:10px;";
        aviso.textContent =
            'Confere se uma mensagem especifica (por exemplo, algo que voce viu na busca nativa do Telegram mas nao apareceu em "Buscar mensagens" aqui) ja esta no nosso banco local, e compara com o que existe ao vivo no Telegram agora. Serve pra saber se e falta de scan (ainda nao chegou la) ou outra coisa.';
        corpo.appendChild(aviso);

        const db = await abrirBanco();
        const chats = await listarChats(db);
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
