import re
from copy import deepcopy
from dataclasses import dataclass, field

from apps.api.skills import SkillStore
from apps.api.task_store import TaskStore
from packages.contracts.models import WorkspaceConfig
from packages.general_agent.capabilities import CapabilityRegistry
from packages.general_agent.tools import ToolRegistry

# 技能正文注入上限：提示词预算有限，技能再长也只能取开头。
SKILL_INJECT_LIMIT = 2_000


@dataclass(frozen=True)
class ManagedContext:
    """工作区注入给任务的内容 + 「这次到底检索到了什么」的明细。

    明细不是装饰：任务详情页要如实告诉用户命中了哪几篇知识库文档，
    没命中时也要能说清是"知识库为空"还是"关键词没匹配上"。
    """

    text: str
    knowledge: dict[str, object] = field(default_factory=dict)
    skills: list[str] = field(default_factory=list)


def retrieval_terms(text: str) -> set[str]:
    """检索用词：ASCII 词原样，中文切**二元组**。

    这里踩过坑：原来用 `[\\w\\u4e00-\\u9fff]{2,}` 直接抓"连续中文串"，
    结果一整句中文变成一个有 10 多个字的"词"，在文档里当然找不到 ——
    中文知识库等于永远检索不到。没有分词器时，二元组是最实用的替代。
    """
    terms: set[str] = set()
    for chunk in re.findall(r"[A-Za-z0-9_]+|[\u4e00-\u9fff]+", text):
        if chunk[0].isascii():
            terms.add(chunk.lower())
        elif len(chunk) > 1:
            terms.update(chunk[index:index + 2] for index in range(len(chunk) - 1))
    return terms


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
    ) -> None:
        self.store = store
        self.defaults = defaults
        self.registry = registry
        self.skill_store = skill_store

    def get(self) -> WorkspaceConfig:
        saved = self.store.load_workspace()
        payload = {**deepcopy(self.defaults), **(saved or {})}
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

        检索是关键词计分（不是向量检索）：用目标里的词（中文按二元组切）去知识库
        文档里数命中次数，取前 3 篇注入。所以界面必须把"命中了什么"回报出来，
        否则用户无法判断这次回答到底有没有用上知识库。
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
        available = sum(
            len([doc for doc in base.get("documents", []) if isinstance(doc, dict)])
            for _, base in enabled_bases
        )
        hits: list[dict[str, object]] = []

        if use_knowledge_base:
            terms = retrieval_terms(objective)
            ranked: list[tuple[int, str, str, str]] = []
            for base_name, base in enabled_bases:
                for document in base.get("documents", []):
                    if not isinstance(document, dict):
                        continue
                    content = str(document.get("content", ""))
                    lowered = content.lower()
                    score = sum(lowered.count(term) for term in terms)
                    if score:
                        title = str(document.get("name", "知识文档"))
                        ranked.append((score, title, content, base_name))
            ranked.sort(reverse=True)
            for _, name, content, base_name in ranked[:3]:
                blocks.append(f"[知识库：{base_name}]\n{content[:4000]}")
                hits.append({"base": base_name, "name": name})

        return ManagedContext(
            text="\n\n".join(block for block in blocks if block),
            knowledge={
                "enabled": use_knowledge_base,
                "bases": [name for name, _ in enabled_bases],
                "available": available,
                "documents": hits,
            },
            skills=applied,
        )

    def runtime_policies(self) -> dict[str, object]:
        return self.get().policies

    def _apply(self, config: WorkspaceConfig) -> None:
        enabled = {
            str(item.get("id"))
            for item in config.agents
            if item.get("enabled") and item.get("id") != "supervisor_agent"
        }
        self.registry.set_enabled(enabled)
