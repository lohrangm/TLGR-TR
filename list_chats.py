"""Lista todos os grupos, canais e conversas que sua conta do Telegram
participa, com o identificador certo para colar no config.json.

Essa e a primeira coisa a rodar no projeto: ela tambem faz o login (pede o
codigo que chega no seu Telegram, e a senha de duas etapas se voce tiver uma).

Uso:
    python list_chats.py
"""

import asyncio
import os
from pathlib import Path

from dotenv import load_dotenv
from telethon import TelegramClient

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

API_ID = int(os.environ["TELEGRAM_API_ID"])
API_HASH = os.environ["TELEGRAM_API_HASH"]
PHONE = os.environ.get("TELEGRAM_PHONE") or None

SESSION_PATH = BASE_DIR / "data" / "session"


async def main():
    client = TelegramClient(str(SESSION_PATH), API_ID, API_HASH)
    await client.start(phone=PHONE)
    try:
        print(f"{'Tipo':12} {'Identificador para o config.json':35} Nome")
        print("-" * 90)
        async for dialog in client.iter_dialogs():
            username = getattr(dialog.entity, "username", None)
            identifier = f"@{username}" if username else str(dialog.id)

            if dialog.is_channel:
                tipo = "canal/grupo"
            elif dialog.is_group:
                tipo = "grupo"
            elif dialog.is_user:
                tipo = "pessoa"
            else:
                tipo = "outro"

            print(f"{tipo:12} {identifier:35} {dialog.name}")
    finally:
        await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
