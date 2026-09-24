"""生成可直接上传到服务器的部署包（白名单打包 + 泄露自检）。

为什么用**白名单**而不是黑名单：黑名单靠"记得排除"，漏一个就把密钥或真实数据传上去了。
这里只放行明确需要的路径，然后用两道校验兜底：

  1. 结构校验：包里不允许出现 .env / *.db / data/ / node_modules / .venv / .next-build /
     .tmp / .scratch / .workbuddy / 日志 / __pycache__ / t.json 等等；
  2. **内容校验**：把本地数据库里真正存在的密钥（app_secrets）和任何"填过值的 .env 行"
     拿去扫包内所有文本文件 —— 一旦命中就**拒绝出包**（fail closed），不是打印个警告。

产物：<out>/neptune-deploy-<日期>.tar.gz 与同名 .manifest.txt（完整文件清单，便于人工复核）。

用法：
    uv run python scripts/package_deploy.py                 # 出到 ../../.scratch/deploy
    uv run python scripts/package_deploy.py --out D:/dist
"""

from __future__ import annotations

import argparse
import hashlib
import re
import sqlite3
import sys
import tarfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = Path("F:/Codex Files/.scratch/deploy")

# ---------------------------------------------------------------- 白名单
INCLUDE_DIRS = ["apps", "packages", "tests", "docs", "scripts"]
INCLUDE_FILES = [
    "pyproject.toml",
    "uv.lock",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "README.md",
    ".env.example",
    ".gitignore",
]

# 白名单目录里仍然要剔除的东西（开发/本机产物）
EXCLUDE_DIR_NAMES = {
    "__pycache__",
    "node_modules",
    ".next",
    ".next-build",
    ".venv",
    ".cache",
    ".uv-cache",
    ".ruff_cache",
    ".pytest_cache",
    ".tmp",
    ".git",
    ".idea",
}
EXCLUDE_FILE_PATTERNS = [
    re.compile(r".*\.pyc$"),
    re.compile(r".*\.log$"),
    re.compile(r".*\.tsbuildinfo$"),
    re.compile(r"^\.DS_Store$"),
    re.compile(r"^t\.json$"),          # 本机调试 dump，含真实任务内容
    re.compile(r"^\.env$"),
    re.compile(r"^.*\.env$"),          # 任何 .env（除 .env.example）
]

# ---------------------------------------------------------------- 结构黑名单（出包后校验）
FORBIDDEN = [
    (re.compile(r"(^|/)\.env$"), ".env（密钥）"),
    (re.compile(r"(^|/)data/(?!.*\bkeep\b).*"), "data/ 下的运行数据"),
    (re.compile(r".*\.db$"), "SQLite 数据库"),
    (re.compile(r".*\.db-.*$"), "SQLite 数据库附属文件"),
    (re.compile(r".*\.bak$"), "备份文件"),
    (re.compile(r".*\.(pem|key|p12|jks)$"), "证书/私钥"),
    (re.compile(r"(^|/)\.workbuddy/"), "本机会话记忆"),
    (re.compile(r"(^|/)\.scratch/"), "本机临时目录"),
    (re.compile(r"(^|/)\.tmp/"), "本机临时目录"),
    (re.compile(r"(^|/)node_modules/"), "依赖目录"),
    (re.compile(r"(^|/)\.venv/"), "虚拟环境"),
    (re.compile(r"(^|/)\.next-build/"), "本机构建产物"),
    (re.compile(r"(^|/)__pycache__/"), "Python 缓存"),
    (re.compile(r".*\.pyc$"), "Python 编译产物"),
    (re.compile(r".*\.log$"), "日志"),
    (re.compile(r"(^|/)t\.json$"), "调试 dump"),
]

MAX_FILE_BYTES = 2 * 1024 * 1024      # 单个文件超过 2MB 基本是产物，不是源码
TEXT_SUFFIXES = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".json", ".md", ".css", ".html",
    ".toml", ".yaml", ".yml", ".sh", ".txt", ".example", ".gitignore", "",
}


def collect_files() -> list[Path]:
    files: list[Path] = []
    for name in INCLUDE_DIRS:
        base = ROOT / name
        if not base.is_dir():
            print(f"  ⚠ 跳过不存在的目录：{name}")
            continue
        for path in sorted(base.rglob("*")):
            if not path.is_file():
                continue
            if any(part in EXCLUDE_DIR_NAMES for part in path.parts):
                continue
            if any(pattern.match(path.name) for pattern in EXCLUDE_FILE_PATTERNS):
                continue
            files.append(path)
    for name in INCLUDE_FILES:
        path = ROOT / name
        if path.is_file():
            files.append(path)
        else:
            print(f"  ⚠ 缺少必需文件：{name}")
    return sorted(set(files))


