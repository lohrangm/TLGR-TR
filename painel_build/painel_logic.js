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

    let cliente = null; // instancia conectada, reaproveitada entre aberturas do painel
    let painel = null;

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
        const cabecalho = document.createElement("div");
        cabecalho.style.cssText =
            "display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;";
        cabecalho.innerHTML =
            '<strong>Top Reacoes</strong>' +
            '<button id="trp-fechar" style="background:none;border:none;color:#8b92a3;cursor:pointer;font-size:16px;">x</button>';
        painel.appendChild(cabecalho);
        cabecalho.querySelector("#trp-fechar").addEventListener("click", alternarPainel);
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
                "</div>" +
                '<div style="color:#8b92a3;margin-bottom:10px;">' +
                "Login feito direto aqui dentro, sem servidor externo. A sessao fica salva no proprio Tampermonkey - nao precisa logar de novo ao reabrir o painel." +
                "</div>";
            const botaoSair = botaoAcao(corpo, "Sair (apagar sessao salva)");
            botaoSair.style.background = "#3a2f2f";
            botaoSair.addEventListener("click", async () => {
                botaoSair.disabled = true;
                try {
                    await cliente.logOut();
                } catch (erro) {
                    // se der erro no logOut remoto, ainda assim limpa localmente
                }
                cliente = null;
                GM_setValue(CHAVE_SESSAO, "");
                decidirTela();
            });
        } catch (erro) {
            textoAviso(corpo, "Erro ao carregar a conta: " + (erro && erro.message ? erro.message : erro), "#ff6b6b");
        }
    }

    function escapeHtml(texto) {
        const div = document.createElement("div");
        div.textContent = texto == null ? "" : texto;
        return div.innerHTML;
    }

    criarBotao();
})();
