#!/usr/bin/env bash
# Neptune 服务器端安装脚本（Linux + systemd + nginx）。
#
# 用法：
#   DOMAIN=nexus.example.com ADMIN_PASSWORD='你的强密码' ./scripts/server_setup.sh --dry-run
#   DOMAIN=nexus.example.com ADMIN_PASSWORD='你的强密码' sudo -E ./scripts/server_setup.sh
#
# 它做四件事：写 .env（自动生成 JWT 密钥）→ 装依赖 → 构建前端 → 装 systemd 与 nginx 配置。
# 不碰证书：HTTPS 证书请用 certbot 单独签发（见文末提示）。
#
# 说明：这份脚本是在 Windows 上写的，无法在目标机上端到端实测 ——
# 所以所有"会动系统"的动作都能用 --dry-run 先看一遍，脚本本身也用 bash -n 与 --dry-run 验证过。

set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${RUN_USER:-$(id -un)}"
DOMAIN="${DOMAIN:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
STATE_DIR="${STATE_DIR:-/srv/neptune/state}"
WRITE_ROOT="${WRITE_ROOT:-/srv/neptune/workspace}"
PORT_WEB="${PORT_WEB:-3000}"
PORT_API="${PORT_API:-8000}"
DRY_RUN=0
FORCE=0
WITH_SERVICES=1

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY_RUN=1 ;;
    --force) FORCE=1 ;;
    --no-services) WITH_SERVICES=0 ;;
    --domain) DOMAIN="$2"; shift ;;
    --admin-password) ADMIN_PASSWORD="$2"; shift ;;
    *) echo "未知参数：$1" >&2; exit 2 ;;
  esac
  shift
done

log()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
info() { printf '   %s\n' "$*"; }
run()  {
  if [ "$DRY_RUN" = 1 ]; then printf '   [dry-run] %s\n' "$*"; else printf '   $ %s\n' "$*"; "$@"; fi
}

if [ "$RUN_USER" = "root" ]; then
  echo "别用 root 跑应用；请用普通用户 + sudo 执行（RUN_USER=应用运行用户）。" >&2
  exit 2
fi

# ---------------------------------------------------------------- 0. 前置检查
log "0/6 前置检查"
MISSING=0
for cmd in uv pnpm node python3 nginx systemctl; do
  if command -v "$cmd" >/dev/null 2>&1; then info "✓ $cmd"; else
    info "✗ 缺少 $cmd —— 先按 docs/deployment-checklist.md 第 1 步安装"; MISSING=1
  fi
done
if [ "$MISSING" = 1 ] && [ "${SKIP_PREFLIGHT:-0}" != 1 ]; then
  exit 3
elif [ "$MISSING" = 1 ]; then
  info "（SKIP_PREFLIGHT=1，跳过前置检查继续 —— 仅用于在非目标机上预览动作序列）"
fi
info "应用目录：$APP_DIR"
info "运行用户：$RUN_USER"

if [ -z "$DOMAIN" ]; then read -r -p "对外域名（不含 https://）：" DOMAIN; fi
if [ -z "$DOMAIN" ]; then echo "必须提供域名（用于 CORS 与前端流式地址）" >&2; exit 2; fi
if [ -z "$ADMIN_PASSWORD" ]; then
  read -r -s -p "初始管理员密码（≥12 位）：" ADMIN_PASSWORD; echo
fi
if [ "${#ADMIN_PASSWORD}" -lt 12 ]; then echo "管理员密码太短（<12 位）" >&2; exit 2; fi

# ---------------------------------------------------------------- 1. 写 .env
log "1/6 配置 .env"
ENV_FILE="$APP_DIR/.env"
if [ -f "$ENV_FILE" ] && [ "$FORCE" != 1 ]; then
  info ".env 已存在，保留现有内容（只补齐缺失项）。加 --force 才覆盖。"
