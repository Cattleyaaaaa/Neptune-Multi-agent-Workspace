from copy import deepcopy
from dataclasses import dataclass, field

from apps.api.skills import SkillStore
from apps.api.task_store import TaskStore
from packages.contracts.models import WorkspaceConfig
from packages.general_agent.capabilities import CapabilityRegistry
from packages.general_agent.retrieval import (
    EmbeddingProvider,
    HashingEmbedding,
    Hit,
    VectorIndex,
    keyword_rank,
    terms,
)
from packages.general_agent.tools import ToolRegistry

# 技能正文注入上限：提示词预算有限，技能再长也只能取开头。
SKILL_INJECT_LIMIT = 2_000

# 旧名字保留：二元组分词的入口搬到了 retrieval.terms，这里只是别名。
retrieval_terms = terms


def _first_int(
    bases: list[tuple[str, dict[str, object]]], key: str, default: int
) -> int:
    """取知识库配置里的分块参数；取不到就用默认值。"""
    for _, base in bases:
        value = base.get(key)
        if isinstance(value, (int, float)):
            return int(value)
    return default


@dataclass(frozen=True)
class ManagedContext:
    """工作区注入给任务的内容 + 「这次到底检索到了什么」的明细。

    明细不是装饰：任务详情页要如实告诉用户命中了哪几篇知识库文档，
    没命中时也要能说清是"知识库为空"还是"关键词没匹配上"。
    """

    text: str
    knowledge: dict[str, object] = field(default_factory=dict)
    skills: list[str] = field(default_factory=list)


def _merge_by_id(default_items: list[dict], saved_items: list[dict]) -> list[dict]:
    """按 id 合并配置项：保存过的覆盖同 id 项，注册表里新出现的能力沿用默认值。

    之前是整段覆盖，于是"注册表新增一个 Agent"对已经保存过配置的工作区**完全不可见**
    —— 新能力上线后老环境静默用不上（实测：direct_agent 加进来后计划直接是空的）。
    """
    saved_by_id = {
        str(item.get("id")): item for item in saved_items if isinstance(item, dict)
    }
    merged: list[dict] = []
    seen: set[str] = set()
    for item in default_items:
        item_id = str(item.get("id"))
        seen.add(item_id)
        merged.append({**item, **saved_by_id.get(item_id, {})})
    # 配置里存在、默认列表里没有的项（历史遗留）照旧保留，不做静默删除
    for item in saved_items:
        if isinstance(item, dict) and str(item.get("id")) not in seen:
            merged.append(item)
    return merged


def default_workspace(registry: CapabilityRegistry, tools: ToolRegistry) -> dict[str, object]:
    descriptions = {
        "research_agent": "检索、来源整理与事实核验",
        "data_agent": "表格分析、指标计算与数据质量检查",
        "code_agent": "代码库盘点、实现方案与测试设计",
        "document_agent": "把专业产物编排为可交付文档",
        "review_agent": "独立检查完整性和交付质量",
    }
    agents = [
        {
            "id": item["agent"],
            "name": item["title"],
            "enabled": True,
            "mode": "automatic",
            "description": descriptions.get(str(item["agent"]), "专业任务处理"),
            "task_types": item["task_types"],
        }
        for item in registry.definitions()
    ]
    agents.insert(
        0,
        {
            "id": "supervisor_agent",
            "name": "Supervisor",
            "enabled": True,
            "mode": "required",
            "description": "规划路由、Agent 交接与停止判断",
            "task_types": ["all"],
        },
    )
    return {
        "agents": agents,
        "knowledge_bases": [
            {
                "id": "kb-general",
                "name": "通用知识库",
                "description": "项目规范、产品资料和常用参考",
                "enabled": True,
                "documents": [],
                "embedding_model": "text-embedding-3-small",
                "chunk_size": 800,
                "overlap": 120,
            }
        ],
        "contexts": [
            {
                "id": "ctx-default",
                "name": "默认任务上下文",
                "scope": "workspace",
                "enabled": True,
                "budget": 12000,
                "content": "优先使用可核验信息；明确标注假设、限制和待审批动作。",
            }
        ],
        "model_routes": [
            {
                "id": "route-primary",
                "name": "主推理",
                "provider": "runtime",
                "model": "环境配置",
                "enabled": True,
            },
            {
                "id": "route-fallback",
                "name": "本地回退",
                "provider": "local",
                "model": "structured-rules",
                "enabled": True,
            },
        ],
        "policies": {
            "approval_for_high_risk": True,
            "tool_audit": True,
            "block_private_networks": True,
            "max_steps": 12,
            "timeout_seconds": 45,
        },
        "tools": tools.definitions(),
    }


