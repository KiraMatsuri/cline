/**
 * serverUrl.test — 教学服务器地址归一化 + 「测试连接」失败诊断文案。
 *
 * 背景（2026-10-25 线上问题）：学生在「服务器设置」里填 `http://47.120.74.204/`（带尾斜杠），
 * 实验任务模块有 normalizeApiBase 会去尾斜杠所以能用；而「测试连接」当时只 trim，
 * 拼接出 `http://host//api/v1/internal/llm-test-current` → 服务端返回 404 HTML
 * → `resp.json()` 报 `Unexpected token '<', "<!DOCTYPE "...`。
 * 这里用纯函数把「归一化」和「失败原因文案」钉死，避免各调用点再各写一套。
 */
import { describe, it } from "mocha"
import { expect } from "chai"
import {
	DEFAULT_SERVER_URL,
	describeTestConnectionFailure,
	looksLikeHtml,
	normalizeServerUrl,
} from "../serverUrl"

describe("normalizeServerUrl — 服务器地址归一化", () => {
	it("去掉结尾斜杠（线上问题复现：http://host/ → http://host）", () => {
		expect(normalizeServerUrl("http://47.120.74.204/")).to.equal("http://47.120.74.204")
	})

	it("去掉多个结尾斜杠", () => {
		expect(normalizeServerUrl("http://host:4001///")).to.equal("http://host:4001")
	})

	it("去首尾空白（含换行）", () => {
		expect(normalizeServerUrl("  http://host:4001/ \n")).to.equal("http://host:4001")
	})

	it("已规范地址保持不变", () => {
		expect(normalizeServerUrl("https://example.com")).to.equal("https://example.com")
	})

	it("保留路径部分，只去结尾斜杠", () => {
		expect(normalizeServerUrl("http://host/teaching/")).to.equal("http://host/teaching")
	})

	it("空串 / 纯空白 / null / undefined → 兜底地址", () => {
		for (const v of ["", "   ", null, undefined]) {
			expect(normalizeServerUrl(v)).to.equal(DEFAULT_SERVER_URL)
		}
	})

	it("只有斜杠 → 兜底地址（否则会拼出 /api 相对路径）", () => {
		expect(normalizeServerUrl("/")).to.equal(DEFAULT_SERVER_URL)
		expect(normalizeServerUrl("///")).to.equal(DEFAULT_SERVER_URL)
	})

	it("调用方可传自己的兜底值（MCP 注册允许空串表示“未配置”）", () => {
		expect(normalizeServerUrl("", "")).to.equal("")
		expect(normalizeServerUrl(null, "")).to.equal("")
	})
})

describe("looksLikeHtml — 识别 HTML 错误页 / SPA 回退", () => {
	it("DOCTYPE html 开头（本次线上 404 页）", () => {
		expect(looksLikeHtml('<!DOCTYPE html>\n<html lang="en">')).to.equal(true)
	})

	it("小写 doctype / 带前导空白", () => {
		expect(looksLikeHtml('  \n<!doctype html><html></html>')).to.equal(true)
	})

	it("直接 <html> / <head> / <body> 开头", () => {
		expect(looksLikeHtml("<html><body>404</body></html>")).to.equal(true)
		expect(looksLikeHtml("<head><title>Error</title></head>")).to.equal(true)
	})

	it("JSON 不算 HTML", () => {
		expect(looksLikeHtml('{"ok":true}')).to.equal(false)
		expect(looksLikeHtml("")).to.equal(false)
	})
})

describe("describeTestConnectionFailure — 失败原因可读化", () => {
	it("HTML 响应：点明“返回网页而不是 JSON”并给出两步排查（含当前地址）", () => {
		const msg = describeTestConnectionFailure({
			serverUrl: "http://47.120.74.204",
			status: 404,
			contentType: "text/html; charset=utf-8",
			body: '<!DOCTYPE html><html><body>Cannot POST /api/v1/internal/llm-test-current</body></html>',
		})
		expect(msg).to.include("网页而不是 JSON")
		expect(msg).to.include("HTTP 404")
		expect(msg).to.include("结尾斜杠")
		expect(msg).to.include("http://47.120.74.204")
	})

	it("其它非 JSON 响应：截断响应体，避免把整页 HTML 塞进提示", () => {
		const body = "x".repeat(500)
		const msg = describeTestConnectionFailure({ serverUrl: "http://host", status: 200, body })
		expect(msg).to.include("不是合法 JSON")
		expect(msg.length).to.be.lessThan(400)
	})

	it("网络层错误：提示检查地址与网络", () => {
		const msg = describeTestConnectionFailure({
			serverUrl: "http://host:4001",
			error: new Error("fetch failed"),
		})
		expect(msg).to.include("无法连接教学服务器")
		expect(msg).to.include("http://host:4001")
	})

	it("ECONNREFUSED 等也归为网络层错误", () => {
		const msg = describeTestConnectionFailure({
			serverUrl: "http://host:4001",
			error: new Error("connect ECONNREFUSED 127.0.0.1:4001"),
		})
		expect(msg).to.include("无法连接教学服务器")
	})

	it("非网络层异常保留原始信息", () => {
		const msg = describeTestConnectionFailure({ serverUrl: "http://host", error: new Error("boom") })
		expect(msg).to.include("请求后端失败")
		expect(msg).to.include("boom")
	})
})
