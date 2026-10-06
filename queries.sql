-- Top 20 mensagens com mais reacoes, de todos os chats escaneados
SELECT
    m.date_utc,
    m.reaction_total,
    COALESCE(c.chat_title, CAST(m.chat_id AS TEXT)) AS chat_title,
    m.text_preview,
    m.link
FROM messages m
LEFT JOIN chats c ON c.chat_id = m.chat_id
ORDER BY m.reaction_total DESC
LIMIT 20;

-- Top 20 reacoes de um chat especifico (troca o chat_id pelo que te interessa)
SELECT
    m.date_utc,
    m.reaction_total,
    m.text_preview,
    m.link
FROM messages m
WHERE m.chat_id = -1001234567890
ORDER BY m.reaction_total DESC
LIMIT 20;

-- Periodo coberto pelo scan, por chat
SELECT
    COALESCE(c.chat_title, CAST(m.chat_id AS TEXT)) AS chat_title,
    MIN(m.date_utc) AS primeira_mensagem,
    MAX(m.date_utc) AS ultima_mensagem,
    COUNT(*) AS mensagens_com_reacao
FROM messages m
LEFT JOIN chats c ON c.chat_id = m.chat_id
GROUP BY m.chat_id
ORDER BY ultima_mensagem DESC;

-- Soma de reacoes por tipo de emoji
SELECT
    json_extract(je.value, '$.emoji') AS emoji,
    SUM(json_extract(je.value, '$.count')) AS total
FROM messages m, json_each(m.reactions_json) je
GROUP BY emoji
ORDER BY total DESC;
