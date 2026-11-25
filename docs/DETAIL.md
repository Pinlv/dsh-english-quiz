# 英语填空插件

English fill-in-the-blank practice inside DeepSeek Harness.

## 做什么

- agent 现场生成 4–6 句英语填空，每句 1–2 个单词空，并带完整中文翻译。
- 输入区被一张卡片接管：所有空一屏填完，点一次提交。
- 判分在 Host 侧完成，卡片立刻逐空显示对错；答案不进入浏览器。
- 工具把用户实际填的答案交回 agent，agent 只讲错题。
- 结果卡提供“巩固这 N 个错点 / 换一组 / 结束”。

## 怎么用

在聊天里说“练一组填空”。agent 调用 `english_quiz`，卡片出现后：

- `Tab` / `Enter` 跳到下一个空。
- `Cmd/Ctrl+Enter` 或点提交，整批判分。
- 提交后看结果卡；点“巩固这 N 个错点”让 agent 按错因出新一组。

## 设计要点

- 题目完全由 agent 生成，不读题库；如果工作区有 `PROGRESS.md` 和 `RECORDED.md`，它们只作为“已学过什么”的边界，没有也能用。
- 一组 4–6 句，每句 1–2 个单词空，总空 ≤ 8。
- 判分归一化大小写、空白、全半角、句末标点和常见缩写；每空支持多个可接受答案。
- 工具阻塞等待提交；默认 600 秒超时，客户端可主动结束。
- 卡片通过 `conversation.composer` 接管输入区；待答状态由 Host 的 `englishQuiz` 会话投影提供，提交走本地 HTTP 路由。

## 已知限制

- 未提交的草稿不持久化，刷新页面会丢。
- 结果卡只在当前页面内保留，刷新后消失；聊天里的 agent 讲解仍在。
- 判分是确定性字符串比较，歧义题需要 agent 提供多个可接受答案。
- 回传通道是同源本地 HTTP 路由，没有额外的鉴权；仅适用于本机单用户场景。

## 文件

- `index.js` — Host：工具、待答表、判分、会话投影、提交路由。
- `client.js` — Client：卡片、pending interaction、提交与巩固。
- `cordis.patch.yml` — 插件行。
- `locale/*.json` — 插件页标题与描述。
- [DESIGN.md](https://github.com/Pinlv/dsh-english-quiz/blob/main/DESIGN.md) — 完整设计稿与 P1 清单。
- `docs/DETAIL.md` — 插件详情页。
