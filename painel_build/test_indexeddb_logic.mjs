import { indexedDB, IDBKeyRange } from "fake-indexeddb";

const NOME_BANCO = "TesteTopReacoes";
const VERSAO_BANCO = 1;

function abrirBanco() {
    return new Promise((resolve, reject) => {
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

function salvarMensagem(db, registro) {
    return new Promise((resolve, reject) => {
        const pedido = transacao(db, "mensagens", "readwrite").put(registro);
        pedido.onsuccess = () => resolve();
        pedido.onerror = () => reject(pedido.error);
    });
}

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

function buscarMensagem(db, key) {
    return new Promise((resolve, reject) => {
        const pedido = transacao(db, "mensagens", "readonly").get(key);
        pedido.onsuccess = () => resolve(pedido.result || null);
        pedido.onerror = () => reject(pedido.error);
    });
}

function normalizarTexto(texto) {
    return (texto || "")
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase();
}

function buscarTexto(db, { termo, chatId, minimo, limite, ordenarPor, dataDe, dataAte }) {
    return new Promise((resolve, reject) => {
        const palavras = normalizarTexto(termo)
            .split(/\s+/)
            .filter(Boolean);
        const minimoReacoes = minimo || 0;
        const resultados = [];
        let visitados = 0;
        const LIMITE_VISITAS = 300000;

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

function contarMensagensDoChat(db, chatId) {
    return new Promise((resolve, reject) => {
        const indice = transacao(db, "mensagens", "readonly").index("por_chat");
        const pedido = indice.count(IDBKeyRange.only(chatId));
        pedido.onsuccess = () => resolve(pedido.result);
        pedido.onerror = () => reject(pedido.error);
    });
}

function buscarTop(db, { chatId, minimo, limite, dataDe, dataAte }) {
    return new Promise((resolve, reject) => {
        const resultados = [];
        const indice = transacao(db, "mensagens", "readonly").index("por_reacoes");
        const pedido = indice.openCursor(null, "prev");
        let visitados = 0;
        const LIMITE_VISITAS = 50000;
        pedido.onsuccess = () => {
            const cursor = pedido.result;
            if (!cursor || resultados.length >= limite || visitados >= LIMITE_VISITAS) {
                resolve(resultados);
                return;
            }
            visitados++;
            const valor = cursor.value;
            if (valor.reactionTotal < minimo) {
                resolve(resultados);
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

function assert(cond, msg) {
    if (!cond) throw new Error("FALHOU: " + msg);
    console.log("OK: " + msg);
}

const db = await abrirBanco();

await salvarChat(db, { chatId: "A", chatTitle: "Grupo A", lastScannedMessageId: 100 });
await salvarChat(db, { chatId: "B", chatTitle: "Grupo B", lastScannedMessageId: 50 });

const dados = [
    { key: "A:1", chatId: "A", messageId: 1, reactionTotal: 5, chatTitle: "Grupo A", textPreview: "a1", dateUtc: "2026-01-01T00:00:00Z" },
    { key: "A:2", chatId: "A", messageId: 2, reactionTotal: 50, chatTitle: "Grupo A", textPreview: "a2", dateUtc: "2026-01-02T00:00:00Z" },
    { key: "A:3", chatId: "A", messageId: 3, reactionTotal: 2, chatTitle: "Grupo A", textPreview: "a3", dateUtc: "2026-01-03T00:00:00Z" },
    { key: "B:1", chatId: "B", messageId: 1, reactionTotal: 30, chatTitle: "Grupo B", textPreview: "b1", dateUtc: "2026-01-04T00:00:00Z" },
    { key: "B:2", chatId: "B", messageId: 2, reactionTotal: 10, chatTitle: "Grupo B", textPreview: "b2", dateUtc: "2026-01-05T00:00:00Z" },
];
for (const d of dados) await salvarMensagem(db, d);

// Top geral, min 1, limite 10 - deve vir ordenado desc por reactionTotal, todos os 5
const top1 = await buscarTop(db, { chatId: null, minimo: 1, limite: 10 });
assert(top1.length === 5, "top geral retorna todas as 5 mensagens (veio " + top1.length + ")");
assert(top1[0].reactionTotal === 50, "primeira do top geral e a de 50 reacoes (veio " + top1[0].reactionTotal + ")");
assert(top1[top1.length - 1].reactionTotal === 2, "ultima do top geral e a de 2 reacoes (veio " + top1[top1.length - 1].reactionTotal + ")");
assert(
    top1.every((m, i) => i === 0 || m.reactionTotal <= top1[i - 1].reactionTotal),
    "top geral esta em ordem decrescente"
);

// Filtro por minimo = 10 - deve excluir as de 5 e 2
const top2 = await buscarTop(db, { chatId: null, minimo: 10, limite: 10 });
assert(top2.length === 3, "filtro minimo=10 retorna 3 mensagens (veio " + top2.length + ")");
assert(top2.every((m) => m.reactionTotal >= 10), "todas as retornadas tem >= 10 reacoes");

// Filtro por grupo B - so as 2 mensagens do grupo B, maior primeiro
const top3 = await buscarTop(db, { chatId: "B", minimo: 1, limite: 10 });
assert(top3.length === 2, "filtro grupo B retorna 2 mensagens (veio " + top3.length + ")");
assert(top3[0].chatId === "B" && top3[0].reactionTotal === 30, "primeira do grupo B e a de 30 reacoes");

// Limite respeitado
const top4 = await buscarTop(db, { chatId: null, minimo: 1, limite: 2 });
assert(top4.length === 2, "limite=2 retorna exatamente 2 (veio " + top4.length + ")");

// Filtro de periodo (buscarTop) - 01-02 a 01-04 pega A:2(01-02), A:3(01-03) e B:1(01-04),
// deixa de fora A:1(01-01) e B:2(01-05)
const top5 = await buscarTop(db, { chatId: null, minimo: 1, limite: 10, dataDe: "2026-01-02", dataAte: "2026-01-04" });
assert(top5.length === 3, "filtro de periodo em buscarTop retorna 3 mensagens (veio " + top5.length + ")");
assert(
    top5.every((m) => m.dateUtc.slice(0, 10) >= "2026-01-02" && m.dateUtc.slice(0, 10) <= "2026-01-04"),
    "todas as retornadas do filtro de periodo em buscarTop estao dentro do intervalo"
);

// So dataDe (sem dataAte) - a partir de 01-05 em diante, so sobra B:2
const top6 = await buscarTop(db, { chatId: null, minimo: 1, limite: 10, dataDe: "2026-01-05" });
assert(
    top6.length === 1 && top6[0].key === "B:2",
    "so dataDe (buscarTop, sem dataAte) traz so quem bate a partir dali (veio " + top6.length + ")"
);

// ---- contarMensagensDoChat - base da tabela "o que ja esta salvo" ----
const totalA = await contarMensagensDoChat(db, "A");
assert(totalA === 3, "grupo A tem 3 mensagens com reacao salvas (veio " + totalA + ")");
const totalB = await contarMensagensDoChat(db, "B");
assert(totalB === 2, "grupo B tem 2 mensagens com reacao salvas (veio " + totalB + ")");
const totalC = await contarMensagensDoChat(db, "C");
assert(totalC === 0, "grupo nunca escaneado (C) tem 0 mensagens salvas (veio " + totalC + ")");

// ---- concluido - marca se o scan do chat terminou de verdade ou ficou parcial ----
await salvarChat(db, { chatId: "A", chatTitle: "Grupo A", lastScannedMessageId: 100, concluido: true });
await salvarChat(db, { chatId: "B", chatTitle: "Grupo B", lastScannedMessageId: 30, concluido: false });
const chatA = await buscarChat(db, "A");
const chatB = await buscarChat(db, "B");
assert(chatA.concluido === true, "grupo A persiste concluido=true");
assert(chatB.concluido === false, "grupo B persiste concluido=false (scan parcial)");

// ---- buscarTexto - busca por palavra-chave, ignorando acento/caixa ----
await salvarMensagem(db, {
    key: "A:4",
    chatId: "A",
    messageId: 4,
    reactionTotal: 0,
    chatTitle: "Grupo A",
    texto: "Aqui fala sobre informação confidencial do projeto",
    dateUtc: "2026-01-06T00:00:00Z",
});
await salvarMensagem(db, {
    key: "B:3",
    chatId: "B",
    messageId: 3,
    reactionTotal: 0,
    chatTitle: "Grupo B",
    texto: "Nada a ver com o termo buscado",
    dateUtc: "2026-01-07T00:00:00Z",
});

const achouSemAcento = await buscarTexto(db, { termo: "informacao", chatId: null, limite: 10 });
assert(
    achouSemAcento.some((m) => m.chatId === "A" && m.messageId === 4),
    "acha 'informacao' (sem acento) batendo com 'informação' no texto original"
);

const achouComAcentoEMaiuscula = await buscarTexto(db, { termo: "INFORMAÇÃO", chatId: null, limite: 10 });
assert(achouComAcentoEMaiuscula.length === 1, "busca ignora acento e caixa tambem no termo digitado");

const filtradoPorChatErrado = await buscarTexto(db, { termo: "informacao", chatId: "B", limite: 10 });
assert(filtradoPorChatErrado.length === 0, "filtro por chat respeita o grupo escolhido (B nao tem esse termo)");

const semResultado = await buscarTexto(db, { termo: "termoquenaoexisteemlugarnenhum", chatId: null, limite: 10 });
assert(semResultado.length === 0, "termo inexistente retorna lista vazia");

// ---- buscarTexto com termo de mais de uma palavra - reproduz o caso
// relatado pelo usuario. Primeiro o termo inteiro era tratado como uma
// unica substring (exigia as palavras juntas, coladas, nessa ordem - so
// "Arlene Lee" literal batia). Depois tentei E logico (exigir as duas
// palavras, em qualquer posicao) - mas o usuario pediu pra manter a
// ferramenta a mais ampla possivel: no conceito dele, "Darlene"/"Marlene"
// (que so tem "arlene") DEVEM continuar aparecendo numa busca por "arlene
// lee", porque o problema real e perder mensagem, nao mostrar mensagem a
// mais. Ficou OU logico: basta UMA das palavras aparecer.
await salvarMensagem(db, {
    key: "A:6",
    chatId: "A",
    messageId: 6,
    reactionTotal: 0,
    chatTitle: "Grupo A",
    texto: "Lee, voce tem noticia da Arlene?",
    dateUtc: "2026-01-08T00:00:00Z",
});
await salvarMensagem(db, {
    key: "A:7",
    chatId: "A",
    messageId: 7,
    reactionTotal: 0,
    chatTitle: "Grupo A",
    texto: "Arlene Lee confirmou presenca",
    dateUtc: "2026-01-09T00:00:00Z",
});
await salvarMensagem(db, {
    key: "A:8",
    chatId: "A",
    messageId: 8,
    reactionTotal: 0,
    chatTitle: "Grupo A",
    texto: "So a Arlene veio, sem mais ninguem",
    dateUtc: "2026-01-10T00:00:00Z",
});
await salvarMensagem(db, {
    key: "A:9",
    chatId: "A",
    messageId: 9,
    reactionTotal: 0,
    chatTitle: "Grupo A",
    texto: "Nada a ver com nenhum dos dois nomes",
    dateUtc: "2026-01-11T00:00:00Z",
});

const duasPalavras = await buscarTexto(db, { termo: "arlene lee", chatId: "A", limite: 10 });
assert(
    duasPalavras.some((m) => m.messageId === 6),
    "'arlene lee' acha mensagem com as duas palavras separadas e fora de ordem (Lee ... Arlene)"
);
assert(
    duasPalavras.some((m) => m.messageId === 7),
    "'arlene lee' continua achando a frase exata tambem"
);
assert(
    duasPalavras.some((m) => m.messageId === 8),
    "'arlene lee' TAMBEM acha mensagem que so tem 'arlene' (OU logico, de proposito - busca mais ampla)"
);
assert(
    !duasPalavras.some((m) => m.messageId === 9),
    "'arlene lee' NAO acha mensagem sem nenhuma das duas palavras"
);
assert(duasPalavras.length === 3, "'arlene lee' traz as 3 mensagens que tem pelo menos uma das palavras (veio " + duasPalavras.length + ")");

// ---- buscarTexto: filtro de periodo (dataDe/dataAte) ----
// Mesmas 4 mensagens (A:6 a A:9, datas 01-08 a 01-11) - filtra so o meio.
const comPeriodo = await buscarTexto(db, {
    termo: "arlene lee",
    chatId: "A",
    limite: 10,
    dataDe: "2026-01-09",
    dataAte: "2026-01-10",
});
assert(
    !comPeriodo.some((m) => m.messageId === 6),
    "dataDe=01-09 exclui a mensagem de 01-08 (antes do periodo)"
);
assert(comPeriodo.some((m) => m.messageId === 7), "periodo 01-09 a 01-10 inclui a mensagem de 01-09");
assert(comPeriodo.some((m) => m.messageId === 8), "periodo 01-09 a 01-10 inclui a mensagem de 01-10");
assert(comPeriodo.length === 2, "filtro de periodo traz so as 2 mensagens dentro da janela (veio " + comPeriodo.length + ")");
const soDataDe = await buscarTexto(db, { termo: "arlene lee", chatId: "A", limite: 10, dataDe: "2026-01-10" });
assert(
    soDataDe.length === 1 && soDataDe[0].messageId === 8,
    "so dataDe (sem dataAte) traz so quem bate no termo a partir dali em diante (veio " + soDataDe.length + ")"
);

// ---- idBaseDoChatId (copiada de painel_logic.js) ----
// O link que abre a MENSAGEM EXATA (visto no codigo-fonte do Telegram Web,
// appImManager.ts) e "#<id puro>?post=<id da mensagem>" - sem sinal, sem
// "100". Essa funcao tira o sinal e o "100" do chatId que a gente guarda
// (convencao Bot API: "-id" pra grupo basico, "-100id" pra canal/supergrupo).
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

assert(
    idBaseDoChatId("-1001316938498") === "1316938498",
    "canal/supergrupo: tira o sinal e o 100 do meio (-1001316938498 -> 1316938498)"
);
assert(idBaseDoChatId("-1316938498") === "1316938498", "grupo basico: tira so o sinal (-1316938498 -> 1316938498)");

// ---- marcarVisto - toggle manual de "ja visualizado" por mensagem ----
await salvarMensagem(db, {
    key: "A:5",
    chatId: "A",
    messageId: 5,
    reactionTotal: 1,
    chatTitle: "Grupo A",
    texto: "mensagem qualquer",
    dateUtc: "2026-01-08T00:00:00Z",
});
let msgA5 = await buscarMensagem(db, "A:5");
assert(!msgA5.visto, "mensagem recem salva comeca sem 'visto' marcado");

await marcarVisto(db, "A:5", true);
msgA5 = await buscarMensagem(db, "A:5");
assert(msgA5.visto === true, "marcarVisto(true) persiste visto=true");

await marcarVisto(db, "A:5", false);
msgA5 = await buscarMensagem(db, "A:5");
assert(msgA5.visto === false, "marcarVisto(false) desmarca de novo");

await marcarVisto(db, "chave-que-nao-existe", true);
assert(true, "marcarVisto numa chave inexistente nao quebra (so nao faz nada)");

// ---- buscarTexto: "grupo comum esconde os outros" e a correcao via paginacao ----
// Grupo A (vem antes na ordem lexicografica da chave primaria) recebe 5
// mensagens batendo com o termo; grupo Z (vem depois) recebe so 1. Com
// limite curto, o cursor para dentro do grupo A e nunca chega no Z -
// reproduz exatamente o bug relatado. Com limite maior (equivalente a
// clicar "Mostrar mais"), o Z aparece.
for (let i = 1; i <= 5; i++) {
    await salvarMensagem(db, {
        key: "A:" + (10 + i),
        chatId: "A",
        messageId: 10 + i,
        reactionTotal: i,
        chatTitle: "Grupo A",
        texto: "promocao demais por aqui " + i,
        dateUtc: "2026-02-0" + i + "T00:00:00Z",
    });
}
await salvarMensagem(db, {
    key: "Z:1",
    chatId: "Z",
    messageId: 1,
    reactionTotal: 99,
    chatTitle: "Grupo Z",
    texto: "promocao incrivel aqui tambem",
    dateUtc: "2026-02-10T00:00:00Z",
});

const paginaCurta = await buscarTexto(db, { termo: "promocao", chatId: null, limite: 3, ordenarPor: "data" });
assert(paginaCurta.length === 3, "limite curto (3) retorna so 3 resultados (veio " + paginaCurta.length + ")");
assert(
    paginaCurta.every((m) => m.chatId === "A"),
    "limite curto (3) fica preso no grupo A (lexicograficamente primeiro) - reproduz o bug relatado"
);

const paginaCompleta = await buscarTexto(db, { termo: "promocao", chatId: null, limite: 10, ordenarPor: "data" });
assert(
    paginaCompleta.some((m) => m.chatId === "Z"),
    "limite maior (equivalente a \"Mostrar mais\") alcanca o grupo Z que ficava escondido"
);
assert(
    paginaCompleta.length === 6,
    "limite 10 traz todas as 6 mensagens que batem com o termo (veio " + paginaCompleta.length + ")"
);

const porReacoes = await buscarTexto(db, { termo: "promocao", chatId: null, limite: 10, ordenarPor: "reacoes" });
assert(
    porReacoes[0].chatId === "Z" && porReacoes[0].reactionTotal === 99,
    "ordenarPor='reacoes' poe a mensagem de 99 reacoes primeiro"
);
assert(
    porReacoes.every((m, i) => i === 0 || (m.reactionTotal || 0) <= (porReacoes[i - 1].reactionTotal || 0)),
    "ordenarPor='reacoes' esta em ordem decrescente"
);

const comMinimo = await buscarTexto(db, {
    termo: "promocao",
    chatId: null,
    minimo: 50,
    limite: 10,
    ordenarPor: "data",
});
assert(
    comMinimo.length === 1 && comMinimo[0].chatId === "Z",
    "filtro minimo=50 deixa so a mensagem do grupo Z (99 reacoes)"
);

// ---- agruparPorChat - base do agrupar/maximizar-minimizar por grupo na busca ----
const agrupado = agruparPorChat(porReacoes);
assert(agrupado.length === 2, "agruparPorChat junta num grupo por chat (veio " + agrupado.length + " grupos)");
assert(
    agrupado[0].chatId === "Z",
    "agruparPorChat mantem o grupo do resultado mais relevante primeiro (Z, que veio primeiro por reacoes)"
);
assert(
    agrupado[0].itens.length === 1 && agrupado[1].itens.length === 5,
    "contagem de itens por grupo bate (Z=1, A=5)"
);

console.log("\nTODOS OS TESTES PASSARAM");
