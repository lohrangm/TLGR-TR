(function () {
    "use strict";

    // Este trecho roda logo apos o bundle do teleproto (cliente MTProto em
    // JS puro) ter sido carregado nesse mesmo arquivo. Tudo acontece dentro
    // do proprio navegador, na mesma sessao do Telegram Web - sem servidor
    // local, sem Python, sem conexao externa de IP pra manter aberta.

    const { TelegramClient, StringSession, PromisedWebSockets } = window.TeleprotoBridge;

    const CHAVE_API_ID = "trp_api_id";
    const CHAVE_API_HASH = "trp_api_hash";
    const CHAVE_SESSAO = "trp_session";

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

    function textoPreview(mensagem) {
        let texto = (mensagem.message || "").trim().replace(/\s+/g, " ");
        if (!texto) texto = "[midia ou mensagem sem texto]";
        if (texto.length > 120) texto = texto.slice(0, 120) + "...";
        return texto;
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
        decidirTela();
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
            const botaoResultados = botaoAcao(corpo, "Ver top reacoes");
            botaoResultados.addEventListener("click", () => telaResultados());
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
            const badge = c.concluido
                ? '<span style="color:#5ec26a;">completo</span>'
                : '<span style="color:#e0a93a;">parcial</span>';
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
            : 'Escolhe um grupo especifico ou deixa em "Todos". Continua de onde parou da ultima vez - pode parar e retomar a hora que quiser.';
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
    async function escanearTudo(atualizarStatus, apenasChatId, aoAtualizarChat) {
        if (scanEmAndamento) return;
        scanEmAndamento = true;
        cancelarScanSolicitado = false;
        const db = await abrirBanco();
        try {
            for await (const dialog of cliente.iterDialogs({})) {
                if (cancelarScanSolicitado) break;
                if (!(dialog.isGroup || dialog.isChannel)) continue;

                const chatId = String(dialog.id);
                if (apenasChatId && chatId !== apenasChatId) continue;

                const chatTitle = dialog.title || dialog.name || chatId;
                const chatUsername = (dialog.entity && dialog.entity.username) || null;

                const chatSalvo = await buscarChat(db, chatId);
                const ultimoId = (chatSalvo && chatSalvo.lastScannedMessageId) || 0;

                atualizarStatus(`Escaneando: ${chatTitle} (a partir da mensagem ${ultimoId})...`);

                let maxIdVisto = ultimoId;
                let totalVistas = 0;
                let comReacao = 0;
                let terminouSemCancelar = true;
                const inicio = Date.now();

                for await (const mensagem of cliente.iterMessages(dialog.entity, { minId: ultimoId, reverse: true })) {
                    if (cancelarScanSolicitado) {
                        terminouSemCancelar = false;
                        break;
                    }
                    totalVistas++;
                    maxIdVisto = Math.max(maxIdVisto, mensagem.id);

                    const { reactions, total } = extrairReacoes(mensagem);
                    if (total > 0) {
                        await salvarMensagem(db, {
                            key: chatId + ":" + mensagem.id,
                            chatId,
                            messageId: mensagem.id,
                            dateUtc: dataIso(mensagem),
                            textPreview: textoPreview(mensagem),
                            reactionTotal: total,
                            reactions,
                            chatTitle,
                        });
                        comReacao++;
                    }

                    if (totalVistas % 500 === 0) {
                        const segundos = Math.round((Date.now() - inicio) / 1000);
                        atualizarStatus(
                            `${chatTitle}: ${totalVistas} mensagens verificadas (${segundos}s), ${comReacao} com reacao...`
                        );
                        await salvarChat(db, {
                            chatId,
                            chatTitle,
                            chatUsername,
                            lastScannedMessageId: maxIdVisto,
                            lastScannedAt: new Date().toISOString(),
                            concluido: false,
                        });
                        if (aoAtualizarChat) await aoAtualizarChat();
                    }
                }

                await salvarChat(db, {
                    chatId,
                    chatTitle,
                    chatUsername,
                    lastScannedMessageId: maxIdVisto,
                    lastScannedAt: new Date().toISOString(),
                    concluido: terminouSemCancelar,
                });
                if (aoAtualizarChat) await aoAtualizarChat();

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

        async function atualizarLista() {
            lista.innerHTML = '<div style="color:#8b92a3;">Carregando...</div>';
            const chatId = selectGrupo.value || null;
            const minimo = parseInt(inputMinimo.value, 10) || 1;
            const mensagens = await buscarTop(db, { chatId, minimo, limite: 50 });
            if (!mensagens.length) {
                lista.innerHTML = '<div style="color:#8b92a3;">Nenhuma mensagem encontrada com esse filtro.</div>';
                return;
            }
            lista.innerHTML = "";
            for (const m of mensagens) {
                const item = document.createElement("div");
                item.style.cssText = "padding:8px 0;border-bottom:1px solid #2a2f3a;";
                item.innerHTML =
                    '<div style="color:#4da3ff;font-weight:600;cursor:pointer;" class="trp-abrir">' +
                    m.reactionTotal +
                    " reacoes - " +
                    escapeHtml(m.dateUtc.slice(0, 10)) +
                    "</div>" +
                    '<div style="color:#8b92a3;font-size:11px;">' +
                    escapeHtml(m.chatTitle) +
                    "</div>" +
                    "<div>" +
                    escapeHtml(m.textPreview) +
                    "</div>";
                item.querySelector(".trp-abrir").addEventListener("click", () => {
                    const url = "https://web.telegram.org/k/#" + idBaseDoChatId(m.chatId) + "?post=" + m.messageId;
                    console.log("[Top Reacoes] abrindo:", url);
                    window.open(url, "_blank");
                });
                lista.appendChild(item);
            }
        }

        selectGrupo.addEventListener("change", atualizarLista);
        inputMinimo.addEventListener("change", atualizarLista);
        await atualizarLista();
    }

    function escapeHtml(texto) {
        const div = document.createElement("div");
        div.textContent = texto == null ? "" : texto;
        return div.innerHTML;
    }

    criarBotao();
})();
