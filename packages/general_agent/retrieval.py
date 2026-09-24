"""可插拔检索：默认本地确定性向量，配了 embedding 服务就走真向量。

为什么默认不用模型：这个项目要求"不需要密钥也能跑完整链路"。所以默认走
`HashingEmbedding`（词哈希 + 词频 + L2 归一，零依赖、零下载、结果确定、可测试）。
配置了 embedding 服务时自动切到 `ApiEmbedding`，失败再退回本地 —— 检索方式
会如实写进任务的 `knowledge.mode`，不会把关键词检索说成向量检索。
"""

from __future__ import annotations

import hashlib
import math
import re
from collections import Counter
from dataclasses import dataclass
from typing import Protocol

import httpx

DEFAULT_DIM = 1024
# 哈希向量对任意两段文本都会给出非零余弦，所以必须设下限：
# 否则"完全不相关"也会被算成命中，命中明细就失去意义。低于阈值就走关键词回退。
MIN_SCORE = 0.10


def terms(text: str) -> set[str]:
    """检索用词：ASCII 词原样，中文切二元组。

    踩过坑：用 `[\\w\\u4e00-\\u9fff]{2,}` 抓"连续中文串"会让整句变成一个词，
    在文档里永远匹配不到 —— 中文知识库等于检索不到。没有分词器时二元组最实用。
    """
    found: set[str] = set()
    for chunk in re.findall(r"[A-Za-z0-9_]+|[\u4e00-\u9fff]+", text):
        if chunk[0].isascii():
            found.add(chunk.lower())
        elif len(chunk) > 1:
            found.update(chunk[index : index + 2] for index in range(len(chunk) - 1))
    return found


def chunk_text(text: str, size: int = 800, overlap: int = 120) -> list[str]:
    """按字符分块。中文没有空格，按字符切比按词切更稳；overlap 防止切断语义。"""
    if size <= 0:
        return [text]
    step = max(size - overlap, 1)
    if len(text) <= size:
        return [text]
    return [text[start : start + size] for start in range(0, len(text), step)]


def cosine(left: list[float], right: list[float]) -> float:
    if len(left) != len(right):
        return 0.0
    return math.fsum(a * b for a, b in zip(left, right, strict=False))


class EmbeddingProvider(Protocol):
    name: str

    def embed(self, texts: list[str]) -> list[list[float]]: ...


class HashingEmbedding:
    """确定性本地向量：词哈希进桶 + 词频加权 + L2 归一。"""

    name = "hashing-local"

    def __init__(self, dim: int = DEFAULT_DIM) -> None:
        self.dim = dim

    def embed(self, texts: list[str]) -> list[list[float]]:
        """签名哈希（signed hashing trick）：

        同一词的符号固定，因此真实重合的词项贡献正向内积；不同词偶然撞到同一桶时
        符号随机、正负相消，期望为 0。少了这一步，碰撞噪声会让"完全不相关"的分数
        反而高于"真的相关"（实测踩过）。
        """
        vectors: list[list[float]] = []
        for text in texts:
            counts = Counter(terms(text))
            vector = [0.0] * self.dim
            for term, count in counts.items():
                digest = int(hashlib.blake2b(term.encode("utf-8"), digest_size=8).hexdigest(), 16)
                weight = 1.0 + math.log(count)
                sign = 1.0 if digest & 1 else -1.0
                vector[digest % self.dim] += sign * weight
            norm = math.sqrt(math.fsum(value * value for value in vector))
            if norm:
                vector = [value / norm for value in vector]
            vectors.append(vector)
        return vectors


class ApiEmbedding:
    """OpenAI 兼容的 /embeddings 接口。没有密钥就别构造它。"""

    name = "api-embedding"

    def __init__(
        self,
        api_key: str,
        model: str,
        base_url: str = "https://api.openai.com/v1",
        timeout_seconds: float = 20.0,
    ) -> None:
        self._api_key = api_key
        self._model = model
        self._base_url = base_url.rstrip("/")
        self._timeout = timeout_seconds

    def embed(self, texts: list[str]) -> list[list[float]]:
        response = httpx.post(
            f"{self._base_url}/embeddings",
            headers={"Authorization": f"Bearer {self._api_key}"},
            json={"model": self._model, "input": texts},
            timeout=self._timeout,
        )
        response.raise_for_status()
        payload = response.json()
        data = payload.get("data")
        if not isinstance(data, list) or len(data) != len(texts):
            raise ValueError("embedding 服务返回的向量数量与输入不一致")
        vectors: list[list[float]] = []
        for item in data:
            vector = item.get("embedding") if isinstance(item, dict) else None
            if not isinstance(vector, list) or not vector:
                raise ValueError("embedding 服务返回的向量为空")
            values = [float(value) for value in vector]
            norm = math.sqrt(math.fsum(value * value for value in values))
            vectors.append([value / norm for value in values] if norm else values)
        return vectors


