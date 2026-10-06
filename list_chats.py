"""Lista todos os grupos, canais e conversas que sua conta do Telegram
participa, mostrando quais serao escaneados por padrao e quais estao na
lista de exclusao (config.json). So precisa editar config.json se quiser
excluir algum grupo/canal especifico - por padrao o scan.py ja pega tudo.

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

from scan import is_ignored, load_ignore_set

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

API_ID = int(os.environ["TELEGRAM_API_ID"])
API_HASH = os.environ["TELEGRAM_API_HASH"]
PHONE = os.environ.get("TELEGRAM_PHONE") or None

SESSION_PATH = BASE_DIR / "data" / "session"


async def main():
    ignore_set = load_ignore_set()
    client = TelegramClient(str(SESSION_PATH), API_ID, API_HASH)
    await client.start(
        phone=PHONE,
        password=lambda: input("Senha de verificacao em duas etapas (fica visivel ao digitar): "),
    )
    try:
        print(f"{'Tipo':12} {'Identificador':35} {'Status':15} Nome")
        print("-" * 100)
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

            if tipo == "pessoa":
                status = "nao escaneado"
            elif is_ignored(dialog, ignore_set):
                status = "ignorado"
            else:
                status = "sera escaneado"

            print(f"{tipo:12} {identifier:35} {status:15} {dialog.name}")
    finally:
        await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