class WorkspaceService:
    def __init__(
        self,
        store: TaskStore,
        defaults: dict[str, object],
        registry: CapabilityRegistry,
        skill_store: SkillStore | None = None,
        embedder: EmbeddingProvider | None = None,
    ) -> None:
        self.store = store
        self.defaults = defaults
        self.registry = registry
        self.skill_store = skill_store
        # 检索默认就是向量检索：本地确定性向量零依赖，没传 embedder 也照用。
        self._index = VectorIndex(embedder or HashingEmbedding())

    def get(self) -> WorkspaceConfig:
        saved = self.store.load_workspace()
        payload = {**deepcopy(self.defaults), **(saved or {})}
        # agents / knowledge_bases 是按 id 合并而不是整段覆盖：否则新加入的 Agent 在
        # 保存过配置的工作区里永远不会出现。
        for key in ("agents", "knowledge_bases"):
            default_items = [
                item for item in (self.defaults.get(key) or []) if isinstance(item, dict)
            ]
            saved_items = [
                item for item in ((saved or {}).get(key) or []) if isinstance(item, dict)
            ]
            if default_items and saved_items:
                payload[key] = _merge_by_id(default_items, saved_items)
        config = WorkspaceConfig.model_validate(payload)
        self._apply(config)
        return config

    def save(self, config: WorkspaceConfig) -> WorkspaceConfig:
        payload = config.model_dump()
        self.store.save_workspace(payload)
        self._apply(config)
        return config

    def reset(self) -> WorkspaceConfig:
        config = WorkspaceConfig.model_validate(deepcopy(self.defaults))
        self.store.save_workspace(config.model_dump())
        self._apply(config)
        return config

    def managed_context(self, objective: str, use_knowledge_base: bool = True) -> ManagedContext:
        """组装任务上下文，并按需做一次知识库检索。

        检索默认是**向量检索**：本地确定性向量，配了 embedding 服务就走真向量。
        向量侧拿不到任何正分命中时回退关键词计分；用哪种、命中了什么、相似度多少
        都写进 `knowledge`，界面据此如实说明，不把关键词检索说成向量检索。
        """
        config = self.get()
        blocks = [
            str(item.get("content", ""))
            for item in config.contexts
            if item.get("enabled") and item.get("scope") == "workspace"
        ]

        enabled_bases = [
            (str(base.get("name") or base.get("id")), base)
            for base in config.knowledge_bases
            if base.get("enabled")
        ]

        # 启用中的技能也要真的进上下文，否则"启用"就只是界面上的开关。
        applied: list[str] = []
        if self.skill_store is not None:
            for skill in self.skill_store.enabled():
                name = str(skill.get("name") or "技能")
                body = str(skill.get("content") or "").strip()
                if not body:
                    continue
                blocks.append(f"[技能：{name}]\n{body[:SKILL_INJECT_LIMIT]}")
                applied.append(name)

        corpus: list[tuple[str, str, str]] = []
        contents: dict[tuple[str, str], str] = {}
        for base_name, base in enabled_bases:
            for document in base.get("documents", []):
                if not isinstance(document, dict):
                    continue
                name = str(document.get("name", "知识文档"))
                content = str(document.get("content", ""))
                corpus.append((base_name, name, content))
                contents[(base_name, name)] = content

        hits: list[dict[str, object]] = []
        mode = "vector" if self._index is not None else "keyword"
        embedding_name = self._index.embedder.name if self._index else "关键词计分"
        scanned = 0

        if use_knowledge_base and corpus:
            scanned = len(corpus)
            results: list[Hit] = []
            if self._index is not None:
                results = self._index.search(
                    objective,
                    corpus,
                    top_k=3,
                    chunk_size=_first_int(enabled_bases, "chunk_size", 800),
                    overlap=_first_int(enabled_bases, "overlap", 120),
                )
            if results:
                for hit in results:
                    blocks.append(
                        f"[知识库：{hit.base}]\n{contents.get((hit.base, hit.name), '')[:4000]}"
                    )
                    hits.append({"base": hit.base, "name": hit.name, "score": hit.score})
            else:
                # 向量没有正分命中：退回关键词，并把退回如实写进 mode。
                mode = "keyword"
                embedding_name = (
                    f"{self._index.embedder.name} → 关键词回退"
                    if self._index
                    else "关键词计分"
                )
                for hit in keyword_rank(objective, corpus):
                    blocks.append(
                        f"[知识库：{hit.base}]\n{contents.get((hit.base, hit.name), '')[:4000]}"
                    )
                    hits.append({"base": hit.base, "name": hit.name, "score": hit.score})

        return ManagedContext(
            text="\n\n".join(block for block in blocks if block),
            knowledge={
                "enabled": use_knowledge_base,
                "bases": [name for name, _ in enabled_bases],
                "available": len(corpus),
                "scanned": scanned,
                "documents": hits,
                "mode": mode,
                "embedding": embedding_name,
            },
            skills=applied,
        )

    def runtime_policies(self) -> dict[str, object]:
        return self.get().policies

    def _apply(self, config: WorkspaceConfig) -> None:
        configured = {
            str(item.get("id")): item for item in config.agents if isinstance(item, dict)
        }
        # 注册表里已有但配置没提到的能力默认启用：新增 Agent 不该因为"配置里没有这一项"
        # 就被悄悄禁用掉。
        enabled = {
            str(item["agent"])
            for item in self.registry.definitions()
            if configured.get(str(item["agent"]), {}).get("enabled", True)
        }
        self.registry.set_enabled(enabled)
