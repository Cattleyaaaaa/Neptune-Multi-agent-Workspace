"""Skill 中心：上传、解析、启用与落盘。

设计取舍：
* 原始文件存到 `data/skills/`（与 SQLite 同盘），数据库里存解析后的元数据与正文，
  所以列表接口不需要读文件，删除时也能一次清干净。
* 解析不引 YAML 库：`SKILL.md` 的 frontmatter 只用 `key: value` 行，按行读就够。
  真需要复杂 YAML 时再说，现在多一个依赖不划算。
* 启用的技能会拼进任务上下文（见 `WorkspaceService.managed_context`），
  这样"启用"不是界面上的开关，而是真的会进入 Agent 的提示词。
"""

from __future__ import annotations

import json
import re
import secrets
import sqlite3
import zipfile
from contextlib import closing
from dataclasses import dataclass, field
from io import BytesIO
from pathlib import Path

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile, status

from apps.api.auth import Account, current_user
from apps.api.settings import settings
from packages.contracts.models import SkillView

MAX_UPLOAD_BYTES = 2 * 1024 * 1024
ALLOWED_SUFFIXES = {".md", ".markdown", ".txt", ".json", ".zip"}
# 注入上下文时的上限：技能正文可能很长，但提示词预算有限。
INJECT_LIMIT = 2_000


class SkillError(Exception):
    def __init__(self, status_code: int, detail: str) -> None:
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


@dataclass(frozen=True)
class ParsedSkill:
    name: str
    description: str
    content: str
    version: str = "1.0.0"
    category: str = "本地导入"
    author: str = "本地导入"
    triggers: list[str] = field(default_factory=list)
    tools: list[str] = field(default_factory=list)


def split_terms(raw: str) -> list[str]:
    return [item for item in re.split(r"[、,，;；\s]+", raw or "") if item]


def parse_frontmatter(text: str) -> tuple[dict[str, str], str]:
    """读 `---` 包裹的 frontmatter。只认简单的 `key: value` 行。"""
    if not text.lstrip().startswith("---"):
        return {}, text
    body = text.lstrip()
    parts = body.split("---", 2)
    if len(parts) < 3:
        return {}, text
    meta: dict[str, str] = {}
    for line in parts[1].splitlines():
        if ":" not in line or line.strip().startswith("#"):
            continue
        key, _, value = line.partition(":")
        meta[key.strip().lower()] = value.strip().strip("\"'")
    return meta, parts[2].lstrip("\n")


def parse_json_skill(payload: dict[str, object]) -> ParsedSkill:
    content = str(
        payload.get("content")
        or payload.get("instructions")
        or payload.get("prompt")
        or payload.get("body")
        or ""
    )
    triggers = payload.get("triggers")
    tools = payload.get("tools")
    return ParsedSkill(
        name=str(payload.get("name") or "未命名技能"),
        description=str(payload.get("description") or ""),
        content=content,
        version=str(payload.get("version") or "1.0.0"),
        category=str(payload.get("category") or "本地导入"),
        author=str(payload.get("author") or "本地导入"),
        triggers=(
            [str(item) for item in triggers]
            if isinstance(triggers, list)
            else split_terms(str(triggers or ""))
        ),
        tools=(
            [str(item) for item in tools]
            if isinstance(tools, list)
            else split_terms(str(tools or ""))
        ),
    )


def parse_upload(filename: str, raw: bytes) -> ParsedSkill:
    """把上传的字节流解析成一个技能。`.zip` 里找 SKILL.md / skill.json。"""
    suffix = Path(filename).suffix.lower()
    if suffix not in ALLOWED_SUFFIXES:
        raise SkillError(
            status.HTTP_400_BAD_REQUEST,
            f"只支持 {'、'.join(sorted(ALLOWED_SUFFIXES))} 格式",
        )
    stem = Path(filename).stem

    if suffix == ".zip":
        try:
            archive = zipfile.ZipFile(BytesIO(raw))
        except zipfile.BadZipFile as exc:
            raise SkillError(status.HTTP_400_BAD_REQUEST, "zip 包无法解析") from exc
        entry = next(
            (
                name
                for name in archive.namelist()
                if Path(name).name.lower() in {"skill.md", "skill.json"}
            ),
            None,
        )
        if entry is None:
            raise SkillError(status.HTTP_400_BAD_REQUEST, "zip 里没有找到 SKILL.md 或 skill.json")
        inner = archive.read(entry)
        if inner and len(inner) > MAX_UPLOAD_BYTES:
            raise SkillError(status.HTTP_400_BAD_REQUEST, "SKILL.md 超过 2 MB")
        return parse_upload(Path(entry).name, inner)

    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise SkillError(status.HTTP_400_BAD_REQUEST, "文件需要是 UTF-8 编码") from exc

    if suffix == ".json":
        try:
            payload = json.loads(text)
        except json.JSONDecodeError as exc:
            raise SkillError(status.HTTP_400_BAD_REQUEST, "JSON 格式有误") from exc
        if not isinstance(payload, dict):
            raise SkillError(status.HTTP_400_BAD_REQUEST, "JSON 顶层需要是对象")
        parsed = parse_json_skill(payload)
        if not parsed.content:
            parsed = ParsedSkill(**{**parsed.__dict__, "content": text})
        return parsed

    meta, body = parse_frontmatter(text)
    content = body.strip() or text.strip()
    first_line = next((line.strip() for line in content.splitlines() if line.strip()), "")
    description = meta.get("description") or ""
    if not description:
        # 没有 frontmatter 时用正文首行当说明，但别把整份文档塞进"说明"
        description = first_line.lstrip("# ").strip()
    return ParsedSkill(
        name=meta.get("name") or stem,
        description=description[:300],
        content=content,
        version=meta.get("version") or "1.0.0",
        category=meta.get("category") or "本地导入",
        author=meta.get("author") or "本地导入",
        triggers=split_terms(meta.get("triggers", "")),
        tools=split_terms(meta.get("tools", "")),
    )


