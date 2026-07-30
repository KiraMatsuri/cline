/**
 * =============================================================================
 *  LLMSettingsViewProvider — 教学 LLM 设置 WebviewView 容器（v1.3 增量）
 *  基于 Cline 的编程学习行为分析与教学辅助系统
 * =============================================================================
 *
 * 【职责】
 * 在 VS Code 侧边栏注册独立的 WebviewView，承载 LLMSettingsView.tsx UI。
 * 处理三类 IPC 消息：
 *   - loadLLMSettings    → 回填当前配置（apiKey 仅返回掩码）
 *   - saveLLMSettings    → 写本地 ~/.cline/teaching-llm.env + 推送到后端
 *   - testLLMConnection  → 转发到后端 /api/v1/internal/llm-test
 *
 * 【与现有模式的对齐】
 * 借鉴 VscodeWebviewProvider 的 message 路由模式，但本类独立工作：
 *   - 不依赖 WebviewProvider 单例
 *   - 自己的 disposables 数组管理生命周期
 *
 * =============================================================================
 */

import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import * as vscode from "vscode"
import { Logger } from "@/shared/services/Logger"

// ============================================================================
//  类型定义
// ============================================================================

/** 与前端 LLMSettings 字段对齐 */
export interface LLMSettings {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  enableTools: boolean
}

/** 回填到前端的"脱敏"状态 */
export interface LLMSettingsStatus {
  configured: boolean
  provider?: string
  baseUrl?: string
  model?: string
  enableTools?: boolean
  apiKeyMasked?: string
}

// ============================================================================
//  常量
// ============================================================================

/** 本地 .env 路径（用户主目录下，避免污染 Cline 仓库） */
function getLocalEnvPath(): string {
  return path.resolve(os.homedir(), ".cline", "teaching-llm.env")
}

/** API Key 掩码（前 4 + 后 4，中间省略） */
function maskApiKey(key: string): string {
  if (!key || key.length < 8) return "****"
  return `${key.slice(0, 4)}...${key.slice(-4)}`
}

// ============================================================================
//  Provider 实现
// ============================================================================

export class LLMSettingsViewProvider implements vscode.WebviewViewProvider {
  /** 注册到 package.json contributes.views 的 viewId */
  public static readonly viewId = "clineLLMSettings"

  /** 由 extension.ts 在 activate 时创建一次 */
  private static _instance: LLMSettingsViewProvider | null = null

  /** 当前激活的 webview（可能有 0/1 个） */
  private _view: vscode.WebviewView | null = null

  /** 订阅 disposable 数组 */
  private readonly _disposables: vscode.Disposable[] = []

  private constructor(private readonly _extensionUri: vscode.Uri) {}

  public static getInstance(extensionUri?: vscode.Uri): LLMSettingsViewProvider {
    if (!LLMSettingsViewProvider._instance) {
      if (!extensionUri) {
        throw new Error("LLMSettingsViewProvider 首次创建必须传入 extensionUri")
      }
      LLMSettingsViewProvider._instance = new LLMSettingsViewProvider(extensionUri)
    }
    return LLMSettingsViewProvider._instance
  }

