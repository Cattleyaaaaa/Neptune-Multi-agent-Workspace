import { NextResponse, type NextRequest } from "next/server";

/* 服务端的第一道门：没登录时直接 307 到 /login，页面根本不会开始渲染，
   所以不会先闪一下工作台骨架再跳走。

   这里只检查刷新令牌"存不存在、有没有过期"——签名校验放在后端 API 上。
   中间件里只读 payload 的 exp 是为了避免把已过期的用户放进工作台又立刻被弹回来。 */

const REFRESH_COOKIE = "nexus_refresh";
const LOGIN_PATH = "/login";
const HOME_PATH = "/workbench/runtime";

function refreshTokenAlive(token: string): boolean {
  if (!token) return false;
  const payload = token.split(".")[1];
  if (!payload) return false;
  try {
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    // 注意：JS 的 % 允许负结果（与 Python 不同），(-len) % 4 是负数，
    // String.repeat(负数) 会直接抛 RangeError —— 之前就是这里把所有合法
    // 会话误判成"未登录"，页面于是永远 307 回登录页。
    const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
    const claims = JSON.parse(atob(padded)) as { exp?: number };
    if (typeof claims.exp !== "number") return false;
    return claims.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;
  const alive = refreshTokenAlive(request.cookies.get(REFRESH_COOKIE)?.value ?? "");

  if (pathname === LOGIN_PATH || pathname.startsWith(`${LOGIN_PATH}/`)) {
    // 已经登录就别再停在登录页。
    return alive
      ? NextResponse.redirect(new URL(HOME_PATH, request.url))
      : NextResponse.next();
  }

  if (alive) return NextResponse.next();

  const login = new URL(LOGIN_PATH, request.url);
  login.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(login);
}

/* /api 交给 FastAPI 自己判 401（它知道令牌真伪），静态资源没必要过中间件。 */
export const config = {
  matcher: ["/((?!api|_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|svg|ico|webp)$).*)"],
};
