"""RAG 管理 — collections CRUD / 文档 ingest (切块→嵌入→入库) / 检索预览。

存储: 复用 Music!!! agent 库的 ChromaStore (本地 SQLite, data/agent_service/rag/)。
嵌入: SentenceTransformerEmbedder (默认 BAAI/bge-m3, HF_HOME 已有缓存) 或 "dummy"
      (哈希假向量, 测试用)。模型按名字进程内缓存单例, 首次用到才加载 (torch 较重)。

同一 collection 用同一 embedder 才有意义 — collection 的 metadata 里记录创建时的
embedder 名, ingest/search 时用它, 避免混用维度/语义空间。
"""

import re
import threading

import chromadb
from chromadb.config import Settings

from .config import DATA_DIR

RAG_DIR = DATA_DIR / "rag"
RAG_DIR.mkdir(parents=True, exist_ok=True)

_NAME_RE = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._-]{1,61}[a-zA-Z0-9]$")  # chroma 命名规则

_embedders: dict = {}
_embedder_lock = threading.Lock()
_client_instance = None


def _client():
    global _client_instance
    if _client_instance is None:
        _client_instance = chromadb.PersistentClient(
            path=str(RAG_DIR),
            settings=Settings(anonymized_telemetry=False),
        )
    return _client_instance


def get_embedder(name: str):
    """按名字取 embedder (进程内缓存)。"dummy" → 哈希假向量; 其余按 HF 模型名加载。"""
    with _embedder_lock:
        if name not in _embedders:
            if name == "dummy":
                from agent.retrieval.embed import DummyEmbedder
                _embedders[name] = DummyEmbedder()
            else:
                from agent.retrieval.embed import SentenceTransformerEmbedder
                _embedders[name] = SentenceTransformerEmbedder(model_name=name)
        return _embedders[name]


def get_store(collection: str):
    """给 factory 用: 返回 agent 库的 ChromaStore (与本模块同一 chroma 目录)。"""
    from agent.retrieval.store import ChromaStore
    return ChromaStore(str(RAG_DIR), collection)


def collection_embedder_name(collection: str, fallback: str) -> str:
    """collection 创建时记录的 embedder 名; 老库没记录则用 fallback。"""
    try:
        meta = _client().get_collection(collection).metadata or {}
        return meta.get("embedder") or fallback
    except Exception:
        return fallback


# ─── collections CRUD ────────────────────────────────────────────────

def list_collections() -> list[dict]:
    out = []
    for col in _client().list_collections():
        c = _client().get_collection(col.name)
        meta = c.metadata or {}
        out.append({
            "name": col.name,
            "count": c.count(),
            "embedder": meta.get("embedder"),
        })
    out.sort(key=lambda x: x["name"])
    return out


def create_collection(name: str, embedder_name: str) -> dict:
    if not _NAME_RE.match(name):
        raise ValueError(
            f"非法 collection 名: {name!r} (3-63 位, 字母数字开头结尾, 可含 . _ -)")
    col = _client().get_or_create_collection(
        name=name,
        metadata={"hnsw:space": "cosine", "embedder": embedder_name},
    )
    return {"name": name, "count": col.count(), "embedder": embedder_name}


def delete_collection(name: str) -> None:
    _client().delete_collection(name)  # 不存在时 chroma 自己抛错


# ─── ingest ──────────────────────────────────────────────────────────

def chunk_text(text: str, max_chars: int = 600, overlap: int = 80) -> list[str]:
    """段落感知切块: 按空行聚段, 超长段落硬切 (带 overlap)。"""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text) if p.strip()]
    chunks: list[str] = []
    buf = ""
    for p in paragraphs:
        if len(p) > max_chars:
            if buf:
                chunks.append(buf)
                buf = ""
            step = max_chars - overlap
            for i in range(0, len(p), step):
                chunks.append(p[i:i + max_chars])
                if i + max_chars >= len(p):
                    break
        elif len(buf) + len(p) + 1 <= max_chars:
            buf = f"{buf}\n{p}" if buf else p
        else:
            chunks.append(buf)
            buf = p
    if buf:
        chunks.append(buf)
    return chunks


def ingest(collection: str, documents: list[dict], default_embedder: str) -> dict:
    """documents: [{source, text}]。同名 source 重灌 = 先删旧块再入新块。"""
    emb_name = collection_embedder_name(collection, default_embedder)
    embedder = get_embedder(emb_name)
    # 确保 collection 存在且记录 embedder
    create_collection(collection, emb_name)
    raw_col = _client().get_collection(collection)
    store = get_store(collection)

    per_source = {}
    for doc in documents:
        source = (doc.get("source") or "untitled").strip()
        text = doc.get("text") or ""
        pieces = chunk_text(text)
        if not pieces:
            per_source[source] = 0
            continue
        try:
            raw_col.delete(where={"source": source})   # 重灌覆盖
        except Exception:
            pass
        vectors = embedder.encode(pieces)
        store.add([
            {
                "id": f"{source}::{i}",
                "text": piece,
                "vector": vectors[i],
                "meta": {"source": source, "chunk": i},
            }
            for i, piece in enumerate(pieces)
        ])
        per_source[source] = len(pieces)

    return {
        "collection": collection,
        "embedder": emb_name,
        "added_chunks": sum(per_source.values()),
        "per_source": per_source,
        "total_count": raw_col.count(),
    }


def search(collection: str, query: str, top_k: int, default_embedder: str) -> list[dict]:
    emb_name = collection_embedder_name(collection, default_embedder)
    embedder = get_embedder(emb_name)
    return get_store(collection).search(embedder.encode(query), top_k=top_k)
