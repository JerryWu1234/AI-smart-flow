# SmartFlow E2E Tasks

> 执行时将 Project Root 设置为仓库根目录，并使用 `tests/fixtures/smartflow-e2e/task.md` 作为 tasksPath。
> 所有实现和生成结果必须位于 `.smartflow-e2e/` 目录内，不得修改其他项目文件或本任务文件。

## M01 · SmartFlow E2E 流程夹具

- [ ] T001 [M01] 创建 `.smartflow-e2e/flow-input.json` — 验收：文件是有效 UTF-8 JSON，内容为 `{"suite":"smartflow-e2e","status":"pending","value":7}`。
- [ ] T002 [M01] 创建 `.smartflow-e2e/flow-transform.js`，读取 `.smartflow-e2e/flow-input.json` 并生成 `.smartflow-e2e/flow-output.json` — 验收：脚本只使用 Node.js 内置能力；执行后输出为 `{"suite":"smartflow-e2e","status":"passed","value":14,"sourceStatus":"pending"}`，且输入文件保持不变。
- [ ] T003 [M01] 创建 `.smartflow-e2e/flow-summary.md` — 验收：文档记录输入文件、转换脚本和输出文件的相对路径，并明确说明输入值 `7` 被转换为输出值 `14`；文档内容与实际文件一致。
