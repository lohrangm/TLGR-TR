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

function contarMensagensDoChat(db, chatId) {
    return new Promise((resolve, reject) => {
        const indice = transacao(db, "mensagens", "readonly").index("por_chat");
        const pedido = indice.count(IDBKeyRange.only(chatId));
        pedido.onsuccess = () => resolve(pedido.result);
        pedido.onerror = () => reject(pedido.error);
    });
}

function buscarTop(db, { chatId, minimo, limite }) {
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
            if (!chatId || valor.chatId === chatId) {
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

console.log("\nTODOS OS TESTES PASSARAM");