def local_secrets() -> list[str]:
    """把本地库里真实存在的密钥取出来，用于"包里是否泄露"的内容校验。"""
    secrets: list[str] = []
    database = ROOT / "data/nexus.db"
    if not database.is_file():
        return secrets
    try:
        with sqlite3.connect(f"file:{database}?mode=ro", uri=True) as conn:
            for (value,) in conn.execute("SELECT value FROM app_secrets"):
                if isinstance(value, str) and len(value) >= 16:
                    secrets.append(value)
    except sqlite3.Error as error:                      # 库读不了不该阻断出包
        print(f"  ⚠ 无法读取本地密钥用于校验（{error}）—— 结构校验仍然生效")
    # 注意：不要在这里加 admin123 之类的"兜底默认值" —— 它是文档与测试里公开提到的默认值，
    # 拿它扫源码必然满屏误报（第一版就是这么把自己的自检搞成噪音的）。
    return secrets


def scan_content(archive: Path, secrets: list[str]) -> list[str]:
    """扫包内文本：本地真实密钥不得出现；敏感键名不得带着真值出现。"""
    problems: list[str] = []
    # 判据要精确，否则自检就是噪音（第一版用 *_TOKEN* / *_KEY* 通配，把
    # APP_ACCESS_TOKEN_TTL_SECONDS=1800 这种纯数字配置也判成了泄露）：
    #   1. 只有**以** SECRET / PASSWORD / API_KEY 结尾的键才可能是密钥；
    #   2. 值要像个真值 —— `<授权码>` 这类文档占位符不算。
    sensitive_key = re.compile(
        r"^\s*(APP_[A-Z0-9_]*(?:_SECRET|_PASSWORD|_API_KEY))\s*=\s*(\S.*)$"
    )
    placeholder_value = re.compile(r"^[<({\[]|^\*+$|your|example|placeholder|xxx|你的", re.I)
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar.getmembers():
            if not member.isfile() or member.size > MAX_FILE_BYTES:
                continue
            if Path(member.name).suffix not in TEXT_SUFFIXES:
                continue
            handle = tar.extractfile(member)
            if handle is None:
                continue
            try:
                text = handle.read().decode("utf-8", errors="ignore")
            except OSError:
                continue
            for secret in secrets:
                if secret and secret in text:
                    problems.append(f"{member.name}: 命中本地密钥内容（已隐去）")
            for index, line in enumerate(text.splitlines(), 1):
                if line.lstrip().startswith("#"):       # 注释掉的示例行不算
                    continue
                match = sensitive_key.match(line)
                if match and not placeholder_value.match(match.group(2).strip()):
                    problems.append(
                        f"{member.name}:{index}: {match.group(1)} 带着真值 —— 敏感配置不该进部署包"
                    )
    return problems


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="输出目录（默认项目外的 scratch）")
    args = parser.parse_args()

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d-%H%M")
    archive = out_dir / f"neptune-deploy-{stamp}.tar.gz"

    print(f"仓库根：{ROOT}")
    print("收集文件……")
    files = collect_files()
    total_mb = sum(f.stat().st_size for f in files) / 1024 / 1024
    print(f"  命中 {len(files)} 个文件，{total_mb:.2f} MB")

    # 逐个写入成员，保留相对路径
    with tarfile.open(archive, "w:gz") as tar:
        for path in files:
            tar.add(path, arcname=str(path.relative_to(ROOT)))

    print("校验包结构……")
    with tarfile.open(archive, "r:gz") as tar:
        names = [m.name for m in tar.getmembers() if m.isfile()]
    violations: list[str] = []
    for name in names:
        for pattern, label in FORBIDDEN:
            if pattern.match(name):
                violations.append(f"{name}  ← 命中黑名单：{label}")
    for name in names:
        member = ROOT / name
        if member.is_file() and member.stat().st_size > MAX_FILE_BYTES:
            violations.append(f"{name}  ← 超过 {MAX_FILE_BYTES // 1024 // 1024}MB，疑似产物")

    print("校验包内容（是否夹带本地密钥）……")
    violations += scan_content(archive, local_secrets())

    if violations:
        archive.unlink() if hasattr(archive, "unlink") and False else None
        print("\n❌ 校验未通过，已放弃这个包（fail closed）：")
        for item in violations:
            print(f"   - {item}")
        print("\n修掉之后重跑。包文件保留在磁盘便于排查：", archive)
        return 1

    manifest = out_dir / f"{archive.stem}.manifest.txt"
    manifest.write_text("\n".join(names) + "\n", encoding="utf-8")
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()[:16]

    print("\n✅ 出包成功")
    print(f"   包文件：{archive}")
    print(f"   清单：  {manifest}（{len(names)} 个文件）")
    print(f"   sha256：{digest}…")
    print(f"   大小：  {archive.stat().st_size / 1024 / 1024:.2f} MB")
    print("\n   顶层内容：")
    for top in sorted({name.split("/")[0] for name in names}):
        print(f"     - {top}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