  // ============================================================================
  //  WebviewViewProvider 接口实现
  // ============================================================================

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    }

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview)

    // 注册消息监听
    webviewView.webview.onDidReceiveMessage(
      (msg: Record<string, unknown>) => this._handleMessage(msg),
      null,
      this._disposables,
    )

    // 视图被关闭时清理
    webviewView.onDidDispose(() => {
      this._view = null
    }, null, this._disposables)
  }

  public dispose(): void {
    while (this._disposables.length) {
      const d = this._disposables.pop()
      d?.dispose()
    }
    LLMSettingsViewProvider._instance = null
  }

  // ============================================================================
  //  消息分发
  // ============================================================================

  private async _handleMessage(msg: Record<string, unknown>): Promise<void> {
    const cmd = msg["command"] as string | undefined
    const post = (response: Record<string, unknown>) => {
      this._view?.webview.postMessage(response)
    }

    try {
      switch (cmd) {
        case "loadLLMSettings": {
          const status = this._loadLocalStatus()
          post({ command: "loadLLMSettings", success: true, data: status })
          break
        }

        case "saveLLMSettings": {
          const settings: LLMSettings = {
            provider: (msg["provider"] as string) ?? "",
            baseUrl: (msg["baseUrl"] as string) ?? "",
            apiKey: (msg["apiKey"] as string) ?? "",
            model: (msg["model"] as string) ?? "",
            enableTools: Boolean(msg["enableTools"]),
          }

          if (!settings.provider || !settings.baseUrl || !settings.apiKey || !settings.model) {
            post({ command: "saveLLMSettings", success: false, error: "字段不完整" })
            return
          }

          // 1) 写本地 ~/.cline/teaching-llm.env
          this._writeLocalEnv(settings)

          // 2) 推送到后端 /api/v1/internal/llm-env
          const serverUrl = this._getServerUrl()
          await fetch(`${serverUrl}/api/v1/internal/llm-env`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(settings),
          })

          // 3) 同步 VS Code 配置（llmEnableTools 与 llmPresetModel）
          await this._syncVSCodeConfig(settings)

          post({ command: "saveLLMSettings", success: true })
          Logger.log("[LLMSettingsViewProvider] LLM 配置已保存并同步")
          break
        }

        case "testLLMConnection": {
          const baseUrl = (msg["baseUrl"] as string) ?? ""
          const apiKey = (msg["apiKey"] as string) ?? ""
          const model = (msg["model"] as string) ?? ""

          if (!baseUrl || !apiKey || !model) {
            post({ command: "testLLMConnection", success: false, error: "字段不完整" })
            return
          }

          const serverUrl = this._getServerUrl()
          try {
            const resp = await fetch(`${serverUrl}/api/v1/internal/llm-test`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ baseUrl, apiKey, model }),
            })
            const data = (await resp.json()) as { ok: boolean; message?: string }
            post({ command: "testLLMConnection", success: data.ok, data, error: data.ok ? undefined : data.message })
          } catch (e) {
            post({
              command: "testLLMConnection",
              success: false,
              error: `请求后端失败: ${e instanceof Error ? e.message : String(e)}`,
            })
          }
          break
        }

        default:
          post({ command: cmd ?? "unknown", success: false, error: "unknown command" })
      }
    } catch (e) {
      Logger.error("[LLMSettingsViewProvider] handleMessage 异常:", e)
      post({ command: cmd ?? "unknown", success: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  // ============================================================================
  //  本地 .env 读写
  // ============================================================================

  private _writeLocalEnv(s: LLMSettings): void {
    const envPath = getLocalEnvPath()
    fs.mkdirSync(path.dirname(envPath), { recursive: true })
    const content = [
      `# Auto-generated by Cline LLMSettingsView at ${new Date().toISOString()}`,
      `TEACHING_LLM_PROVIDER=${s.provider}`,
      `TEACHING_LLM_BASE_URL=${s.baseUrl}`,
      `TEACHING_LLM_API_KEY=${s.apiKey}`,
      `TEACHING_LLM_MODEL=${s.model}`,
      `TEACHING_LLM_ENABLE_TOOLS=${s.enableTools ? "true" : "false"}`,
      "",
    ].join("\n")
    fs.writeFileSync(envPath, content, "utf8")
  }

  private _loadLocalStatus(): LLMSettingsStatus {
    const envPath = getLocalEnvPath()
    if (!fs.existsSync(envPath)) return { configured: false }

    try {
      const content = fs.readFileSync(envPath, "utf8")
      const map: Record<string, string> = {}
      for (const line of content.split("\n")) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith("#")) continue
        const eqIdx = trimmed.indexOf("=")
        if (eqIdx > 0) {
          map[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim()
        }
      }

      const apiKey = map["TEACHING_LLM_API_KEY"] ?? ""
      if (!apiKey) return { configured: false }

      return {
        configured: true,
        provider: map["TEACHING_LLM_PROVIDER"],
        baseUrl: map["TEACHING_LLM_BASE_URL"],
        model: map["TEACHING_LLM_MODEL"],
        enableTools: (map["TEACHING_LLM_ENABLE_TOOLS"] ?? "false") === "true",
        apiKeyMasked: maskApiKey(apiKey),
      }
    } catch {
      return { configured: false }
    }
  }

  // ============================================================================
  //  配置同步
  // ============================================================================

  private _getServerUrl(): string {
    const cfg = vscode.workspace.getConfiguration("clineTeaching")
    const v = cfg.get<string>("serverUrl")
    if (v && v.trim()) return v.trim()
    // fallback 到旧配置
    const oldCfg = vscode.workspace.getConfiguration("teaching")
    const oldV = oldCfg.get<string>("apiBase")
    if (oldV && oldV.trim()) return oldV.trim()
    return "http://localhost:4001"
  }

  private async _syncVSCodeConfig(s: LLMSettings): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("clineTeaching")
    await cfg.update("llmEnableTools", s.enableTools, vscode.ConfigurationTarget.Global)
    await cfg.update("llmPresetModel", s.model, vscode.ConfigurationTarget.Global)
  }

  // ============================================================================
  //  HTML 渲染
  // ============================================================================

  private _getHtmlForWebview(webview: vscode.Webview): string {
    // 复用主 webview 入口（与 WebviewProvider.getHtmlContent 对齐）
    // 注意：v1.3 此 view 渲染的是与主 webview 共享的 React 应用，由前端按 viewType 区分页面
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this._extensionUri, "webview-ui", "build", "assets", "index.js"),
    )
    const nonce = getNonce()
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; font-src ${webview.cspSource} data:; img-src ${webview.cspSource} https: data:; script-src 'nonce-${nonce}';" />
  <title>LLM 设置</title>
</head>
<body>
  <div id="root" data-view="clineLLMSettings"></div>
  <script type="module" nonce="${nonce}" src="${scriptUri.toString()}"></script>
</body>
</html>`
  }
}

/** 生成 CSP nonce */
function getNonce(): string {
  let text = ""
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length))
  }
  return text
}