/**
 * =============================================================================
 *  AssignmentHeader — VS Code 侧边栏 React Header 组件（v1.3 增量）
 *  基于 Cline 的编程学习行为分析与教学辅助系统
 * =============================================================================
 *
 * 【职责】
 * 在 VS Code 侧边栏顶部展示三部分交互组件：
 *   1. "获取任务"按钮（Download 图标）—— 触发 switchWeek 重拉
 *   2. "学习进度"周数 Select（1~18，默认 1）
 *   3. "服务器设置"按钮 —— 弹出 Modal 动态修改 serverUrl
 *
 * 【IPC 通信】
 *   - 周数变更 → postMessage({command: 'switchWeek', week})
 *   - 保存服务器 → postMessage({command: 'updateServerUrl', url})
 *   - 点击获取任务 → postMessage({command: 'fetchWiki', week})
 *
 * 【与 LLMSettingsView 的关系】
 *   - 本组件只管 serverUrl + 周数（教学辅助系统的"轻"设置）
 *   - LLM 设置（API Key 等）由独立的 LLMSettingsView 承载，避免混淆
 *
 * =============================================================================
 */

import type { FC } from "react"
import { useCallback, useEffect, useState } from "react"
import { getVsCodeApiInstance } from "@/config/platform.config"

// ============================================================================
//  类型定义
// ============================================================================

interface VsCodeApi {
  postMessage(message: Record<string, unknown>): void
  getState(): Record<string, unknown> | undefined
  setState(state: Record<string, unknown>): void
}

interface WikiResponse {
  command: string
  success: boolean
  data?: unknown
  error?: string
}

// ============================================================================
//  组件
// ============================================================================

