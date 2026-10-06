// Monta o arquivo final painel_telegram.user.js juntando:
//   1. o cabecalho ==UserScript==
//   2. o bundle.js (cliente MTProto em JS, gerado por build.mjs a partir do teleproto)
//   3. painel_logic.js (logica do painel/login, mantida a mao)
//
// Rodar sempre que build.mjs ou painel_logic.js mudar:
//   node montar_userscript.mjs

import { readFileSync, writeFileSync } from "fs";

const CABECALHO = `// ==UserScript==
// @name         Telegram Top Reacoes - Painel
// @namespace    telegram-top-reacoes
// @version      2.0.0
// @description  Login e (nas proximas versoes) scanner de reacoes direto dentro do Telegram Web, sem servidor local - cliente MTProto rodando em JS puro no proprio navegador
// @match        https://web.telegram.org/*
// @grant        GM_setValue
// @grant        GM_getValue
// @run-at       document-idle
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
    "\n// ==== FIM DO BUNDLE DO TELEPROTO - A PARTIR DAQUI E painel_logic.js ====\n\n" +
    painel;

const destino = new URL("./painel_telegram.user.js", import.meta.url);
writeFileSync(destino, conteudoFinal, "utf8");
console.log("Gerado:", destino.pathname, "-", (conteudoFinal.length / 1024 / 1024).toFixed(2), "MB");
