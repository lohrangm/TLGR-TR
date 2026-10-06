// ==UserScript==
// @name         Telegram Top Reacoes - Painel
// @namespace    telegram-top-reacoes
// @version      1.0.0
// @description  Painel com as mensagens de mais reacoes dentro do proprio Telegram Web, usando os dados ja escaneados localmente
// @match        https://web.telegram.org/*
// @grant        GM_xmlhttpRequest
// @connect      127.0.0.1
// ==/UserScript==

(function () {
    "use strict";

    const API_BASE = "http://127.0.0.1:8765";

    function buscarJson(caminho) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: "GET",
                url: API_BASE + caminho,
                onload: (resposta) => {
                    try {
                        resolve(JSON.parse(resposta.responseText));
                    } catch (erro) {
                        reject(erro);
                    }
                },
                onerror: reject,
            });
        });
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

    let painel = null;

    function alternarPainel() {
        if (painel) {
            painel.remove();
            painel = null;
            return;
        }
        montarPainel();
    }

    async function montarPainel() {
        painel = document.createElement("div");
        Object.assign(painel.style, {
            position: "fixed",
            top: "40px",
            right: "24px",
            width: "480px",
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
        painel.innerHTML =
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">' +
            '<strong>Top Reacoes</strong>' +
            '<button id="trp-fechar" style="background:none;border:none;color:#8b92a3;cursor:pointer;font-size:16px;">x</button>' +
            '</div>' +
            '<div style="display:flex;gap:8px;margin-bottom:10px;">' +
            '<select id="trp-grupo" style="flex:1;background:#0c0e12;color:#e6e8ec;border:1px solid #2a2f3a;border-radius:6px;padding:6px;">' +
            '<option value="">Todos os grupos</option>' +
            '</select>' +
            '<input id="trp-minimo" type="number" min="1" value="1" style="width:64px;background:#0c0e12;color:#e6e8ec;border:1px solid #2a2f3a;border-radius:6px;padding:6px;">' +
            '</div>' +
            '<div id="trp-aviso" style="color:#8b92a3;">Carregando...</div>' +
            '<div id="trp-lista"></div>';
        document.body.appendChild(painel);

        painel.querySelector("#trp-fechar").addEventListener("click", alternarPainel);
        painel.querySelector("#trp-grupo").addEventListener("change", carregarLista);
        painel.querySelector("#trp-minimo").addEventListener("change", carregarLista);

        try {
            const grupos = await buscarJson("/api/grupos");
            const select = painel.querySelector("#trp-grupo");
            for (const g of grupos) {
                const opcao = document.createElement("option");
                opcao.value = g.chat_id;
                opcao.textContent = g.chat_title + " (" + g.total + ")";
                select.appendChild(opcao);
            }
        } catch (erro) {
            painel.querySelector("#trp-aviso").textContent =
                "Nao foi possivel conectar no servidor local. O python dashboard.py esta rodando?";
            return;
        }

        await carregarLista();
    }

    async function carregarLista() {
        const grupoId = painel.querySelector("#trp-grupo").value;
        const minimo = painel.querySelector("#trp-minimo").value || 1;
        const aviso = painel.querySelector("#trp-aviso");
        const lista = painel.querySelector("#trp-lista");

        aviso.textContent = "Carregando...";
        lista.innerHTML = "";

        let parametros = "min=" + encodeURIComponent(minimo) + "&limite=50";
        if (grupoId) {
            parametros += "&chat_id=" + encodeURIComponent(grupoId);
        }

        try {
            const dados = await buscarJson("/api/top?" + parametros);
            aviso.textContent = "";
            if (!dados.mensagens.length) {
                aviso.textContent = "Nenhuma mensagem encontrada com esse filtro.";
                return;
            }
            for (const mensagem of dados.mensagens) {
                const item = document.createElement("div");
                item.style.cssText =
                    "padding:8px 0;border-bottom:1px solid #2a2f3a;cursor:pointer;";
                item.innerHTML =
                    '<div style="color:#4da3ff;font-weight:600;">' +
                    mensagem.reacoes + " reacoes - " + mensagem.data +
                    '</div>' +
                    '<div style="color:#8b92a3;font-size:11px;">' + mensagem.grupo + '</div>' +
                    '<div>' + mensagem.mensagem + '</div>';
                item.addEventListener("click", function () {
                    navegarPara(mensagem.chat_id, mensagem.message_id);
                });
                lista.appendChild(item);
            }
        } catch (erro) {
            aviso.textContent = "Erro ao buscar dados do servidor local.";
        }
    }

    function navegarPara(chatId, messageId) {
        const destino = "#" + chatId + "_" + messageId;
        if (window.location.hash === destino) {
            window.location.hash = "";
        }
        window.location.hash = destino;
    }

    criarBotao();
})();
