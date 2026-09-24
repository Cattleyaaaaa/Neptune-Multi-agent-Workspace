"""每个存储都要能在**父目录不存在**时自建目录。

这条是被"从部署包解包到全新目录"的彩排逼出来的：只有 TaskStore / AuthStore 建父目录，
ScheduleStore 直接 `sqlite3.connect` —— 而谁先被实例化取决于导入顺序，于是新服务器上
`from apps.api.main import app` 会直接抛 `unable to open database file`。
（部署包特意不含 `data/`，所以这条路正好每次都踩中。）
"""

from pathlib import Path

from apps.api.auth_store import AuthStore
from apps.api.mcp import McpStore
from apps.api.schedules import ScheduleStore
from apps.api.skills import SkillStore
from apps.api.task_store import TaskStore


def fresh_db(tmp_path: Path) -> Path:
    """一个父目录完全不存在的库路径。"""
    target = tmp_path / "fresh" / "nested" / "nexus.db"
    assert not target.parent.exists(), "前置条件：父目录不能存在"
    return target


def test_task_store_creates_missing_parent(tmp_path: Path) -> None:
    target = fresh_db(tmp_path)
    TaskStore(target)
    assert target.parent.is_dir()


def test_auth_store_creates_missing_parent(tmp_path: Path) -> None:
    target = fresh_db(tmp_path)
    AuthStore(target)
    assert target.parent.is_dir()


def test_mcp_store_creates_missing_parent_and_is_usable(tmp_path: Path) -> None:
    target = fresh_db(tmp_path)
    store = McpStore(target)
    assert target.parent.is_dir()
    assert store.list() == []


def test_schedule_store_creates_missing_parent_and_is_usable(tmp_path: Path) -> None:
    target = fresh_db(tmp_path)
    store = ScheduleStore(target)
    assert target.parent.is_dir()
    assert store.list() == []


def test_skill_store_creates_missing_db_and_files_dirs(tmp_path: Path) -> None:
    target = fresh_db(tmp_path)
    files_dir = tmp_path / "fresh" / "skills"
    store = SkillStore(target, files_dir)
    assert target.parent.is_dir()
    assert files_dir.is_dir()
    assert store.list() == []


def test_app_imports_on_a_completely_fresh_tree(tmp_path: Path) -> None:
    """把"新服务器上首次启动"最要紧的那句拿来跑：默认路径下导入整个 app。

    用独立子进程 + 临时工作目录，避免污染当前进程已经建好的存储。
    """
    import subprocess
    import sys

    workdir = tmp_path / "deploy"
    workdir.mkdir()
    result = subprocess.run(
        [sys.executable, "-c", "from apps.api.main import app; print(len(app.routes))"],
        cwd=workdir,
        capture_output=True,
        text=True,
        env={
            **_fresh_env(),
            "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
        },
        timeout=120,
    )
    assert result.returncode == 0, result.stderr[-2000:]
    assert int(result.stdout.strip()) > 0
    assert (workdir / "data").is_dir(), "启动后应当自动建出 data/"


def _fresh_env() -> dict[str, str]:
    import os

    # 只保留最小环境，别把本机的 APP_* 带进去（否则用的是别的库）
    return {k: v for k, v in os.environ.items() if not k.startswith("APP_")}
