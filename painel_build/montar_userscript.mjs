// Monta o arquivo final painel_telegram.user.js juntando:
//   1. o cabecalho ==UserScript==
//   2. o bundle.js (cliente MTProto em JS, gerado por build.mjs a partir do teleproto)
//   3. painel_logic.js (logica do painel/login, mantida a mao)
//
// Rodar sempre que build.mjs ou painel_logic.js mudar:
//   node montar_userscript.mjs

import { readFileSync, writeFileSync } from "fs";

// Fonte unica da versao: usada tanto no @version do cabecalho
// ==UserScript== (o que o Tampermonkey mostra no dashboard dele) quanto no
// numero exibido dentro do proprio painel (window.TRP_VERSAO, lido por
// painel_logic.js). Formato AAAA.MM.DD.N (N = numero da entrega naquele
// dia, comecando em 1) - BUMP AQUI a cada vez que gerar uma nova entrega,
// pra quem esta testando saber se o Tampermonkey ja pegou a versao nova ou
// ainda esta rodando uma antiga.
const VERSAO = "2026.10.08.8";

// URL que o proprio Tampermonkey confere (sozinho, periodicamente, ou na
// hora se voce pedir "Check for userscript updates" no Dashboard dele)
// pra saber se tem versao nova. Agora aponta pro raw do repositorio no
// GitHub (publico) - sempre no ar, nao depende de nada rodando na sua
// maquina (o iniciar_servidor_userscript.bat deixou de ser necessario).
const URL_ATUALIZACAO = "https://raw.githubusercontent.com/lohrangm/TLGR-TR/master/painel_build/painel_telegram.user.js";

const CABECALHO = `// ==UserScript==
// @name         Telegram Top Reacoes - Painel
// @namespace    telegram-top-reacoes
// @version      ${VERSAO}
// @description  Login e (nas proximas versoes) scanner de reacoes direto dentro do Telegram Web, sem servidor local - cliente MTProto rodando em JS puro no proprio navegador
// @match        https://web.telegram.org/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
// @updateURL    ${URL_ATUALIZACAO}
// @downloadURL  ${URL_ATUALIZACAO}
// ==/UserScript==

// Arquivo gerado automaticamente por montar_userscript.mjs - nao editar
// direto as partes vindas do bundle (procure por "FIM DO BUNDLE DO TELEPROTO"
// pra achar onde comeca a parte escrita a mao, em painel_logic.js).

`;

const bundle = readFileSync(new URL("./bundle.js", import.meta.url), "utf8");
const painel = readFileSync(new URL("./painel_logic.js", import.meta.url), "utf8");

const conteudoFinal =
    CABECALHO +
    bundle +
    `\nwindow.TRP_VERSAO = ${JSON.stringify(VERSAO)};\n` +
    "\n// ==== FIM DO BUNDLE DO TELEPROTO - A PARTIR DAQUI E painel_logic.js ====\n\n" +
    painel;

const destino = new URL("./painel_telegram.user.js", import.meta.url);
writeFileSync(destino, conteudoFinal, "utf8");
console.log("Gerado:", destino.pathname, "-", (conteudoFinal.length / 1024 / 1024).toFixed(2), "MB");
