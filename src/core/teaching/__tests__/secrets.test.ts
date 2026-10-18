/**
 * secrets 单测（P2-1 / BN-11、BN-12）
 *
 * 目标：既要把真密钥打掉，也不能把普通代码误伤成 REDACTED。
 */

import "should"
import { isEnvFile, REDACTED, redactEnvFile, redactForFile, redactSecrets } from "../submission/secrets"

describe("secrets（需求 2：上传前密钥打码）", () => {
	it("BN-11 赋值型密钥被打码", () => {
		const source = ['const apiKey = "sk-abcdef0123456789abcdef"', 'const githubToken = "ghp_1234567890abcdefghij"'].join("\n")
		const result = redactSecrets(source)
		;(result.hits >= 2).should.be.true()
		result.text.should.not.containEql("abcdef0123456789")
		result.text.should.not.containEql("ghp_1234567890")
		result.text.should.containEql(REDACTED)
	})

	it("JWT 与私钥块被打码", () => {
		const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
		const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----"
		const result = redactSecrets(`${jwt}\n${key}`)
		result.text.should.not.containEql("eyJhbGciOiJIUzI1NiJ9")
		result.text.should.not.containEql("MIIEpAIBAAKCAQEA")
		;(result.hits >= 2).should.be.true()
	})

	it("短值 / 自然语言赋值（看起来不像密钥）不打码，避免误伤", () => {
		const source = ['const password = "abc"', "const token = getUserToken()", "const password = prompt('请输入密码')"].join(
			"\n",
		)
		const result = redactSecrets(source)
		result.hits.should.equal(0)
		result.text.should.equal(source)
	})

	it("普通变量与普通字符串保持原样", () => {
		const source = ['const name = "张三"', 'const url = "http://localhost:4001/api"'].join("\n")
		redactSecrets(source).text.should.equal(source)
	})

	it("YAML / properties 块状配置的敏感键被打码", () => {
		const source = ["database:", "  password: hunter2hunter2", "  host: localhost"].join("\n")
		const result = redactSecrets(source)
		result.text.should.not.containEql("hunter2hunter2")
		result.text.should.containEql("host: localhost")
	})

	it("BN-12 .env 文件逐行打码敏感键，保留键名便于学生对照", () => {
		const env = ["DB_PASSWORD=hunter2hunter2", "NORMAL_KEY=value", "OPENAI_API_KEY=sk-abcdef0123456789abcdef", ""].join("\n")
		const result = redactEnvFile(env)
		result.text.should.not.containEql("hunter2hunter2")
		result.text.should.not.containEql("sk-abcdef0123456789")
		result.text.should.containEql("DB_PASSWORD=")
		result.text.should.containEql("NORMAL_KEY=value")
		;(result.hits >= 2).should.be.true()
	})

	it("isEnvFile 只认 .env / .env.* 命名", () => {
		isEnvFile(".env").should.be.true()
		isEnvFile(".env.local").should.be.true()
		isEnvFile("config/.env").should.be.true()
		isEnvFile("src/environment.ts").should.be.false()
		isEnvFile("README.md").should.be.false()
	})

	it("redactForFile 按文件名分派策略", () => {
		const envFile = redactForFile(".env", "TOKEN=abcdefgh12345678")
		envFile.text.should.containEql(REDACTED)
		const codeFile = redactForFile("main.py", 'api_key = "abcdefgh12345678"')
		codeFile.text.should.containEql(REDACTED)
	})

	it("已打码的内容重复处理不会二次命中", () => {
		const once = redactSecrets('apiKey = "sk-abcdef0123456789abcdef"')
		const twice = redactSecrets(once.text)
		twice.text.should.equal(once.text)
	})
})
