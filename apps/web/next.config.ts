import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 本机的 safe-delete 守卫拦下了 next 启动时对旧 .next 的一次性清理（79 个文件），
  // 开发服务器因此起不来。换个 distDir 让它写进全新目录，就不需要先删旧文件。
  // 代价：仓库里会多一个构建目录（见 .gitignore 的 .next-build/）。
  distDir: ".next-build",
  // 上层目录里还有一个 package-lock.json，Next 会把它当成工作区根，于是构建追踪
  // 从 F:\Codex Files\ 开始（构建日志里那条 "multiple lockfiles" 告警）。钉住根目录，
  // 让构建产物只跟本仓库相关。
  outputFileTracingRoot: __dirname,
  // The dev indicator defaults to bottom-left, where it lands on top of the
  // sidebar — the rail already carries 18 entries plus a scrollbar. Dev-only.
  devIndicators: {
    position: "bottom-right",
  },
  async redirects() {
    return [
      {
        source: "/",
        destination: "/workbench/runtime",
        permanent: false,
      },
      // 步骤页原先是动态路由 /workbench/runtime/<taskId>，但本机 dev 环境下
      // 渲染任何动态路由段都会让 Next 的 worker 崩掉（生产模式正常），
      // 所以改成静态路由 + 查询参数；旧链接在这里兜住，分享出去的地址不会失效。
      {
        source: "/workbench/runtime/:taskId",
        destination: "/workbench/steps?task=:taskId",
        permanent: false,
      },
    ];
  },
  async rewrites() {
    return [
      // ⚠️ 这两条代理目标是写死的 127.0.0.1:8000：单机部署（前后端同机）不用改；
      //    后端在别的容器/主机时，**必须同时改这里和 SSE 地址**（见 docs/deployment.md）。
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:8000/api/:path*",
      },
      {
        source: "/health",
        destination: "http://127.0.0.1:8000/health",
      },
      // API 文档也走同源代理：侧栏的「API 文档」链接在没有配 NEXT_PUBLIC_API_URL 时
      // 用相对路径 /docs，不代理的话部署到域名后它会被烧成 http://localhost:8000/docs，
      // 访客的浏览器根本打不开。
      // 实测：登录后 /docs 与 /openapi.json 返回 200；未登录会被 middleware 307 回 /login，
      // 也就是**文档跟着应用的登录门走**。但后端端口若直接对外（不经 Next），
      // FastAPI 自己的 /docs 是公开的 —— 别把 8000 端口暴露到公网。
      {
        source: "/docs",
        destination: "http://127.0.0.1:8000/docs",
      },
      {
        source: "/openapi.json",
        destination: "http://127.0.0.1:8000/openapi.json",
      },
    ];
  },
};

export default nextConfig;
