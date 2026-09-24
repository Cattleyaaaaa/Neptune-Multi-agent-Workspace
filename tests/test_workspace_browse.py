"""工作区目录浏览：界面能选的路径，必须是后端真的写得进去的地方。"""

from pathlib import Path

import pytest
from fastapi import HTTPException

from apps.api.browse import bind_root, browse


@pytest.fixture(autouse=True)
def workspace(tmp_path: Path) -> Path:
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "a.md").write_text("hi", encoding="utf-8")
    (tmp_path / "notes.txt").write_text("x", encoding="utf-8")
    (tmp_path / "node_modules").mkdir()
    bind_root(tmp_path)
    return tmp_path


@pytest.mark.asyncio
async def test_lists_workspace_root(workspace: Path) -> None:
    result = await browse("", None)

    assert result["root"] == str(workspace)
    assert result["path"] == ""
    assert result["parent"] is None
    names = {entry["name"] for entry in result["entries"]}
    # node_modules 这类目录不列出来，避免淹没有用信息
    assert names == {"docs", "notes.txt"}


@pytest.mark.asyncio
async def test_enters_subdirectory_and_reports_parent(workspace: Path) -> None:
    result = await browse("docs", None)

    assert result["path"] == "docs"
    assert result["parent"] == ""
    assert [entry["path"] for entry in result["entries"]] == ["docs/a.md"]
    assert result["entries"][0]["type"] == "file"


@pytest.mark.asyncio
async def test_rejects_escape_and_non_directory(workspace: Path) -> None:
    with pytest.raises(HTTPException) as escaped:
        await browse("../", None)
    assert escaped.value.status_code == 400

    with pytest.raises(HTTPException) as not_dir:
        await browse("notes.txt", None)
    assert not_dir.value.status_code == 400


@pytest.mark.asyncio
async def test_selected_path_is_really_writable(workspace: Path) -> None:
    """核心不变量：浏览接口给出的相对路径，执行器必须真的能写。"""
    from packages.general_agent.execution import WriteExecutor, WriteRequest

    executor = WriteExecutor(project_root=workspace)
    listing = await browse("docs", None)
    target = str(listing["entries"][0]["path"])

    receipt = executor.execute(WriteRequest(kind="file", path=target, content="overwritten"))
    assert receipt.ok, receipt.error
    assert (workspace / "docs" / "a.md").read_text(encoding="utf-8") == "overwritten"
