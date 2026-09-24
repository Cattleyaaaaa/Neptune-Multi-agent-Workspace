"""工作区目录浏览：让界面能像资源管理器一样选路径。

浏览的就是执行器真正会写入的那棵树（`WriteExecutor.project_root`），所以
"界面里看得到"与"后端写得进去"是同一件事，不会出现选得到却写不了的错位。

边界：只读（不返回文件内容）、必须登录、越界一律拒绝（路径 jail 与写入用同一套规则）、
单目录最多列 500 条。
"""

from __future__ import annotations

from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, status

from apps.api.auth import Account, current_user

router = APIRouter(prefix="/api/fs", tags=["filesystem"])

MAX_ENTRIES = 500
# 列目录时跳过这些：体量大或纯工程内部，摆出来只会淹没有用信息。
SKIP_DIRS = {"node_modules", ".git", ".next-build", "__pycache__", ".venv", ".uv-cache"}


_root: Path | None = None


def bind_root(root: Path) -> None:
    """由 main.py 在装配执行器时注册，保证浏览的根与写入的根是同一个。"""
    global _root
    _root = root.resolve()


def workspace_root() -> Path:
    if _root is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="工作区根目录尚未注册",
        )
    return _root


def _relative(target: Path, root: Path) -> str:
    """统一用 / 作为分隔符，前端拼接时不用再考虑平台差异。"""
    if target == root:
        return ""
    return target.relative_to(root).as_posix()


def _is_within(target: Path, root: Path) -> bool:
    return target == root or root in target.parents


@router.get("/browse")
async def browse(path: str = "", _: Account = Depends(current_user)) -> dict[str, object]:
    root = workspace_root()
    try:
        target = (root / path).resolve() if path else root
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=400, detail="路径无法解析") from exc

    if not _is_within(target, root):
        raise HTTPException(status_code=400, detail="只能浏览工作区内的目录")
    if not target.is_dir():
        raise HTTPException(status_code=400, detail="该路径不是目录")

    directories: list[dict[str, object]] = []
    files: list[dict[str, object]] = []
    truncated = False
    try:
        children = sorted(target.iterdir(), key=lambda item: item.name.lower())
    except OSError as exc:
        raise HTTPException(status_code=400, detail="目录无法读取") from exc

    for child in children:
        if len(directories) + len(files) >= MAX_ENTRIES:
            truncated = True
            break
        name = child.name
        if child.is_dir():
            if name in SKIP_DIRS:
                continue
            directories.append(
                {"name": name, "type": "dir", "path": _relative(child, root)}
            )
        elif child.is_file():
            try:
                size = child.stat().st_size
            except OSError:
                size = 0
            files.append(
                {
                    "name": name,
                    "type": "file",
                    "path": _relative(child, root),
                    "size": size,
                }
            )

    parent = None
    if target != root:
        parent_path = _relative(target.parent, root)
        parent = parent_path

    return {
        "root": str(root),
        "path": _relative(target, root),
        "parent": parent,
        "entries": directories + files,
        "truncated": truncated,
    }