class SkillStore:
    def __init__(self, database_path: Path, files_dir: Path) -> None:
        self.path = database_path.resolve()
        self.files_dir = files_dir.resolve()
        self.files_dir.mkdir(parents=True, exist_ok=True)
        self._initialize()

    def list(self) -> list[dict[str, object]]:
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT * FROM skills ORDER BY created_at DESC"
            ).fetchall()
        return [dict(row) for row in rows]

    def get(self, skill_id: str) -> dict[str, object] | None:
        with closing(self._connect()) as connection:
            row = connection.execute(
                "SELECT * FROM skills WHERE skill_id = ?", (skill_id,)
            ).fetchone()
        return dict(row) if row else None

    def enabled(self) -> list[dict[str, object]]:
        with closing(self._connect()) as connection:
            rows = connection.execute(
                "SELECT name, content FROM skills WHERE enabled = 1 ORDER BY created_at"
            ).fetchall()
        return [dict(row) for row in rows]

    def create(
        self, parsed: ParsedSkill, *, filename: str, size_bytes: int, raw: bytes
    ) -> dict[str, object]:
        skill_id = f"sk-{secrets.token_hex(6)}"
        stored_name = f"{skill_id}{Path(filename).suffix.lower()}"
        (self.files_dir / stored_name).write_bytes(raw)
        with closing(self._connect()) as connection, connection:
            connection.execute(
                """
                INSERT INTO skills (
                    skill_id, name, description, category, version, author, source,
                    triggers, tools, filename, stored_name, size_kb, content, enabled
                ) VALUES (?, ?, ?, ?, ?, ?, 'local', ?, ?, ?, ?, ?, ?, 0)
                """,
                (
                    skill_id,
                    parsed.name,
                    parsed.description,
                    parsed.category,
                    parsed.version,
                    parsed.author,
                    json.dumps(parsed.triggers, ensure_ascii=False),
                    json.dumps(parsed.tools, ensure_ascii=False),
                    filename,
                    stored_name,
                    max(1, round(size_bytes / 1024)),
                    parsed.content,
                ),
            )
        created = self.get(skill_id)
        assert created is not None
        return created

    def update(self, skill_id: str, changes: dict[str, object]) -> dict[str, object] | None:
        row = self.get(skill_id)
        if row is None:
            return None
        fields: list[str] = []
        values: list[object] = []
        for key in ("name", "description", "category", "version", "author"):
            if key in changes and changes[key] is not None:
                fields.append(f"{key} = ?")
                values.append(str(changes[key]))
        if "enabled" in changes and changes["enabled"] is not None:
            fields.append("enabled = ?")
            values.append(1 if changes["enabled"] else 0)
        for key in ("triggers", "tools"):
            if key in changes and changes[key] is not None:
                fields.append(f"{key} = ?")
                values.append(json.dumps(changes[key], ensure_ascii=False))
        if not fields:
            return row
        fields.append("updated_at = CURRENT_TIMESTAMP")
        values.append(skill_id)
        with closing(self._connect()) as connection, connection:
            connection.execute(
                f"UPDATE skills SET {', '.join(fields)} WHERE skill_id = ?",  # noqa: S608 - 字段名来自白名单
                tuple(values),
            )
        return self.get(skill_id)

    def delete(self, skill_id: str) -> bool:
        row = self.get(skill_id)
        if row is None:
            return False
        with closing(self._connect()) as connection, connection:
            connection.execute("DELETE FROM skills WHERE skill_id = ?", (skill_id,))
        stored = str(row.get("stored_name") or "")
        if stored:
            target = self.files_dir / stored
            if target.is_file():
                target.unlink()
        return True

    def _initialize(self) -> None:
        with closing(self._connect()) as connection, connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS skills (
                    skill_id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    category TEXT NOT NULL DEFAULT '本地导入',
                    version TEXT NOT NULL DEFAULT '1.0.0',
                    author TEXT NOT NULL DEFAULT '本地导入',
                    source TEXT NOT NULL DEFAULT 'local',
                    triggers TEXT NOT NULL DEFAULT '[]',
                    tools TEXT NOT NULL DEFAULT '[]',
                    filename TEXT NOT NULL DEFAULT '',
                    stored_name TEXT NOT NULL DEFAULT '',
                    size_kb INTEGER NOT NULL DEFAULT 0,
                    content TEXT NOT NULL DEFAULT '',
                    enabled INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                """
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path)
        connection.row_factory = sqlite3.Row
        return connection


def to_view(row: dict[str, object], *, include_content: bool = False) -> SkillView:
    def as_list(value: object) -> list[str]:
        try:
            parsed = json.loads(str(value or "[]"))
        except json.JSONDecodeError:
            return []
        return [str(item) for item in parsed] if isinstance(parsed, list) else []

    content = str(row.get("content") or "")
    return SkillView(
        skill_id=str(row["skill_id"]),
        name=str(row["name"]),
        description=str(row["description"]),
        category=str(row["category"]),
        version=str(row["version"]),
        author=str(row["author"]),
        source=str(row["source"]),
        triggers=as_list(row.get("triggers")),
        tools=as_list(row.get("tools")),
        filename=str(row.get("filename") or ""),
        size_kb=int(row.get("size_kb") or 0),
        enabled=bool(row.get("enabled")),
        created_at=str(row.get("created_at") or ""),
        updated_at=str(row.get("updated_at") or ""),
        content=content if include_content else content[:400],
    )


_store: SkillStore | None = None


def get_skill_store() -> SkillStore:
    global _store
    if _store is None:
        database = Path(settings.database_path)
        _store = SkillStore(database, database.parent / "skills")
    return _store


skill_router = APIRouter(prefix="/api/skills", tags=["skills"])


@skill_router.get("", response_model=list[SkillView])
async def list_skills(_: Account = Depends(current_user)) -> list[SkillView]:
    return [to_view(row) for row in get_skill_store().list()]


@skill_router.get("/{skill_id}", response_model=SkillView)
async def get_skill(skill_id: str, _: Account = Depends(current_user)) -> SkillView:
    row = get_skill_store().get(skill_id)
    if row is None:
        raise HTTPException(status_code=404, detail="技能不存在")
    return to_view(row, include_content=True)


@skill_router.post("", response_model=SkillView, status_code=status.HTTP_201_CREATED)
async def upload_skill(
    file: UploadFile = File(...),
    name: str = Form(default=""),
    category: str = Form(default=""),
    author: str = Form(default=""),
    _: Account = Depends(current_user),
) -> SkillView:
    raw = await file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="文件是空的")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="文件超过 2 MB 上限")
    try:
        parsed = parse_upload(file.filename or "skill.md", raw)
    except SkillError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail) from exc
    # 表单里的显式填写优先于文件里的元数据
    parsed = ParsedSkill(
        **{
            **parsed.__dict__,
            "name": name.strip() or parsed.name,
            "category": category.strip() or parsed.category,
            "author": author.strip() or parsed.author,
        }
    )
    row = get_skill_store().create(
        parsed, filename=file.filename or "skill.md", size_bytes=len(raw), raw=raw
    )
    return to_view(row, include_content=True)


@skill_router.put("/{skill_id}", response_model=SkillView)
async def update_skill(
    skill_id: str, changes: dict[str, object], _: Account = Depends(current_user)
) -> SkillView:
    allowed = {
        "name", "description", "category", "version", "author", "enabled", "triggers", "tools",
    }
    filtered = {key: value for key, value in changes.items() if key in allowed}
    row = get_skill_store().update(skill_id, filtered)
    if row is None:
        raise HTTPException(status_code=404, detail="技能不存在")
    return to_view(row, include_content=True)


@skill_router.delete("/{skill_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_skill(skill_id: str, _: Account = Depends(current_user)) -> Response:
    if not get_skill_store().delete(skill_id):
        raise HTTPException(status_code=404, detail="技能不存在")
    return Response(status_code=status.HTTP_204_NO_CONTENT)
