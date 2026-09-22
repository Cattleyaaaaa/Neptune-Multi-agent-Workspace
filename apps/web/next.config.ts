import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // 本机的 safe-delete 守卫拦下了 next 启动时对旧 .next 的一次性清理（79 个文件），
  // 开发服务器因此起不来。换个 distDir 让它写进全新目录，就不需要先删旧文件。
  // 代价：仓库里会多一个构建目录（见 .gitignore 的 .next-build/）。
  distDir: ".next-build",
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
    ];
  },
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: "http://127.0.0.1:8000/api/:path*",
      },
      {
        source: "/health",
        destination: "http://127.0.0.1:8000/health",
      },
    ];
  },
};

export default nextConfig;
