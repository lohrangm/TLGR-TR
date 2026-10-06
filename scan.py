"""Escaneia os grupos e canais do Telegram via API oficial (Telethon) e grava
as mensagens com reacoes num banco SQLite local, de forma incremental.

Quais grupos/canais entram no scan e controlado pelo arquivo
grupos_para_escanear.txt (gerado e atualizado pelo list_chats.py). Se esse
arquivo nao existir, escaneia automaticamente TODOS os grupos e canais da
conta (conversas privadas com pessoas sao sempre ignoradas).

Uso:
    python scan.py                                   escaneia tudo que estiver ativo em grupos_para_escanear.txt
    python scan.py --top 20                          escaneia e depois mostra as 20 com mais reacoes
    python scan.py --top-only 20                      so mostra o top, sem escanear de novo
    python scan.py --limite-por-chat 1000 --top 20    escaneia no maximo 1000 mensagens novas por grupo nesta
                                                       rodada (rapido pra um primeiro teste; continua de onde
                                                       parou na proxima execucao, sem perder progresso)
"""

import argparse
import asyncio
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv
from tabulate import tabulate
from telethon import TelegramClient
from telethon.tl.types import Channel

import db

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

API_ID = int(os.environ["TELEGRAM_API_ID"])
API_HASH = os.environ["TELEGRAM_API_HASH"]
PHONE = os.environ.get("TELEGRAM_PHONE") or None

SESSION_PATH = BASE_DIR / "data" / "session"
DB_PATH = BASE_DIR / "data" / "reacoes.db"
GRUPOS_PATH = BASE_DIR / "grupos_para_escanear.txt"

CABECALHO_GRUPOS = (
    "# Grupos e canais do Telegram - edite esta lista livremente.\n"
    "# Apague (ou comente com # na frente) as linhas dos grupos que voce NAO quer escanear.\n"
    "# Formato: identificador | nome (o nome e so pra voce reconhecer, o scan usa o identificador)\n"
    "# Depois de editar e salvar, basta rodar o scan.py normalmente - ele le esse arquivo sozinho.\n"
)


def build_link(entity, message_id):
    username = getattr(entity, "username", None)
    if username:
        return f"https://t.me/{username}/{message_id}"
    if isinstance(entity, Channel):
        return f"https://t.me/c/{entity.id}/{message_id}"
    return None


def extract_reactions(message):
    reactions = []
    total = 0
    if message.reactions and message.reactions.results:
        for result in message.reactions.results:
            emoji = getattr(result.reaction, "emoticon", None) or "custom"
            reactions.append({"emoji": emoji, "count": result.count})
            total += result.count
    return reactions, total


def preview_text(message):
    text = (message.message or "").strip()
    text = " ".join(text.split())
    if not text:
        text = "[midia ou mensagem sem texto]"
    if len(text) > 120:
        text = text[:120] + "..."
    return text


def identificador_display(dialog):
    """Identificador no formato mostrado pro usuario: @username, ou o id
    numerico quando o chat nao tem username publico."""
    username = getattr(dialog.entity, "username", None)
    return f"@{username}" if username else str(dialog.id)


def identificadores_do_dialog(dialog):
    """Todas as formas validas de identificar esse dialog (id numerico e,
    se tiver, username em minusculo), pra bater contra a lista de selecao."""
    username = getattr(dialog.entity, "username", None)
    ids = {str(dialog.id)}
    if username:
        ids.add(username.lower())
    return ids


def formatar_linha_grupo(identificador, nome):
    return f"{identificador} | {nome}"


def ler_identificador_da_linha(linha):
    """Extrai o identificador (antes do '|') de uma linha do arquivo de
    selecao, ja normalizado (sem @, minusculo) pra comparar com
    identificadores_do_dialog()."""
    return linha.split("|", 1)[0].strip().lstrip("@").lower()


def carregar_selecao():
    """Le grupos_para_escanear.txt e devolve o conjunto de identificadores
    ativos (linhas que nao estao vazias nem comentadas com #).

    Devolve None se o arquivo nao existir - nesse caso o scan roda no modo
    automatico (escaneia todos os grupos/canais).
    """
    if not GRUPOS_PATH.exists():
        return None
    ativos = set()
    for linha in GRUPOS_PATH.read_text(encoding="utf-8").splitlines():
        linha = linha.strip()
        if not linha or linha.startswith("#") or "|" not in linha:
            continue
        ativos.add(ler_identificador_da_linha(linha))
    return ativos


