/**
 * =============================================================================
 *  copy-codicons — 把 codicon 字体资源拷贝进 webview 构建产物（v2.8）
 * =============================================================================
 *
 * 【动机】
 * 生产模式 webview HTML 通过 <link> 引用 codicon.css 加载字体图标（全项目
 * 112 处 codicon-* 图标：发送按钮、MCP、Auto-approve 箭头等）。此前引用的是
 * 扩展目录 node_modules/@vscode/codicons/dist/codicon.css，但 vsce 打包时
 * node_modules/ 被 .vscodeignore 整体排除（negate 规则对已排除父目录不生效），
 * 导致市场安装版字体 404，所有 codicon 图标渲染成异常字形。
 *
 * 【方案】
 * 把 codicon.css + codicon.ttf 拷贝到 webview-ui/build/assets/（该目录本来
 * 就随 vsix 打包），HTML 改为引用构建产物。codicon.css 内部对字体的引用是
 * 相对路径 url(codicon.ttf)，同目录放置即可自动解析。
 *
 * 【幂等】目录不存在则创建；dev 模式不需要执行本脚本。
 * =============================================================================
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
// scripts/ → 仓库根
const repoRoot = resolve(__dirname, "..")

const sourceDir = join(repoRoot, "node_modules", "@vscode", "codicons", "dist")
const targetDir = join(repoRoot, "webview-ui", "build", "assets")

const files = ["codicon.css", "codicon.ttf"]

if (!existsSync(sourceDir)) {
	console.error(`[copy-codicons] 源目录不存在: ${sourceDir}（请先安装根目录依赖）`)
	process.exit(1)
}

mkdirSync(targetDir, { recursive: true })

for (const file of files) {
	const src = join(sourceDir, file)
	const dest = join(targetDir, file)
	if (!existsSync(src)) {
		console.error(`[copy-codicons] 缺少 ${src}`)
		process.exit(1)
	}
	copyFileSync(src, dest)
	const size = readFileSync(dest).length
	console.log(`[copy-codicons] ${file} -> webview-ui/build/assets/ (${size} bytes)`)
}

console.log("[copy-codicons] done")
