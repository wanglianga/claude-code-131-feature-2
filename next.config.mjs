/** @type {import('next').NextConfig} */
const nextConfig = {
  // node:sqlite 为 Node 内置模块，仅运行于 Node.js 运行时
  serverExternalPackages: [],
  // 产出独立运行包（.next/standalone），供 Docker 精简镜像直接 node server.js
  output: "standalone",
};

export default nextConfig;
