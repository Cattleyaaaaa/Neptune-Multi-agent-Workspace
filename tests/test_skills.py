"""Skill 中心：上传解析、落盘、启用后真的进上下文。

最后一条最关键——"启用"如果只是界面上的开关，这个功能就只是个文件抽屉。
"""

from pathlib import Path

import pytest

from apps.api.skills import (
    MAX_UPLOAD_BYTES,
    SkillError,
    SkillStore,
    parse_frontmatter,
    parse_upload,
    split_terms,
)
from apps.api.task_service import TaskService
from apps.api.task_store import TaskStore
from apps.api.workspace import WorkspaceService, default_workspace
from packages.contracts.models import StartTaskRequest
from packages.general_agent.capabilities import CapabilityRegistry
from packages.general_agent.tools import ToolRegistry

SKILL_MD = """---
name: 指标口径核对
description: 核对指标定义与统计口径，输出差异清单。
version: 2.1.0
category: 数据
author: 王砚
triggers: 口径、指标、核对
tools: csv_profile, workspace_files
---

# 指标口径核对

1. 找出指标定义中不一致的部分。
2. 对每个差异给出影响范围。
"""


def build(tmp_path: Path) -> tuple[SkillStore, WorkspaceService]:
    database = tmp_path / "skills.db"
    store = SkillStore(database, tmp_path / "skills")
    registry = CapabilityRegistry.default()
    workspace = WorkspaceService(
        TaskStore(database),
        default_workspace(registry, ToolRegistry(tmp_path)),
        registry,
        store,
    )
    return store, workspace


def upload(store: SkillStore, text: str, filename: str = "SKILL.md") -> dict[str, object]:
    raw = text.encode("utf-8")
    parsed = parse_upload(filename, raw)
    return store.create(parsed, filename=filename, size_bytes=len(raw), raw=raw)


# ------------------------------------------------------------------ 解析


def test_frontmatter_is_parsed_without_a_yaml_dependency() -> None:
    meta, body = parse_frontmatter(SKILL_MD)

    assert meta["name"] == "指标口径核对"
    assert meta["version"] == "2.1.0"
    assert body.startswith("# 指标口径核对")


def test_parse_skill_markdown_uses_frontmatter() -> None:
    parsed = parse_upload("SKILL.md", SKILL_MD.encode())

    assert parsed.name == "指标口径核对"
    assert parsed.description.startswith("核对指标定义")
    assert parsed.version == "2.1.0"
    assert parsed.category == "数据"
    assert parsed.triggers == ["口径", "指标", "核对"]
    assert parsed.tools == ["csv_profile", "workspace_files"]
    assert "找出指标定义中不一致的部分" in parsed.content


def test_parse_markdown_without_frontmatter_falls_back_to_content() -> None:
    parsed = parse_upload("口径检查.md", "# 口径检查\n\n先对齐定义再算数。".encode())

    assert parsed.name == "口径检查"
    assert parsed.description == "口径检查"
    assert parsed.version == "1.0.0"


def test_parse_json_skill_accepts_instructions_key() -> None:
    payload = '{"name":"周报生成","description":"按模板生成周报","instructions":"先收集进展。"}'

    parsed = parse_upload("weekly.json", payload.encode())

    assert parsed.name == "周报生成"
    assert parsed.content == "先收集进展。"


def test_parse_zip_looks_for_skill_md() -> None:
    import io
    import zipfile

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("my-skill/SKILL.md", SKILL_MD)
        archive.writestr("my-skill/notes.txt", "无关文件")
    parsed = parse_upload("my-skill.zip", buffer.getvalue())

    assert parsed.name == "指标口径核对"


@pytest.mark.parametrize(
    ("filename", "raw", "reason"),
    [
        ("evil.exe", b"x", "格式"),
        ("broken.zip", b"not a zip", "zip"),
        ("bad.json", b"{oops", "JSON"),
    ],
)
def test_bad_uploads_are_rejected(filename: str, raw: bytes, reason: str) -> None:
    with pytest.raises(SkillError) as excinfo:
        parse_upload(filename, raw)
    assert reason in excinfo.value.detail


