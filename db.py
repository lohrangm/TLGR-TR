"""Camada de acesso ao banco SQLite do scanner de reacoes do Telegram."""

import json
import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS chats (
    chat_id INTEGER PRIMARY KEY,
    chat_title TEXT,
    chat_username TEXT,
    last_scanned_message_id INTEGER NOT NULL DEFAULT 0,
    last_scanned_at TEXT
);

CREATE TABLE IF NOT EXISTS messages (
    chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    date_utc TEXT NOT NULL,
    text_preview TEXT,
    reaction_total INTEGER NOT NULL DEFAULT 0,
    reactions_json TEXT,
    link TEXT,
    PRIMARY KEY (chat_id, message_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_reaction_total ON messages (reaction_total DESC);
"""


def connect(db_path):
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.executescript(SCHEMA)
    return conn


def get_last_scanned_message_id(conn, chat_id):
    row = conn.execute(
        "SELECT last_scanned_message_id FROM chats WHERE chat_id = ?",
        (chat_id,),
    ).fetchone()
    return row[0] if row else 0


def upsert_chat(conn, chat_id, chat_title, chat_username, last_scanned_message_id, last_scanned_at):
    conn.execute(
        """
        INSERT INTO chats (chat_id, chat_title, chat_username, last_scanned_message_id, last_scanned_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(chat_id) DO UPDATE SET
            chat_title = excluded.chat_title,
            chat_username = excluded.chat_username,
            last_scanned_message_id = excluded.last_scanned_message_id,
            last_scanned_at = excluded.last_scanned_at
        """,
        (chat_id, chat_title, chat_username, last_scanned_message_id, last_scanned_at),
    )


def upsert_message(conn, chat_id, message_id, date_utc, text_preview, reaction_total, reactions, link):
    conn.execute(
        """
        INSERT INTO messages (chat_id, message_id, date_utc, text_preview, reaction_total, reactions_json, link)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(chat_id, message_id) DO UPDATE SET
            date_utc = excluded.date_utc,
            text_preview = excluded.text_preview,
            reaction_total = excluded.reaction_total,
            reactions_json = excluded.reactions_json,
            link = excluded.link
        """,
        (chat_id, message_id, date_utc, text_preview, reaction_total, json.dumps(reactions, ensure_ascii=False), link),
    )


def top_reactions(conn, min_count=1, chat_id=None, limit=50):
    query = """
        SELECT m.date_utc, m.reaction_total, COALESCE(c.chat_title, m.chat_id) AS chat_title,
               m.text_preview, m.link, m.reactions_json
        FROM messages m
        LEFT JOIN chats c ON c.chat_id = m.chat_id
        WHERE m.reaction_total >= ?
    """
    params = [min_count]
    if chat_id is not None:
        query += " AND m.chat_id = ?"
        params.append(chat_id)
    query += " ORDER BY m.reaction_total DESC LIMIT ?"
    params.append(limit)
    return conn.execute(query, params).fetchall()


def date_range(conn, chat_id=None):
    query = "SELECT MIN(date_utc), MAX(date_utc) FROM messages"
    params = []
    if chat_id is not None:
        query += " WHERE chat_id = ?"
        params.append(chat_id)
    return conn.execute(query, params).fetchone()
