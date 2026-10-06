"""Lista todos os grupos, canais e conversas que sua conta do Telegram
participa, e cria/atualiza o arquivo grupos_para_escanear.txt com todos
eles.

Essa e a primeira coisa a rodar no projeto: ela tambem faz o login (pede o
codigo que chega no seu Telegram, e a senha de duas etapas se voce tiver uma).

Para escolher quais grupos entram no scan: abra grupos_para_escanear.txt
(ex: notepad grupos_para_escanear.txt) e apague as linhas dos que voce NAO
quer escanear. So isso - nao precisa saber identificador de nada, o arquivo
ja vem com o nome de cada grupo.

Uso:
    python list_chats.py
"""

import asyncio
import os
from pathlib import Path

from dotenv import load_dotenv
from telethon import TelegramClient

from scan import GRUPOS_PATH, atualizar_arquivo_grupos, carregar_selecao, deve_escanear, identificador_display

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

API_ID = int(os.environ["TELEGRAM_API_ID"])
API_HASH = os.environ["TELEGRAM_API_HASH"]
PHONE = os.environ.get("TELEGRAM_PHONE") or None

SESSION_PATH = BASE_DIR / "data" / "session"


async def main():
    client = TelegramClient(str(SESSION_PATH), API_ID, API_HASH)
    await client.start(
        phone=PHONE,
        password=lambda: input("Senha de verificacao em duas etapas (fica visivel ao digitar): "),
    )
    try:
        dialogs = [dialog async for dialog in client.iter_dialogs()]
        grupos_e_canais = [d for d in dialogs if d.is_group or d.is_channel]

        resultado = atualizar_arquivo_grupos(grupos_e_canais)
        selecao = carregar_selecao()

        print(f"{'Tipo':12} {'Identificador':35} {'Status':15} Nome")
        print("-" * 100)
        for dialog in dialogs:
            if dialog.is_channel:
                tipo = "canal/grupo"
            elif dialog.is_group:
                tipo = "grupo"
            elif dialog.is_user:
                tipo = "pessoa"
            else:
                tipo = "outro"

            if tipo in ("pessoa", "outro"):
                status = "nao escaneado"
            elif deve_escanear(dialog, selecao):
                status = "sera escaneado"
            else:
                status = "fora do escopo"

            print(f"{tipo:12} {identificador_display(dialog):35} {status:15} {dialog.name}")

        print()
        if resultado == "criado":
            print(
                f"Arquivo {GRUPOS_PATH.name} criado com todos os grupos/canais (todos ativos por padrao).\n"
                f"Abra ele (ex: notepad {GRUPOS_PATH.name}) e apague as linhas dos que voce NAO quer escanear."
            )
        elif resultado == "novos":
            print(
                f"Grupos novos foram adicionados no final de {GRUPOS_PATH.name}, numa secao 'NOVOS'.\n"
                f"Abra ele e revise antes do proximo scan."
            )
        else:
            print(f"Nenhum grupo novo desde a ultima vez - {GRUPOS_PATH.name} continua do jeito que voce deixou.")
    finally:
        await client.disconnect()


if __name__ == "__main__":
    asyncio.run(main())
