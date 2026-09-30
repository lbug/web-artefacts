-- Full-text index over each artifact's title and the visible text of its
-- latest version. The trigram tokenizer also matches parts of words, which
-- German compounds need ("filter" finds "Projektfilter").
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(id UNINDEXED, title, body, tokenize = 'trigram remove_diacritics 1');