class FallbackEmbedding:
    """远程优先、失败回退。回退原因要留痕，否则"用了什么"说不清。"""

    def __init__(self, primary: EmbeddingProvider, fallback: EmbeddingProvider) -> None:
        self.primary = primary
        self.fallback = fallback
        self.name = primary.name
        self.last_reason = ""

    def embed(self, texts: list[str]) -> list[list[float]]:
        try:
            return self.primary.embed(texts)
        except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
            self.last_reason = type(exc).__name__
            self.name = f"{self.fallback.name}（{self.last_reason} 后回退）"
            return self.fallback.embed(texts)


@dataclass(frozen=True)
class Hit:
    base: str
    name: str
    score: float
    snippet: str


def keyword_rank(
    query: str,
    documents: list[tuple[str, str, str]],
    top_k: int = 3,
) -> list[Hit]:
    """关键词计分：向量检索不可用或没有正分命中时的回退路径。"""
    wanted = terms(query)
    if not wanted:
        return []
    ranked: list[tuple[int, str, str, str]] = []
    for base_name, doc_name, content in documents:
        lowered = content.lower()
        score = sum(lowered.count(term) for term in wanted)
        if score:
            ranked.append((score, doc_name, content, base_name))
    ranked.sort(reverse=True)
    return [
        Hit(base=base_name, name=doc_name, score=float(score), snippet=content[:400])
        for score, doc_name, content, base_name in ranked[:top_k]
    ]


class VectorIndex:
    """对知识库文档做向量检索。向量按内容缓存，重复检索不用重算。"""

    def __init__(self, embedder: EmbeddingProvider) -> None:
        self.embedder = embedder
        self._cache: dict[str, list[float]] = {}

    def search(
        self,
        query: str,
        documents: list[tuple[str, str, str]],
        top_k: int = 3,
        chunk_size: int = 800,
        overlap: int = 120,
    ) -> list[Hit]:
        """documents: [(base_name, doc_name, content)]。返回按相关性降序的命中。"""
        if not query.strip() or not documents:
            return []
        chunks: list[tuple[str, str, str]] = []
        for base_name, doc_name, content in documents:
            for piece in chunk_text(content, chunk_size, overlap):
                if piece.strip():
                    chunks.append((base_name, doc_name, piece))
        if not chunks:
            return []
        vectors = self._embed([piece for _, _, piece in chunks])
        query_vectors = self.embedder.embed([query])
        if not query_vectors or not vectors:
            return []
        query_vector = query_vectors[0]
        best: dict[tuple[str, str], tuple[float, str]] = {}
        for (base_name, doc_name, piece), vector in zip(chunks, vectors, strict=False):
            score = cosine(query_vector, vector)
            if score < MIN_SCORE:
                continue
            key = (base_name, doc_name)
            if key not in best or score > best[key][0]:
                best[key] = (score, piece)
        ranked = sorted(best.items(), key=lambda item: item[1][0], reverse=True)
        return [
            Hit(base=base, name=name, score=round(score, 4), snippet=snippet[:400])
            for (base, name), (score, snippet) in ranked[:top_k]
        ]

    def _embed(self, texts: list[str]) -> list[list[float]]:
        """带缓存的嵌入：文档内容不变就不重算。"""
        pending: list[tuple[int, str]] = []
        results: list[list[float] | None] = []
        for index, text in enumerate(texts):
            key = hashlib.blake2b(text.encode("utf-8"), digest_size=8).hexdigest()
            cached = self._cache.get(key)
            if cached is not None:
                results.append(cached)
            else:
                results.append(None)
                pending.append((index, text))
        if pending:
            vectors = self.embedder.embed([text for _, text in pending])
            for (index, _), vector in zip(pending, vectors, strict=False):
                key = hashlib.blake2b(texts[index].encode("utf-8"), digest_size=8).hexdigest()
                self._cache[key] = vector
                results[index] = vector
        return [vector for vector in results if vector is not None]