const AssignmentHeader: FC = () => {
  // ----- 状态 -----
  const [currentWeek, setCurrentWeek] = useState<number>(1)
  const [serverUrl, setServerUrl] = useState<string>("http://localhost:4001")
  const [draftUrl, setDraftUrl] = useState<string>("")
  const [modalVisible, setModalVisible] = useState<boolean>(false)
  const [fetching, setFetching] = useState<boolean>(false)
  const [fetchStatus, setFetchStatus] = useState<"idle" | "success" | "fail">("idle")
  const [fetchMessage, setFetchMessage] = useState<string>("")

  // ----- VS Code API -----
  const getVsCodeApi = (): VsCodeApi | null => {
    const api = getVsCodeApiInstance()
    if (!api) {
      console.warn("[AssignmentHeader] VS Code API 不可用")
      return null
    }
    return api as VsCodeApi
  }

  // ----- 加载初始 serverUrl / week -----
  useEffect(() => {
    const api = getVsCodeApi()
    if (!api) return
    api.postMessage({ type: "wiki_command", command: "loadHeaderState" })
  }, [])

  // ----- 监听来自 Extension 的响应 -----
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data as WikiResponse
      if (msg?.command === "loadHeaderState" && msg.success && msg.data) {
        const state = msg.data as { week?: number; serverUrl?: string }
        if (typeof state.week === "number") setCurrentWeek(state.week)
        if (state.serverUrl) setServerUrl(state.serverUrl)
      }
      if (msg?.command === "fetchWiki") {
        setFetching(false)
        if (msg.success) {
          setFetchStatus("success")
          setFetchMessage((msg.data as { message?: string })?.message ?? "获取成功")
          setTimeout(() => setFetchStatus("idle"), 3500)
        } else {
          setFetchStatus("fail")
          setFetchMessage(msg.error ?? "获取失败")
        }
      }
    }
    window.addEventListener("message", handler)
    return () => window.removeEventListener("message", handler)
  }, [])

  // ----- 周数变更 -----
  const onWeekChange = (week: number) => {
    setCurrentWeek(week)
    const api = getVsCodeApi()
    if (!api) return
    api.postMessage({
      type: "wiki_command",
      command: "switchWeek",
      week,
    })
  }

  // ----- 获取任务按钮 -----
  const onFetch = () => {
    setFetching(true)
    setFetchStatus("idle")
    setFetchMessage("")
    const api = getVsCodeApi()
    if (!api) return
    api.postMessage({
      type: "wiki_command",
      command: "fetchWiki",
      week: currentWeek,
    })
  }

  // ----- 打开 Modal -----
  const openServerModal = () => {
    setDraftUrl(serverUrl)
    setModalVisible(true)
  }

  // ----- 保存服务器 -----
  const onSaveServer = () => {
    if (!draftUrl.trim()) return
    const api = getVsCodeApi()
    if (!api) return
    api.postMessage({
      type: "wiki_command",
      command: "updateServerUrl",
      url: draftUrl.trim(),
    })
    setServerUrl(draftUrl.trim())
    setModalVisible(false)
  }

  // ----- 渲染 -----
  return (
    <div style={styles.container}>
      <h3 style={styles.title}>📚 Wiki 进度感知</h3>

      {/* 第一行：获取任务按钮 */}
      <button
        onClick={onFetch}
        disabled={fetching}
        style={{ ...styles.button, ...styles.primaryButton, marginBottom: 10 }}
      >
        {fetching ? "⏳ 获取中..." : "⬇ 获取任务"}
      </button>
      {fetchStatus !== "idle" && (
        <div
          style={{
            ...styles.statusLine,
            color: fetchStatus === "success" ? "var(--vscode-terminal-ansiGreen)" : "var(--vscode-errorForeground)",
          }}
        >
          {fetchStatus === "success" ? "✅" : "❌"} {fetchMessage}
        </div>
      )}

      {/* 第二行：周数选择 */}
      <div style={{ marginTop: 10, marginBottom: 10 }}>
        <label style={styles.label}>学习进度</label>
        <select
          value={currentWeek}
          onChange={(e) => onWeekChange(Number(e.target.value))}
          style={styles.select}
        >
          {Array.from({ length: 18 }, (_, i) => i + 1).map((w) => (
            <option key={w} value={w}>
              第 {w} 周
            </option>
          ))}
        </select>
        <div style={styles.hint}>
          当前：第 {currentWeek} 周（已加载 ≤ 第 {currentWeek} 周的所有 Wiki）
        </div>
      </div>

      {/* 第三行：服务器设置按钮 */}
      <button
        onClick={openServerModal}
        style={{ ...styles.button, ...styles.secondaryButton }}
      >
        ⚙ 服务器设置
      </button>
      <div style={styles.hint}>
        当前服务器：<code>{serverUrl}</code>
      </div>

      {/* 服务器设置 Modal */}
      {modalVisible && (
        <div style={styles.modalOverlay} onClick={() => setModalVisible(false)}>
          <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
            <h3 style={{ marginTop: 0 }}>⚙ 服务器设置</h3>
            <p style={styles.modalDesc}>
              修改后端 API 地址（教学 Wiki 与实验任务共用此地址）。
              <br />
              修改后会立即刷新 Wiki 缓存。
            </p>
            <label style={styles.label}>Server URL</label>
            <input
              type="text"
              value={draftUrl}
              onChange={(e) => setDraftUrl(e.target.value)}
              placeholder="http://localhost:4001"
              style={styles.input}
              autoFocus
            />
            <p style={styles.hint}>
              格式：http(s)://host:port（与 VS Code 配置 clineTeaching.serverUrl 同源）
            </p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button
                onClick={() => setModalVisible(false)}
                style={{ ...styles.button, ...styles.secondaryButton }}
              >
                取消
              </button>
              <button onClick={onSaveServer} style={{ ...styles.button, ...styles.primaryButton }}>
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============================================================================
//  样式
// ============================================================================

const styles: Record<string, React.CSSProperties> = {
  container: {
    padding: "12px 14px",
    borderBottom: "1px solid var(--vscode-panel-border)",
    color: "var(--vscode-foreground)",
    fontSize: 13,
  },
  title: {
    margin: "0 0 12px 0",
    fontSize: 14,
    fontWeight: 700,
    color: "var(--vscode-sideBarTitle-foreground)",
  },
  label: {
    display: "block",
    marginBottom: 4,
    fontWeight: 600,
    fontSize: 12,
  },
  select: {
    width: "100%",
    padding: "6px 10px",
    background: "var(--vscode-input-background)",
    color: "var(--vscode-input-foreground)",
    border: "1px solid var(--vscode-input-border)",
    borderRadius: 4,
    fontSize: 13,
  },
  input: {
    width: "100%",
    padding: "6px 10px",
    background: "var(--vscode-input-background)",
    color: "var(--vscode-input-foreground)",
    border: "1px solid var(--vscode-input-border)",
    borderRadius: 4,
    fontSize: 13,
    boxSizing: "border-box",
  },
  button: {
    padding: "8px 16px",
    border: "none",
    borderRadius: 4,
    fontSize: 13,
    fontWeight: 600,
    cursor: "pointer",
    width: "100%",
  },
  primaryButton: {
    background: "var(--vscode-button-background)",
    color: "var(--vscode-button-foreground)",
  },
  secondaryButton: {
    background: "var(--vscode-button-secondaryBackground)",
    color: "var(--vscode-button-secondaryForeground)",
  },
  hint: {
    margin: "4px 0 0 0",
    fontSize: 11,
    color: "var(--vscode-descriptionForeground)",
    lineHeight: 1.5,
  },
  statusLine: {
    fontSize: 11,
    marginTop: 6,
  },
  modalOverlay: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.4)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 9999,
  },
  modal: {
    background: "var(--vscode-editor-background)",
    border: "1px solid var(--vscode-panel-border)",
    padding: 20,
    borderRadius: 6,
    minWidth: 360,
    maxWidth: 480,
    fontSize: 13,
  },
  modalDesc: {
    margin: "0 0 12px 0",
    fontSize: 12,
    color: "var(--vscode-descriptionForeground)",
    lineHeight: 1.6,
  },
}

export default AssignmentHeader