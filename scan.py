"""Escaneia grupos/canais do Telegram via API oficial (Telethon) e grava as
mensagens com reacoes num banco SQLite local, de forma incremental.

Uso:
    python scan.py                 escaneia todos os chats do config.json
    python scan.py --top 20        escaneia e depois mostra as 20 com mais reacoes
    python scan.py --top-only 20   so mostra o top, sem escanear de novo
"""

import argparse
import asyncio
import json
import os
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
CONFIG_PATH = BASE_DIR / "config.json"


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


async def scan_chat(client, conn, chat_ref):
    entity = await client.get_entity(chat_ref)
    chat_id = entity.id
    chat_title = getattr(entity, "title", None) or getattr(entity, "first_name", None) or str(chat_ref)
    chat_username = getattr(entity, "username", None)

    last_id = db.get_last_scanned_message_id(conn, chat_id)
    max_id_seen = last_id
    new_with_reactions = 0
    total_seen = 0

    async for message in client.iter_messages(entity, min_id=last_id, reverse=True):
        total_seen += 1
        max_id_seen = max(max_id_seen, message.id)

        reactions, total = extract_reactions(message)
        if total <= 0:
            continue

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

    db.upsert_chat(
        conn,
        chat_id=chat_id,
        chat_title=chat_title,
        chat_username=chat_username,
        last_scanned_message_id=max_id_seen,
        last_scanned_at=datetime.now(timezone.utc).isoformat(),
    )
    conn.commit()

    print(f"[{chat_title}] {total_seen} mensagens novas analisadas, {new_with_reactions} com reacoes salvas.")


async def run_scan(conn, chats):
    client = TelegramClient(str(SESSION_PATH), API_ID, API_HASH)
    await client.start(phone=PHONE)
    try:
        for chat_ref in chats:
            await scan_chat(client, conn, chat_ref)
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


def load_chats():
    if not CONFIG_PATH.exists():
        raise SystemExit(
            f"Arquivo nao encontrado: {CONFIG_PATH}\n"
            "Copie config.example.json para config.json e liste seus grupos/canais."
        )
    config = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    return config["chats"]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--top", type=int, default=None, help="Escaneia e mostra o top N depois")
    parser.add_argument("--top-only", type=int, default=None, help="So mostra o top N, sem escanear")
    args = parser.parse_args()

    conn = db.connect(str(DB_PATH))

    if args.top_only is not None:
        show_top(conn, args.top_only)
        return

    chats = load_chats()
    asyncio.run(run_scan(conn, chats))

    if args.top is not None:
        show_top(conn, args.top)


if __name__ == "__main__":
    main()