else
  if [ "$DRY_RUN" = 1 ]; then info "[dry-run] cp .env.example .env"; else
    cp "$APP_DIR/.env.example" "$ENV_FILE"; chmod 600 "$ENV_FILE"
  fi
fi

upsert() {  # upsert <KEY> <VALUE> —— 幂等：有就替换，没有就追加
  local key="$1" value="$2" file="$APP_DIR/.env"
  if [ "$DRY_RUN" = 1 ]; then
    # 密钥类只回显长度，避免 dry-run 的输出被粘到别处当泄露源
    case "$key" in
      *SECRET*|*PASSWORD*|*API_KEY*) printf '   [dry-run] %s=<已隐藏，%s 字符>\n' "$key" "${#value}" ;;
      *) printf '   [dry-run] %s=%s\n' "$key" "$value" ;;
    esac
    return
  fi
  python3 - "$key" "$value" "$file" <<'PY'
import re, sys
key, value, path = sys.argv[1], sys.argv[2], sys.argv[3]
lines = open(path, encoding="utf-8").read().splitlines()
pattern = re.compile(rf"^\s*{re.escape(key)}\s*=")
for i, line in enumerate(lines):
    if pattern.match(line):
        lines[i] = f"{key}={value}"
        break
else:
    lines.append(f"{key}={value}")
open(path, "w", encoding="utf-8").write("\n".join(lines) + "\n")
PY
}

JWT_SECRET="$(python3 -c 'import secrets;print(secrets.token_urlsafe(48))')"
upsert APP_JWT_SECRET            "$JWT_SECRET"
upsert APP_ADMIN_PASSWORD        "$ADMIN_PASSWORD"
upsert APP_COOKIE_SECURE         "true"
upsert APP_CORS_ORIGINS          "https://$DOMAIN"
upsert APP_ALLOW_REGISTRATION    "false"
upsert APP_ALLOW_GUEST           "false"
upsert APP_MCP_ALLOW_PRIVATE_ENDPOINTS "false"
upsert APP_WRITE_ROOT            "$WRITE_ROOT"
upsert APP_DATABASE_PATH         "$STATE_DIR/nexus.db"
upsert NEXT_PUBLIC_STREAM_URL    "https://$DOMAIN"
info "注意：数据库放在 $STATE_DIR/nexus.db，技能的原始文件在它旁边的 skills/；"
info "      而写入快照固定在 <项目>/data/snapshots/ —— 这两处都要持久化。"

# 目录与权限
run mkdir -p "$STATE_DIR" "$WRITE_ROOT"
run chown -R "$RUN_USER":"$RUN_USER" "$STATE_DIR" "$WRITE_ROOT" 2>/dev/null || true

# ---------------------------------------------------------------- 2. 依赖
log "2/6 安装依赖"
run uv sync --no-dev
run pnpm install --frozen-lockfile

# ---------------------------------------------------------------- 3. 构建
log "3/6 构建前端（NEXT_PUBLIC_* 必须在这一步之前就位）"
if [ "$DRY_RUN" = 1 ]; then
  info "[dry-run] set -a && . ./.env && set +a && pnpm build:web"
else
  set -a; . "$ENV_FILE"; set +a
  if ! grep -q "^NEXT_PUBLIC_STREAM_URL=" "$ENV_FILE"; then
    echo "缺少 NEXT_PUBLIC_STREAM_URL —— 构建前必须设好，否则实时推送连不上" >&2
    exit 4
  fi
  ( cd "$APP_DIR" && pnpm build:web )
fi

