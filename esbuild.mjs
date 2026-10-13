import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import * as esbuild from "esbuild"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const production = process.argv.includes("--production") || process.env["IS_DEBUG_BUILD"] === "false"
const watch = process.argv.includes("--watch")
const standalone = process.argv.includes("--standalone")
const e2eBuild = process.argv.includes("--e2e-build")
const destDir = standalone ? "dist-standalone" : "dist"

/**
 * @type {import('esbuild').Plugin}
 */
const aliasResolverPlugin = {
	name: "alias-resolver",
	setup(build) {
		const aliases = {
			"@": path.resolve(__dirname, "src"),
			"@core": path.resolve(__dirname, "src/core"),
			"@integrations": path.resolve(__dirname, "src/integrations"),
			"@services": path.resolve(__dirname, "src/services"),
			"@shared": path.resolve(__dirname, "src/shared"),
			"@utils": path.resolve(__dirname, "src/utils"),
			"@packages": path.resolve(__dirname, "src/packages"),
		}

		// For each alias entry, create a resolver
		Object.entries(aliases).forEach(([alias, aliasPath]) => {
			const aliasRegex = new RegExp(`^${alias}($|/.*)`)
			build.onResolve({ filter: aliasRegex }, (args) => {
				const importPath = args.path.replace(alias, aliasPath)

				// First, check if the path exists as is
				if (fs.existsSync(importPath)) {
					const stats = fs.statSync(importPath)
					if (stats.isDirectory()) {
						// If it's a directory, try to find index files
						const extensions = [".ts", ".tsx", ".js", ".jsx"]
						for (const ext of extensions) {
							const indexFile = path.join(importPath, `index${ext}`)
							if (fs.existsSync(indexFile)) {
								return { path: indexFile }
							}
						}
					} else {
						// It's a file that exists, so return it
						return { path: importPath }
					}
				}

				// If the path doesn't exist, try appending extensions
				const extensions = [".ts", ".tsx", ".js", ".jsx"]
				for (const ext of extensions) {
					const pathWithExtension = `${importPath}${ext}`
					if (fs.existsSync(pathWithExtension)) {
						return { path: pathWithExtension }
					}
				}

				// If nothing worked, return the original path and let esbuild handle the error
				return { path: importPath }
			})
		})
	},
}

const esbuildProblemMatcherPlugin = {
	name: "esbuild-problem-matcher",

	setup(build) {
		build.onStart(() => {
			console.log("[watch] build started")
		})
		build.onEnd((result) => {
			result.errors.forEach(({ text, location }) => {
				console.error(`✘ [ERROR] ${text}`)
				console.error(`    ${location.file}:${location.line}:${location.column}:`)
			})
			console.log("[watch] build finished")
		})
	},
}

const copyWasmFiles = {
	name: "copy-wasm-files",
	setup(build) {
		build.onEnd(() => {
			// tree sitter
			const sourceDir = path.join(__dirname, "node_modules", "web-tree-sitter")
			const targetDir = path.join(__dirname, destDir)

			// Copy tree-sitter.wasm
			fs.copyFileSync(path.join(sourceDir, "tree-sitter.wasm"), path.join(targetDir, "tree-sitter.wasm"))

			// Copy language-specific WASM files
			const languageWasmDir = path.join(__dirname, "node_modules", "tree-sitter-wasms", "out")
			const languages = [
				"typescript",
				"tsx",
				"python",
				"rust",
				"javascript",
				"go",
				"cpp",
				"c",
				"c_sharp",
				"ruby",
				"java",
				"php",
				"swift",
				"kotlin",
			]

			languages.forEach((lang) => {
				const filename = `tree-sitter-${lang}.wasm`
				fs.copyFileSync(path.join(languageWasmDir, filename), path.join(targetDir, filename))
			})
		})
	},
}

const buildEnvVars = {
	"import.meta.url": "_importMetaUrl",
	"process.env.IS_STANDALONE": JSON.stringify(standalone ? "true" : "false"),
}

if (production) {
	// IS_DEV is always disable in production builds.
	buildEnvVars["process.env.IS_DEV"] = "false"
}
// Set the environment and telemetry env vars. The API key env vars need to be populated in the GitHub
// workflows from the secrets.
if (process.env.CLINE_ENVIRONMENT) {
	buildEnvVars["process.env.CLINE_ENVIRONMENT"] = JSON.stringify(process.env.CLINE_ENVIRONMENT)
}
if (process.env.TELEMETRY_SERVICE_API_KEY) {
	buildEnvVars["process.env.TELEMETRY_SERVICE_API_KEY"] = JSON.stringify(process.env.TELEMETRY_SERVICE_API_KEY)
}
if (process.env.ERROR_SERVICE_API_KEY) {
	buildEnvVars["process.env.ERROR_SERVICE_API_KEY"] = JSON.stringify(process.env.ERROR_SERVICE_API_KEY)
}

if (process.env.POSTHOG_TELEMETRY_ENABLED) {
	buildEnvVars["process.env.POSTHOG_TELEMETRY_ENABLED"] = JSON.stringify(process.env.POSTHOG_TELEMETRY_ENABLED)
}

