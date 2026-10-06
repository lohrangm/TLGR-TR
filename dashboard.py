"""Dashboard web local para consultar o banco de reacoes.

Sobe um servidor local (so acessivel no seu computador, ninguem de fora
alcanca) que le direto do data/reacoes.db e mostra uma tabela com filtro de
grupo e minimo de reacoes, com link clicavel pra cada mensagem. Abre sozinho
no seu navegador padrao.

Uso:
    python dashboard.py
    python dashboard.py --porta 8765

Pra parar, Ctrl+C no terminal (o navegador continua aberto, so para de
atualizar).
"""

import argparse
import json
import sqlite3
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "data" / "reacoes.db"
HTML_PATH = BASE_DIR / "dashboard.html"


def conectar():
    conn = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def listar_grupos(conn):
    rows = conn.execute(
        """
        SELECT c.chat_id, COALESCE(c.chat_title, CAST(c.chat_id AS TEXT)) AS chat_title, COUNT(m.message_id) AS total
        FROM chats c
        LEFT JOIN messages m ON m.chat_id = c.chat_id
        GROUP BY c.chat_id
        HAVING total > 0
        ORDER BY chat_title COLLATE NOCASE
        """
    ).fetchall()
    return [{"chat_id": r["chat_id"], "chat_title": r["chat_title"], "total": r["total"]} for r in rows]


def link_para_preview(link):
    """Converte um link t.me normal para a versao de preview publico (/s/),
    que abre direto como pagina no navegador em vez de tentar chamar o app
    do Telegram (protocolo tg://). So existe para chats publicos - links de
    canal privado (/c/) nao tem equivalente e continuam como estao."""
    if not link:
        return link
    prefixo = "https://t.me/"
    if not link.startswith(prefixo):
        return link
    resto = link[len(prefixo):]
    if resto.startswith("c/"):
        return link
    return f"{prefixo}s/{resto}"


def buscar_top(conn, minimo, chat_id, limite):
    sql = """
        SELECT m.date_utc, m.reaction_total, COALESCE(c.chat_title, CAST(m.chat_id AS TEXT)) AS chat_title,
               m.text_preview, m.link
        FROM messages m
        LEFT JOIN chats c ON c.chat_id = m.chat_id
        WHERE m.reaction_total >= ?
    """
    params = [minimo]
    if chat_id is not None:
        sql += " AND m.chat_id = ?"
        params.append(chat_id)
    sql += " ORDER BY m.reaction_total DESC LIMIT ?"
    params.append(limite)

    rows = conn.execute(sql, params).fetchall()
    return [
        {
            "data": r["date_utc"][:10],
            "reacoes": r["reaction_total"],
            "grupo": r["chat_title"],
            "mensagem": r["text_preview"],
            "link": link_para_preview(r["link"]),
        }
        for r in rows
    ]


def buscar_periodo(conn, chat_id):
    sql = "SELECT MIN(date_utc), MAX(date_utc) FROM messages"
    params = []
    if chat_id is not None:
        sql += " WHERE chat_id = ?"
        params.append(chat_id)
    row = conn.execute(sql, params).fetchone()
    return {"inicio": row[0][:10] if row[0] else None, "fim": row[1][:10] if row[1] else None}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # silencia o log padrao do http.server no terminal

    def _responder_json(self, payload):
        corpo = json.dumps(payload).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(corpo)))
        self.end_headers()
        self.wfile.write(corpo)

    def _responder_html(self):
        corpo = HTML_PATH.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(corpo)))
        self.end_headers()
        self.wfile.write(corpo)

    def do_GET(self):
        url = urlparse(self.path)
        query = parse_qs(url.query)
        conn = conectar()
        try:
            if url.path in ("/", "/dashboard.html"):
                self._responder_html()
            elif url.path == "/api/grupos":
                self._responder_json(listar_grupos(conn))
            elif url.path == "/api/top":
                minimo = int(query.get("min", ["1"])[0] or 1)
                chat_id_raw = query.get("chat_id", [""])[0]
                chat_id = int(chat_id_raw) if chat_id_raw else None
                limite = int(query.get("limite", ["100"])[0] or 100)
                self._responder_json(
                    {
                        "mensagens": buscar_top(conn, minimo, chat_id, limite),
                        "periodo": buscar_periodo(conn, chat_id),
                    }
                )
            else:
                self.send_response(404)
                self.end_headers()
        finally:
            conn.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--porta", type=int, default=8765, help="Porta do servidor local (padrao 8765)")
    args = parser.parse_args()

    if not DB_PATH.exists():
        print(f"Banco nao encontrado em {DB_PATH}. Rode o scan.py pelo menos uma vez antes.")
        return

    servidor = ThreadingHTTPServer(("127.0.0.1", args.porta), Handler)
    url = f"http://127.0.0.1:{args.porta}/"
    print(f"Dashboard rodando em {url} (Ctrl+C pra parar)")
    webbrowser.open(url)
    try:
        servidor.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        servidor.server_close()


if __name__ == "__main__":
    main()