def test_zip_without_a_skill_entry_is_rejected() -> None:
    import io
    import zipfile

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("readme.txt", "只有一个说明文件")

    with pytest.raises(SkillError) as excinfo:
        parse_upload("no-skill.zip", buffer.getvalue())
    assert "SKILL.md" in excinfo.value.detail


def test_non_utf8_file_is_rejected() -> None:
    with pytest.raises(SkillError):
        parse_upload("gbk.md", "中文".encode("gbk"))


def test_term_splitting() -> None:
    assert split_terms("口径、指标, 核对;报告") == ["口径", "指标", "核对", "报告"]


# ------------------------------------------------------------------ 存储


def test_upload_stores_metadata_and_the_raw_file(tmp_path: Path) -> None:
    store, _ = build(tmp_path)
    row = upload(store, SKILL_MD)

    assert row["name"] == "指标口径核对"
    assert row["enabled"] == 0, "导入后默认停用，要显式启用"
    stored = list((tmp_path / "skills").iterdir())
    assert len(stored) == 1
    assert stored[0].read_bytes() == SKILL_MD.encode()


def test_update_and_delete(tmp_path: Path) -> None:
    store, _ = build(tmp_path)
    row = upload(store, SKILL_MD)
    skill_id = str(row["skill_id"])

    updated = store.update(skill_id, {"enabled": True, "category": "治理"})
    assert updated is not None
    assert updated["enabled"] == 1
    assert updated["category"] == "治理"
    assert store.update("sk-nope", {"enabled": True}) is None

    assert store.delete(skill_id) is True
    assert store.delete(skill_id) is False
    assert list((tmp_path / "skills").iterdir()) == []


def test_unknown_fields_are_ignored_on_update(tmp_path: Path) -> None:
    store, _ = build(tmp_path)
    row = upload(store, SKILL_MD)

    store.update(str(row["skill_id"]), {"skill_id": "hacked", "content": "注入"})

    again = store.get(str(row["skill_id"]))
    assert again is not None
    assert again["skill_id"] == row["skill_id"]
    assert again["content"] != "注入"


def test_upload_size_limit_constant_is_enforced_by_the_route() -> None:
    # 路由层校验用这个常量；这里只确认它没被改成意外的大值
    assert MAX_UPLOAD_BYTES == 2 * 1024 * 1024


# ------------------------------------------------------- 启用后进入任务上下文


@pytest.mark.asyncio
async def test_enabled_skill_is_injected_into_the_task_context(tmp_path: Path) -> None:
    store, workspace = build(tmp_path)
    row = upload(store, SKILL_MD)  # 默认停用

    service = TaskService(
        store=TaskStore(tmp_path / "skills.db"),
        registry=CapabilityRegistry.default(),
        context_provider=workspace.managed_context,
    )
    before = await service.create_task(StartTaskRequest(objective="核对月度指标口径"))
    assert "先对齐定义" not in before.context
    assert before.applied_skills == []

    store.update(str(row["skill_id"]), {"enabled": True})
    after = await service.create_task(StartTaskRequest(objective="核对月度指标口径"))

    assert "[技能：指标口径核对]" in after.context
    assert "找出指标定义中不一致的部分" in after.context
    assert after.applied_skills == ["指标口径核对"]


@pytest.mark.asyncio
async def test_workspace_without_skill_store_still_works(tmp_path: Path) -> None:
    """没接技能库时不报错，只是没有技能注入。"""
    database = tmp_path / "plain.db"
    registry = CapabilityRegistry.default()
    workspace = WorkspaceService(
        TaskStore(database), default_workspace(registry, ToolRegistry(tmp_path)), registry
    )
    service = TaskService(
        store=TaskStore(database),
        registry=registry,
        context_provider=workspace.managed_context,
    )

    task = await service.create_task(StartTaskRequest(objective="核对月度指标口径"))

    assert task.applied_skills == []
    assert "优先使用可核验信息" in task.context
