// 构建后把静态资源与 public 复制进 standalone 运行包，
// 使 `node .next/standalone/server.js` 可独立运行（与 Dockerfile 中的拷贝保持一致）。
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const copyDir = (from, to) => {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  fs.cpSync(from, to, { recursive: true });
};

copyDir(path.join(root, ".next", "static"), path.join(root, ".next", "standalone", ".next", "static"));
copyDir(path.join(root, "public"), path.join(root, ".next", "standalone", "public"));
console.log("[build] standalone assets copied");
