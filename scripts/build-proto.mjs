#!/usr/bin/env node

import chalk from "chalk"
import { execSync } from "child_process"
import * as fs from "fs/promises"
import { globby } from "globby"
import { createRequire } from "module"
import os from "os"
import * as path from "path"
import { rmrf } from "./file-utils.mjs"
import { main as generateHostBridgeClient } from "./generate-host-bridge-client.mjs"
import { main as generateProtoBusSetup } from "./generate-protobus-setup.mjs"

const require = createRequire(import.meta.url)
const PROTOC = path.join(require.resolve("grpc-tools"), "../bin/protoc")

const PROTO_DIR = path.resolve("proto")
const TS_OUT_DIR = path.resolve("src/shared/proto")
const SRC_GENERATED_DIR = path.resolve("src/generated")
const GRPC_JS_OUT_DIR = path.resolve("src/generated/grpc-js")
const NICE_JS_OUT_DIR = path.resolve("src/generated/nice-grpc")
const DESCRIPTOR_OUT_DIR = path.resolve("dist-standalone/proto")

const isWindows = process.platform === "win32"
const TS_PROTO_PLUGIN = isWindows
	? path.resolve("node_modules/.bin/protoc-gen-ts_proto.cmd") // Use the .cmd file for Windows
	: require.resolve("ts-proto/protoc-gen-ts_proto")

const TS_PROTO_OPTIONS = [
	"env=node",
	"esModuleInterop=true",
	"outputServices=generic-definitions", // output generic ServiceDefinitions
	"outputIndex=true", // output an index file for each package which exports all protos in the package.
	"useOptionals=none", // scalar and message fields are required unless they are marked as optional.
	"useDate=false", // Timestamp fields will not be automatically converted to Date.
]

async function main() {
	// 【并发安全 · 切勿改回“先删后建”】
	// 原顺序是 cleanup() 先 rmrf 掉 src/shared/proto 与 src/generated，再重新生成。
	// 但本脚本在开发流程里会与 tsc --watch **并行启动**（见 .vscode/tasks.json 的 watch 任务）。
	// 一旦 tsc 在“目录不存在 / 为空”的那个窗口里构建初始程序，它会把成百上千个模块
	// 永久判定为“找不到”，而且**不会**重新解析已失败的模块 —— 表现为满屏 TS2307，重启也不自愈。
	// （实测：并行启动 = 636 errors；顺序启动 = 0 errors。）
	//
	// 因此改为：不再预先删除；就地重新生成（protoc 与两个生成器都是覆盖写），
	// 生成成功后再清理“本次运行没有被重写”的残留文件（按 mtime 判定）。
	// 这样两个目录在全程都保持存在且内容完整。
	const runStartedAt = Date.now()

	await removeLegacyGeneratedFiles()

	await compileProtos()
	await generateProtoBusSetup()
	await generateHostBridgeClient()

	await pruneStaleGeneratedFiles(runStartedAt)
}
async function compileProtos() {
	console.log(chalk.bold.blue("Compiling Protocol Buffers..."))

	// Check for Apple Silicon compatibility before proceeding
	checkAppleSiliconCompatibility()

	// Create output directories if they don't exist
	for (const dir of [TS_OUT_DIR, GRPC_JS_OUT_DIR, NICE_JS_OUT_DIR, DESCRIPTOR_OUT_DIR]) {
		await fs.mkdir(dir, { recursive: true })
	}

	// Process all proto files
	const protoFiles = await globby("**/*.proto", { cwd: PROTO_DIR, realpath: true })
	console.log(chalk.cyan(`Processing ${protoFiles.length} proto files from`), PROTO_DIR)

	tsProtoc(TS_OUT_DIR, protoFiles, TS_PROTO_OPTIONS)
	// grpc-js is used to generate service impls for the ProtoBus service.
	tsProtoc(GRPC_JS_OUT_DIR, protoFiles, ["outputServices=grpc-js", ...TS_PROTO_OPTIONS])
	// nice-js is used for the Host Bridge client impls because it uses promises.
	tsProtoc(NICE_JS_OUT_DIR, protoFiles, ["outputServices=nice-grpc,useExactTypes=false", ...TS_PROTO_OPTIONS])

	const descriptorFile = path.join(DESCRIPTOR_OUT_DIR, "descriptor_set.pb")
	const descriptorProtocCommand = [
		PROTOC,
		`--proto_path="${PROTO_DIR}"`,
		`--descriptor_set_out="${descriptorFile}"`,
		"--include_imports",
		...protoFiles,
	].join(" ")
	try {
		log_verbose(chalk.cyan("Generating descriptor set..."))
		execSync(descriptorProtocCommand, { stdio: "inherit" })
	} catch (error) {
		console.error(chalk.red("Error generating descriptor set for proto file:"), error)
		process.exit(1)
	}

	log_verbose(chalk.green("Protocol Buffer code generation completed successfully."))
	log_verbose(chalk.green(`TypeScript files generated in: ${TS_OUT_DIR}`))
}

async function tsProtoc(outDir, protoFiles, protoOptions) {
	// Build the protoc command with proper path handling for cross-platform
	const command = [
		PROTOC,
		`--proto_path="${PROTO_DIR}"`,
		`--plugin=protoc-gen-ts_proto="${TS_PROTO_PLUGIN}"`,
		`--ts_proto_out="${outDir}"`,
		`--ts_proto_opt=${protoOptions.join(",")} `,
		...protoFiles.map((s) => `"${s}"`),
	].join(" ")
	try {
		log_verbose(chalk.cyan(`Generating TypeScript code in ${outDir} for:\n${protoFiles.join("\n")}...`))
		log_verbose(command)
		execSync(command, { stdio: "inherit" })
	} catch (error) {
		console.error(chalk.red("Error generating TypeScript for proto files:"), error)
		process.exit(1)
	}
}