// OpenTelemetry configuration (injected at build time from GitHub secrets)
// These provide production defaults that can be overridden at runtime via environment variables
if (process.env.OTEL_TELEMETRY_ENABLED) {
	buildEnvVars["process.env.OTEL_TELEMETRY_ENABLED"] = JSON.stringify(process.env.OTEL_TELEMETRY_ENABLED)
}
if (process.env.OTEL_LOGS_EXPORTER) {
	buildEnvVars["process.env.OTEL_LOGS_EXPORTER"] = JSON.stringify(process.env.OTEL_LOGS_EXPORTER)
}
if (process.env.OTEL_METRICS_EXPORTER) {
	buildEnvVars["process.env.OTEL_METRICS_EXPORTER"] = JSON.stringify(process.env.OTEL_METRICS_EXPORTER)
}
if (process.env.OTEL_EXPORTER_OTLP_PROTOCOL) {
	buildEnvVars["process.env.OTEL_EXPORTER_OTLP_PROTOCOL"] = JSON.stringify(process.env.OTEL_EXPORTER_OTLP_PROTOCOL)
}
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
	buildEnvVars["process.env.OTEL_EXPORTER_OTLP_ENDPOINT"] = JSON.stringify(process.env.OTEL_EXPORTER_OTLP_ENDPOINT)
}
if (process.env.OTEL_EXPORTER_OTLP_HEADERS) {
	buildEnvVars["process.env.OTEL_EXPORTER_OTLP_HEADERS"] = JSON.stringify(process.env.OTEL_EXPORTER_OTLP_HEADERS)
}
if (process.env.OTEL_METRIC_EXPORT_INTERVAL) {
	buildEnvVars["process.env.OTEL_METRIC_EXPORT_INTERVAL"] = JSON.stringify(process.env.OTEL_METRIC_EXPORT_INTERVAL)
}
// Base configuration shared between extension and standalone builds
const baseConfig = {
	bundle: true,
	minify: production,
	sourcemap: !production,
	logLevel: "silent",
	define: buildEnvVars,
	tsconfig: path.resolve(__dirname, "tsconfig.json"),
	plugins: [
		copyWasmFiles,
		aliasResolverPlugin,
		/* add to the end of plugins array */
		esbuildProblemMatcherPlugin,
	],
	format: "cjs",
	sourcesContent: false,
	platform: "node",
	banner: {
		js: "const _importMetaUrl=require('url').pathToFileURL(__filename)",
	},
}

// Extension-specific configuration
const extensionConfig = {
	...baseConfig,
	entryPoints: ["src/extension.ts"],
	outfile: `${destDir}/extension.js`,
	external: ["vscode"],
}

// Standalone-specific configuration
const standaloneConfig = {
	...baseConfig,
	entryPoints: ["src/standalone/cline-core.ts"],
	outfile: `${destDir}/cline-core.js`,
	// These modules need to load files from the module directory at runtime,
	// so they cannot be bundled.
	external: ["vscode", "@grpc/reflection", "grpc-health-check", "better-sqlite3"],
}

// E2E build script configuration
const e2eBuildConfig = {
	...baseConfig,
	entryPoints: ["src/test/e2e/utils/build.ts"],
	outfile: `${destDir}/e2e-build.mjs`,
	external: ["@vscode/test-electron", "execa"],
	sourcemap: false,
	plugins: [aliasResolverPlugin, esbuildProblemMatcherPlugin],
}

// Wiki MCP server configuration
//
// 这是一个**独立的 stdio MCP server 进程**，由插件以
// `process.execPath` + ELECTRON_RUN_AS_NODE=1 拉起（见 docs/design/wiki-mcp-retrieval-design.md §D3）。
// 因此：
//   - 必须 `external: []`：它不能用 vscode API，也不需要把 vscode 留给宿主；
//     @modelcontextprotocol/sdk 等依赖要真正打进产物里。
//   - 不挂 copyWasmFiles：这个进程用不到 tree-sitter。
//   - 产物固定为 `mcp-wiki-server.js`，与 WikiMcpRegistrar 里的 args 路径约定一致。
const mcpWikiServerConfig = {
	...baseConfig,
	entryPoints: ["src/core/teaching/mcp-wiki-server.ts"],
	outfile: `${destDir}/mcp-wiki-server.js`,
	external: [],
	plugins: [aliasResolverPlugin, esbuildProblemMatcherPlugin],
}

// Web search MCP server configuration (F8)
//
// 与 mcpWikiServerConfig **同构**：它同样是**独立的 stdio MCP server 进程**，由插件以
// `process.execPath` + ELECTRON_RUN_AS_NODE=1 拉起（见 WebMcpRegistrar.ts 的 D1 说明）。
// 因此：
//   - 必须 `external: []`：它不能用 vscode API，也不需要把 vscode 留给宿主；
//     @modelcontextprotocol/sdk 等依赖要真正打进产物里。
//   - 不挂 copyWasmFiles：这个进程用不到 tree-sitter。
//   - 产物固定为 `mcp-web-search-server.js`，与 WebMcpRegistrar 里的 args 路径约定一致。
const mcpWebSearchServerConfig = {
	...baseConfig,
	entryPoints: ["src/core/teaching/mcp-web/webSearchServer.ts"],
	outfile: `${destDir}/mcp-web-search-server.js`,
	external: [],
	plugins: [aliasResolverPlugin, esbuildProblemMatcherPlugin],
}

async function main() {
	const config = standalone ? standaloneConfig : e2eBuild ? e2eBuildConfig : extensionConfig

	// e2e 构建只产出测试用产物，不产出 MCP server
	const configs = e2eBuild ? [config] : [config, mcpWikiServerConfig, mcpWebSearchServerConfig]

	if (watch) {
		for (const c of configs) {
			const ctx = await esbuild.context(c)
			await ctx.watch()
		}
	} else {
		for (const c of configs) {
			const ctx = await esbuild.context(c)
			await ctx.rebuild()
			await ctx.dispose()
		}
	}
}

main().catch((e) => {
	console.error(e)
	process.exit(1)
})