# ---------------------------------------------------------------- 4. systemd
if [ "" = 1 ]; then
log "4/6 安装 systemd 服务"
write_unit() {  # write_unit <名字> <ExecStart>
  # ⚠️ 三个赋值必须分开写：`local a="$1" b="x/$a"` 在 bash 里会先展开所有词再赋值，
  # `set -u` 下直接报 "a: unbound variable"（实测 bash 5.3）。别合成一行。
  local name="$1"
  local exec_start="$2"
  local path="/etc/systemd/system/$name.service"
  if [ -f "$path" ] && [ "$FORCE" != 1 ]; then info "$path 已存在，跳过"; return; fi
  if [ "$DRY_RUN" = 1 ]; then info "[dry-run] 写入 $path"; return; fi
  cat > "$path" <<UNIT
[Unit]
Description=$name
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=$APP_DIR/.env
ExecStart=$exec_start
Restart=always
RestartSec=3
User=$RUN_USER
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT
  info "已写入 $path"
}

# ⚠️ 这里必须 `|| true`：`set -e` 下 `VAR="$(command -v 不存在)"` 会让脚本**静默退出**
# （dry-run 时就是这么在第 4 步后半段无声死掉的）。
UV_BIN="$(command -v uv || true)";     [ -n "$UV_BIN" ]   || UV_BIN="/usr/local/bin/uv"
PNPM_BIN="$(command -v pnpm || true)"; [ -n "$PNPM_BIN" ] || PNPM_BIN="/usr/local/bin/pnpm"
info "ExecStart 用到的解释器：uv=$UV_BIN pnpm=$PNPM_BIN"
write_unit neptune-api "$UV_BIN run uvicorn apps.api.main:app --host 127.0.0.1 --port $PORT_API --workers 1"
write_unit neptune-web "$PNPM_BIN --filter web start -- --hostname 127.0.0.1 --port $PORT_WEB"
run sudo systemctl daemon-reload
run sudo systemctl enable --now neptune-api neptune-web

# ---------------------------------------------------------------- 5. nginx
log "5/6 配置 nginx（/api/tasks/<id>/events 直连后端且不缓冲）"
NGINX_CONF="/etc/nginx/conf.d/neptune.conf"
if [ -f "$NGINX_CONF" ] && [ "$FORCE" != 1 ]; then
  info "$NGINX_CONF 已存在，跳过（避免覆盖你已有的配置）"
elif [ "$DRY_RUN" = 1 ]; then
  info "[dry-run] 写入 $NGINX_CONF（含 SSE 直连片段）"
else
  sudo tee "$NGINX_CONF" >/dev/null <<NGINX
server {
    listen 80;
    server_name $DOMAIN;

    # 实时事件流：直连后端。走 Next 的 /api 代理会被缓冲，EventSource 会一直停在 CONNECTING。
    location ~ ^/api/tasks/[^/]+/events\$ {
        proxy_pass http://127.0.0.1:$PORT_API;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header Connection "";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 3600s;
    }

    location / {
        proxy_pass http://127.0.0.1:$PORT_WEB;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";
    }
}
NGINX
  run sudo nginx -t
  run sudo systemctl reload nginx
fi
else
  log "4-5/6 跳过 systemd 与 nginx（--no-services）"
  info "记得自己把两个进程跑起来：uv run uvicorn … / pnpm --filter web start -- --hostname 127.0.0.1"
fi

# ---------------------------------------------------------------- 6. 验收
log "6/6 验收（在浏览器打开前先跑一遍）"
cat <<'CHECKS'
   # 后端健康
   curl -s http://127.0.0.1:8000/health                 # → {"status":"ok"}
   # 前端在跑
   curl -sI http://127.0.0.1:3000/login | head -1       # → 200
   # 未登录被挡 / 访客与注册已关（403 才是对的；用户名太短会先被 422 拦，别用短名字测）
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/tasks
   curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:3000/api/auth/guest
CHECKS

log "还差一步：HTTPS 证书"
info "certbot --nginx -d $DOMAIN    # 签完会自动把上面这份 80 端口的配置改成 443"
info "签完之后：APP_COOKIE_SECURE 已经是 true，无需再改；重启两个服务即可。"
echo
info "完成。用你设置的 APP_ADMIN_PASSWORD（在 .env 里）登录后，请立刻在「账号设置」里改密码。"
