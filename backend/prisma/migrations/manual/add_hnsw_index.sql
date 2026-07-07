-- HNSW 向量索引（pgvector 0.5+ 支持）
-- m = 16: 每个节点的最大连接数
-- ef_construction = 200: 构建时的搜索深度

CREATE INDEX IF NOT EXISTS "ChunkEmbedding_embedding_hnsw_idx"
  ON "ChunkEmbedding"
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 200);

-- 查询时设置 ef_search 参数（在搜索服务中动态设置）:
-- SET LOCAL hnsw.ef_search = 100;
