import { VSCodeLink } from "@vscode/webview-ui-toolkit/react"
import Section from "../Section"

interface AboutSectionProps {
	version: string
	renderSectionHeader: (tabId: string) => JSX.Element | null
}
const AboutSection = ({ version, renderSectionHeader }: AboutSectionProps) => {
	return (
		<div>
			{renderSectionHeader("about")}
			<Section>
				<div className="flex px-4 flex-col gap-2">
					<h2 className="text-lg font-semibold">学生端编程教学助手 v{version}</h2>
					<p>
						面向高校编程教学的学生端 AI 助手：支持实验任务管理、学习行为分析、LLM
						答疑与教学干预。可使用 CLI 与编辑器工具，在授权后逐步完成创建/编辑文件、浏览项目、执行命令等软件开发任务。
					</p>

					<h3 className="text-md font-semibold">使用帮助</h3>
					<p>
						服务器地址、学生信息等配置见顶部「服务器设置」与「实验任务」面板；遇到无法连接服务器时请先检查网络或联系任课教师。
					</p>

					<h3 className="text-md font-semibold">开源声明</h3>
					<p>
						本扩展基于开源项目{" "}
						<VSCodeLink href="https://github.com/cline/cline">Cline</VSCodeLink>（Apache-2.0）二次开发，
						原项目版权 © 2025 Cline Bot Inc.，修改内容为面向编程教学的功能定制。许可证全文见仓库 LICENSE。
					</p>
				</div>
			</Section>
		</div>
	)
}

export default AboutSection