def atualizar_arquivo_grupos(grupos_e_canais):
    """Cria ou atualiza grupos_para_escanear.txt a partir dos grupos/canais
    encontrados agora (lista de dialogs do telethon).

    Grupos ja presentes no arquivo (ativos ou comentados) sao preservados do
    jeito que o usuario deixou. Grupos novos (que a conta entrou desde a
    ultima vez) sao adicionados numa secao separada no final, pra revisao -
    nunca sobrescreve uma escolha que o usuario ja fez.

    Devolve "criado", "novos" ou "sem_mudanca".
    """
    atuais = [(identificadores_do_dialog(d), identificador_display(d), d.name) for d in grupos_e_canais]

    if not GRUPOS_PATH.exists():
        linhas = [formatar_linha_grupo(disp, nome) for _ids, disp, nome in atuais]
        GRUPOS_PATH.write_text(CABECALHO_GRUPOS + "\n" + "\n".join(linhas) + "\n", encoding="utf-8")
        return "criado"

    conteudo_atual = GRUPOS_PATH.read_text(encoding="utf-8")
    conhecidos = set()
    for linha in conteudo_atual.splitlines():
        linha_limpa = linha.strip().lstrip("#").strip()
        if not linha_limpa or "|" not in linha_limpa:
            continue
        conhecidos.add(ler_identificador_da_linha(linha_limpa))

    novos = [(ids, disp, nome) for ids, disp, nome in atuais if not (ids & conhecidos)]
    if not novos:
        return "sem_mudanca"

    secao_novos = (
        "\n\n# NOVOS - a conta entrou nesses depois da ultima vez, ainda nao revisados:\n"
        + "\n".join(formatar_linha_grupo(disp, nome) for _ids, disp, nome in novos)
        + "\n"
    )
    with GRUPOS_PATH.open("a", encoding="utf-8") as f:
        f.write(secao_novos)
    return "novos"


def deve_escanear(dialog, selecao):
    if selecao is None:
        return True
    return bool(identificadores_do_dialog(dialog) & selecao)


async def scan_chat(client, conn, entity, limite=None):
    chat_id = entity.id
    chat_title = getattr(entity, "title", None) or getattr(entity, "first_name", None) or str(chat_id)
    chat_username = getattr(entity, "username", None)

    last_id = db.get_last_scanned_message_id(conn, chat_id)
    max_id_seen = last_id
    new_with_reactions = 0
    total_seen = 0
    inicio = time.monotonic()

    print(f"[{chat_title}] iniciando a partir da mensagem {last_id}...")

    async for message in client.iter_messages(entity, min_id=last_id, reverse=True):
        total_seen += 1
        max_id_seen = max(max_id_seen, message.id)

        reactions, total = extract_reactions(message)
        if total > 0:
            db.upsert_message(
                conn,
                chat_id=chat_id,
                message_id=message.id,
                date_utc=message.date.astimezone(timezone.utc).isoformat(),
                text_preview=preview_text(message),
                reaction_total=total,
                reactions=reactions,
                link=build_link(entity, message.id),
            )
            new_with_reactions += 1

        if total_seen % 500 == 0:
            decorridos = time.monotonic() - inicio
            print(f"  [{chat_title}] {total_seen} mensagens verificadas ({decorridos:.0f}s)...")

        if limite is not None and total_seen >= limite:
            print(f"  [{chat_title}] limite de {limite} mensagens atingido nesta rodada, continua na proxima execucao.")
            break

    db.upsert_chat(
        conn,
        chat_id=chat_id,
        chat_title=chat_title,
        chat_username=chat_username,
        last_scanned_message_id=max_id_seen,
        last_scanned_at=datetime.now(timezone.utc).isoformat(),
    )
    conn.commit()

    decorridos = time.monotonic() - inicio
    print(f"[{chat_title}] {total_seen} mensagens novas analisadas, {new_with_reactions} com reacoes salvas ({decorridos:.0f}s).")


async def run_scan(conn, limite_por_chat=None):
    selecao = carregar_selecao()
    client = TelegramClient(str(SESSION_PATH), API_ID, API_HASH)
    await client.start(
        phone=PHONE,
        password=lambda: input("Senha de verificacao em duas etapas (fica visivel ao digitar): "),
    )
    try:
        async for dialog in client.iter_dialogs():
            if not (dialog.is_group or dialog.is_channel):
                continue
            if not deve_escanear(dialog, selecao):
                print(f"[{dialog.name}] fora do escopo (nao esta ativo em grupos_para_escanear.txt).")
                continue
            await scan_chat(client, conn, dialog.entity, limite=limite_por_chat)
    finally:
        await client.disconnect()


def show_top(conn, limit):
    rows = db.top_reactions(conn, min_count=1, limit=limit)
    if not rows:
        print("Nenhuma mensagem com reacao encontrada no banco ainda.")
        return
    table = []
    for date_utc, total, chat_title, preview, link, _reactions_json in rows:
        data_fmt = date_utc[:10]
        table.append([data_fmt, total, chat_title, preview, link or "(sem link - grupo basico)"])
    print(tabulate(table, headers=["Data", "Reacoes", "Grupo", "Mensagem", "Link"], tablefmt="simple"))

    min_date, max_date = db.date_range(conn)
    if min_date and max_date:
        print(f"\nPeriodo coberto no banco: {min_date[:10]} ate {max_date[:10]}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--top", type=int, default=None, help="Escaneia e mostra o top N depois")
    parser.add_argument("--top-only", type=int, default=None, help="So mostra o top N, sem escanear")
    parser.add_argument(
        "--limite-por-chat",
        type=int,
        default=None,
        help="Limita quantas mensagens novas processa por grupo/canal nesta rodada (continua de onde parou na proxima). Bom para um primeiro teste rapido.",
    )
    args = parser.parse_args()

    conn = db.connect(str(DB_PATH))

    if args.top_only is not None:
        show_top(conn, args.top_only)
        return

    asyncio.run(run_scan(conn, limite_por_chat=args.limite_por_chat))

    if args.top is not None:
        show_top(conn, args.top)


if __name__ == "__main__":
    main()