/**
 * 只清理“曾经生成过、现在已迁走”的历史文件。
 *
 * ⚠️ 这里**刻意不再** rmrf TS_OUT_DIR / SRC_GENERATED_DIR —— 见 main() 里的说明：
 * 预先删除生成目录会让并行的 tsc --watch 永久失去这些模块。
 */
async function removeLegacyGeneratedFiles() {
	// Clean up generated files that were moved.
	await rmrf("src/standalone/services/host-grpc-client.ts")
	await rmrf("src/standalone/server-setup.ts")
	await rmrf("src/hosts/vscode/host-grpc-service-config.ts")
	await rmrf("src/core/controller/grpc-service-config.ts")
	const oldhostbridgefiles = [
		"src/hosts/vscode/workspace/methods.ts",
		"src/hosts/vscode/workspace/index.ts",
		"src/hosts/vscode/diff/methods.ts",
		"src/hosts/vscode/diff/index.ts",
		"src/hosts/vscode/env/methods.ts",
		"src/hosts/vscode/env/index.ts",
		"src/hosts/vscode/window/methods.ts",
		"src/hosts/vscode/window/index.ts",
		"src/hosts/vscode/watch/methods.ts",
		"src/hosts/vscode/watch/index.ts",
		"src/hosts/vscode/uri/methods.ts",
		"src/hosts/vscode/uri/index.ts",
	]
	const oldprotobusfiles = [
		"src/core/controller/account/index.ts",
		"src/core/controller/account/methods.ts",
		"src/core/controller/browser/index.ts",
		"src/core/controller/browser/methods.ts",
		"src/core/controller/checkpoints/index.ts",
		"src/core/controller/checkpoints/methods.ts",
		"src/core/controller/file/index.ts",
		"src/core/controller/file/methods.ts",
		"src/core/controller/mcp/index.ts",
		"src/core/controller/mcp/methods.ts",
		"src/core/controller/models/index.ts",
		"src/core/controller/models/methods.ts",
		"src/core/controller/slash/index.ts",
		"src/core/controller/slash/methods.ts",
		"src/core/controller/state/index.ts",
		"src/core/controller/state/methods.ts",
		"src/core/controller/task/index.ts",
		"src/core/controller/task/methods.ts",
		"src/core/controller/ui/index.ts",
		"src/core/controller/ui/methods.ts",
		"src/core/controller/web/index.ts",
		"src/core/controller/web/methods.ts",
	]
	for (const file of [...oldhostbridgefiles, ...oldprotobusfiles]) {
		await rmrf(file)
	}
}

/** 递回列出目录下所有文件的绝对路径（目录不存在时返回空数组） */
async function listFilesRecursive(dir) {
	const found = []
	async function walk(current) {
		let entries
		try {
			entries = await fs.readdir(current, { withFileTypes: true })
		} catch {
			return
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name)
			if (entry.isDirectory()) {
				await walk(full)
			} else {
				found.push(full)
			}
		}
	}
	await walk(dir)
	return found
}

/**
 * 删除本次运行**没有被重写**的生成文件（判定依据：mtime 早于本次运行开始时间）。
 *
 * 它取代了原先“先删后建”里的删除动作：既清掉不再产出的残留文件，
 * 又不会制造“目录不存在 / 为空”的窗口（那会让并行的 tsc --watch 永久报 TS2307）。
 */
async function pruneStaleGeneratedFiles(runStartedAt) {
	let removed = 0
	for (const dir of [TS_OUT_DIR, SRC_GENERATED_DIR]) {
		for (const file of await listFilesRecursive(dir)) {
			try {
				const stat = await fs.stat(file)
				if (stat.mtimeMs < runStartedAt) {
					await fs.rm(file, { force: true })
					removed++
				}
			} catch {
				// 并发删除 / 权限问题：跳过，不影响本次生成结果
			}
		}
	}
	if (removed > 0) {
		log_verbose(chalk.cyan(`Pruned ${removed} stale generated file(s).`))
	}
}

// Check for Apple Silicon compatibility
function checkAppleSiliconCompatibility() {
	// Only run check on macOS
	if (process.platform !== "darwin") {
		return
	}

	// Check if running on Apple Silicon
	const cpuArchitecture = os.arch()
	if (cpuArchitecture === "arm64") {
		try {
			// Check if Rosetta is installed
			const rosettaCheck = execSync('/usr/bin/pgrep oahd || echo "NOT_INSTALLED"').toString().trim()

			if (rosettaCheck === "NOT_INSTALLED") {
				console.log(chalk.yellow("Detected Apple Silicon (ARM64) architecture."))
				console.log(
					chalk.red("Rosetta 2 is NOT installed. The npm version of protoc is not compatible with Apple Silicon."),
				)
				console.log(chalk.cyan("Please install Rosetta 2 using the following command:"))
				console.log(chalk.cyan("  softwareupdate --install-rosetta --agree-to-license"))
				console.log(chalk.red("Aborting build process."))
				process.exit(1)
			}
		} catch (_error) {
			console.log(chalk.yellow("Could not determine Rosetta installation status. Proceeding anyway."))
		}
	}
}

function log_verbose(s) {
	if (process.argv.includes("-v") || process.argv.includes("--verbose")) {
		console.log(s)
	}
}

// Run the main function
main().catch((error) => {
	console.error(chalk.red("Error:"), error)
	process.exit(1)
})
