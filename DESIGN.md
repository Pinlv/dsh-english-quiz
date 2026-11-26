# 英语填空练习插件 · 设计稿

> 插件名：`dsh-english-quiz`
> 状态：**v1.0.0 发布版**（四种题型 + 发音/语速 + 跨会话统计页 + Anki 复习导入）
> 日期：2026-11-25
> 决策来源：2026-11-20 ~ 2026-11-23 的对话
> 下一步：拼写容错（可选）、反复错题导出 Anki

---

## 0. 一句话

在 DSH 聊天里，由 agent 现场生成一组（4–6 句）单词填空；一屏填完、一次提交、本地即时判分；agent 只讲错题，并按错因再出巩固组。

---

## 1. 背景与定位

### 现状

- 本仓库 `~/Documents/code/Anki` 是 Anki 制卡流水线：`cards/*.tsv` → `out/*.apkg`，共 169 张卡；语法进度见 `PROGRESS.md`，词汇与句子清单见 `RECORDED.md`。
- DSH 自带的提问卡（`ask_user_question`）能“题目 + 输入 + 提交”，但它是**分页的、一次只显示一题**，没有“按空判分”，也不能一屏填多个空。
- 所以“多空一屏 + 整批提交”必须做成插件自己的卡片。

### 本插件负责

1. 接管输入区，渲染一张可填多个空的练习卡。
2. 收集答案、本地判分、展示逐空结果。
3. 把逐空明细（含用户实际填的内容）交回给 agent，供讲解。
4. 提供“巩固 / 换一组 / 结束”的入口。

### 本插件不负责（P1）

- 题库文件、TSV 改造、Anki 导出。
- 跨会话统计、SRS 调度（长期记忆交给 Anki）。
- 发音、图片、语音输入。

题目内容**全部由 agent 现场生成**，插件不读题库。

---

## 2. 用户流程

1. 用户说“练一组填空”。
2. agent 读 `PROGRESS.md` 的语法进度和 `RECORDED.md`，只挑“已覆盖”的考点（薄弱点最多 1 个）。
3. agent 生成 4–6 句、每句 1–2 个单词空，调用工具 `english_quiz`，带上题目、翻译、答案、考点标签。
4. 卡片接管输入区，显示所有句子和空；用户一次填完。
5. 用户点“提交”（或 Cmd+Enter）。
6. Host 归一化判分；卡片原地变成结果态；工具调用解锁，明细作为 tool result 返回给 agent。
7. agent 只讲错题；用户点“巩固这 N 个错点”，agent 按错因生成下一组。
8. 一组结束后：`结束`，或继续。

关键顺序：**先提交 → 再讲解**。这样 agent 拿到的是用户实际填的答案（`given`），讲解才能具体到“你把 on 写成了 in”。

---

## 3. 卡片

### 3.1 答题态

```
╭─ 填空练习 ──────────────────────────────────╮
│ 本轮考点：一般过去时 · responsible for · 被动 │
│                                    4 句 / 6 空 │
│                                              │
│ ① We [    ] a new feature last Friday.       │
│    我们上周五上线了一个新功能。                 │
│                                              │
│ ② I am responsible [    ] the frontend.      │
│    我负责前端。                               │
│                                              │
│ ③ The bug [    ] fixed yesterday.            │
│    这个 bug 昨天修好了。                      │
│                                              │
│ 已填 1 / 6 空                  [ 提交 · 6 空 ] │
╰──────────────────────────────────────────────╯
```

### 3.2 结果态

```
╭─ 结果 ─────────────────────── 4 / 6 空正确 ─╮
│ ① We (deployed) a new feature last Friday. ✅ │
│ ② I am responsible (for) the frontend.     ✅ │
│ ③ The bug (in) fixed yesterday.               │
│    ✗ 你填 in，应为 was                        │
│                                              │
│ [ 巩固这 2 个错点 ]      [ 换一组 ]  [ 结束 ]  │
╰──────────────────────────────────────────────╯
```

结果态只显示对错和“你的答案 / 正确答案”，**不写讲解**；讲解由 agent 在聊天里输出。

### 3.3 交互细节

| 项目 | 规则 |
|---|---|
| 焦点 | 卡片出现时自动聚焦第 1 个空 |
| 跳空 | `Tab` / `Enter` 下一个空；`Shift+Tab` 上一个 |
| 提交 | 只点提交按钮，或 `Cmd/Ctrl+Enter` |
| 中文输入法 | 组词中按 `Enter` 不跳空、不提交（处理 composition 事件） |
| 空提交 | 允许；标灰“未作答”，不算错，也不阻止提交 |
| 尺寸 | 一屏最多 6 句 / 8 空；超出走卡片内部滚动，不撑高页面 |
| 输入框宽度 | 按预期答案长度自适应，最小 8ch，随输入增长 |
| 草稿 | 按 `callId` 存浏览器本地，误刷新不丢（P1.5） |
| 主题 | 只用 `--dsw-alias-*` token，深/浅色都验证 |
| 无障碍 | 每个空有 `aria-label`（“第 3 空”），结果态有朗读文本 |
| 放弃 | “结束”按钮；Host 侧另有超时兜底 |

### 3.4 状态机

```
idle ──(tool call)──> answering ──(submit)──> review
                          │                     │
                          └──(timeout/cancel)──> idle
review ──(结束/换一组)──> idle
review ──(巩固)──> 用户消息 “巩固错题…” → 新 tool call → answering
```

- `review` 阶段由 Host 服务在内存里保留，直到用户关闭；刷新页面后结果卡消失（聊天里的讲解仍在），可接受。
- 断线重连：只要 Host 还在等，卡片重新出现，已填内容如果没存草稿会丢（P1.5）。

---

## 4. 数据契约

### 4.1 工具入参 `english_quiz`

```json
{
  "title": "填空练习",
  "points": ["一般过去时", "responsible for", "被动语态"],
  "items": [
    {
      "id": "r1-1",
      "point": "一般过去时",
      "translation": "我们上周五上线了一个新功能。",
      "segments": [
        "We ",
        { "blank": "b1", "answers": ["deployed", "released"], "hint": "deploy 的过去式" },
        " a new feature last Friday."
      ],
      "note": "last Friday 是过去时间标志"
    }
  ],
  "timeoutSec": 600
}
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `title` | 否 | 卡片标题，默认“填空练习” |
| `points` | 是 | 本轮考点标签，显示在卡片头部；用于结果按点汇总 |
| `items[].id` | 是 | 本轮内唯一 |
| `items[].point` | 是 | 该题主考点，必须属于 `points` |
| `items[].translation` | 是 | 整句中文翻译，默认显示 |
| `items[].segments` | 是 | 文本片段与空交替；空是对象，文本是字符串 |
| `items[].segments[].answers` | 是 | 可接受答案数组；第一个是展示用首选答案 |
| `items[].segments[].hint` | 否 | 结果态在错空下显示 |
| `items[].note` | 否 | 考点备注，结果态可折叠显示 |
| `timeoutSec` | 否 | 默认 600 秒，范围 60–3600 |

校验（不通过直接返回错误给 agent，不出卡）：

- 4–6 个 item；每个 item 1–2 个空；总空数 ≤ 8。
- 每个空至少 1 个非空答案；`answers` 去重、去首尾空格。
- `segments` 至少一个空；空不能连续出现两次。
- `point` 必须在 `points` 里。
- 所有文本字段长度有上限（单句 ≤ 240 字符）。

### 4.2 工具返回

```json
{
  "setId": "2026-11-23-r1",
  "status": "submitted",
  "score": { "blanks": 4, "total": 6, "items": 2, "itemsCorrect": 1 },
  "perPoint": [
    { "point": "一般过去时", "ok": 2, "total": 2 },
    { "point": "被动语态", "ok": 0, "total": 1 }
  ],
  "items": [
    {
      "id": "r1-3",
      "point": "被动语态",
      "blanks": [
        { "blank": "b1", "given": "in", "expected": ["was"], "ok": false }
      ]
    }
  ],
  "durationMs": 38200
}
```

取消/超时：`{ "setId": "...", "status": "cancelled", "reason": "timeout" | "user" }`。

### 4.3 卡片视图

- Host 通过会话投影 + `wire.view` 向浏览器提供：
  - `phase`: `answering` | `review` | `idle`
  - `callId`
  - `title` / `points`
  - `items`: 只含 `segments` 的文本与空位、`translation`、`hint` 占位；**不含 `answers`**
  - `review`: 判分结果（`given` / `expected` / `ok`）
- 答案键只在 Host 内存与工具参数里；卡片不渲染。
- 说明：tool call 参数会进会话日志，技术上可被查看，这是 DSH 的透明性，接受。

---

## 5. 判分

按空独立判分，再按 item、point 汇总。

### 归一化顺序

1. 去首尾空白
2. 连续空白合并为一个
3. 全角转半角（含全角标点、全角字母）
4. 弯引号、弯撇号转直
5. 去句末标点 `. , ! ? ; :`
6. 忽略大小写
7. 缩写展开：`I'm → I am`、`don't → do not`、`it's → it is`、`we've → we have`、`they're → they are` 等
8. 与每个 `answers` 依次比较，任一相等即对

### 规则

- **备选答案**：`["on", "every"]` 都算对；结果里展示 `answers[0]`。
- **未作答**：空字符串 → `ok: false`，`given: ""`，结果态标灰“未作答”，不计入错题汇总（`perPoint` 里单列 `skipped`）。
- **部分正确**：`4 / 6 空`；item 只有全空正确才算 item 正确。
- **不做的归一化**：不忽略冠词、不忽略介词、不做拼写模糊匹配（避免把真错误判对）。
- **判错可改判**：本地判分只是初判。用户若认为自己的答案也对，在聊天里说；agent 在讲解中改判，并在下一组里把该写法加进 `answers`。

---

## 6. 出题规则（agent 侧）

### 6.1 “已学过”的边界

- 只从 `PROGRESS.md` §三“已覆盖”里选：be 动词、一般现在时、一般过去时、现在进行时、现在完成时、情态动词/不定式、疑问句、副词位置、介词搭配。
- “薄弱”里（否定句、被动语态、动词短语）**最多带 1 个**，作为小挑战。
- “完全空白”（从句、将来时、比较级、过去进行时、现在完成进行时、情态完成式）**不考**，除非用户明确要求“教我这个”。
- 词汇只用 `RECORDED.md` 里出现过的；除答案外，句子里出现没学过的词，必须在中文翻译里给释义，或换掉。
- 句子长度 4–10 词，保持 A2–B1 难度。

### 6.2 句子规格

- 一组 4–6 句；每句 1–2 个**单词**空（不挖短语、不挖整句）。
- 每句配一句完整中文翻译，默认显示。
- 每句只考**一个**考点；同一组内不重复考同一个具体词。
- 空必须能由上下文**唯一确定**；有歧义就加 `answers` 备选，或换句子。
- 答案与题干其他部分不能构成第二种同样自然的说法（否则就是猜谜）。
- 每题写 `note`：一句话说明考点或易错点，供结果态展开。
- 同一考点在一组里最多出现 2 次，且语境必须不同。

### 6.3 反模式

- 集合题：“列出所有不规则动词”。
- 一题多问：一句话里同时考时态、介词、拼写。
- 长句挖空：整段话只挖一个词，上下文全是噪音。
- 同句换零件：`for two years` vs `for three years`，没有学习价值。
- 无提示的生词：句子里出现用户没学过的词，导致看不懂题干。

### 6.4 示例

```json
{
  "id": "r1-2",
  "point": "responsible for",
  "translation": "我负责前端。",
  "segments": [
    "I am responsible ",
    { "blank": "b1", "answers": ["for"] },
    " the frontend."
  ],
  "note": "be responsible for + 名词"
}
```

---

## 7. 讲解规则（agent 侧）

- **只讲错题**；正确的只在开头报数（“6 空对 4”）。
- 每个错题固定四段：
  1. 原句（用 `given` 回填，让用户看到自己写的版本）
  2. 你的答案 → 正确答案
  3. 为什么（规则 / 语义 / 搭配，一两句）
  4. 常见错法（一句，指出用户这次的错因）
- 结尾一张小表：`考点 | 对/错 | 一句话结论`，方便复制进复习笔记。
- 全对：一句话收尾（“6 空全对，本轮结束”），不硬讲。
- 判分误杀：在讲解里明确说“你这句其实也对”，不要顺着错误判分讲。

示例：

```
6 空对 4，错 2：

③ The bug (in) fixed yesterday. → was
   被动：be + 过去分词。主语 the bug 是“被修”，所以 was fixed；
   yesterday 只决定时态是过去，不决定语态。
   你的错法：把被动漏了，直接按过去时填。

⑤ We (have) deployed it last Friday. → deployed
   不是时态难，是信号词冲突：last Friday 是明确过去时间，
   不能和现在完成时连用。
```

---

## 8. 巩固规则（agent 侧）

用户点“巩固这 N 个错点”后，agent 收到一条用户消息（含错点清单），按**错误类型分流**：

| 错误类型 | 判断依据 | 巩固方式 |
|---|---|---|
| 形式错 | `given` 与 `expected` 只差形式（deploy / deployed） | 一句规则提示 + 同考点新语境（不考规则本身） |
| 选择错 | 同类竞争项（in / on / at、for / since、was / is） | 最小对立对：同一句位放两个候选，逼用户分辨 |
| 语义错 | 填了另一个句意也通的词 | 先确认能不能接受；不能接受再讲语义边界 |
| 同点连错 2 次 | 统计上一组 + 本组 | 降难度：单空 + 显式线索（last Friday → 过去时） |
| 同点连错 3 次 | 跨组累计 | 停止刷题，切“教”模式：规则 + 2 个例句，读完再练 |

其他约束：

- 巩固组仍是 4–6 句、总空 ≤ 8。
- 新语境，不换零件重复；至少一半句子和原题场景不同。
- 每个错点给 2 个新例句 + 1 个对比项。
- 可加 1 个“对照组”题（上一组做对的同考点），防止只盯着错点。
- 全对：收尾，不硬凑。

---

## 9. 技术架构

### 9.1 Host 半

- **服务**：`englishQuiz`
  - `start(agent, call)`：登记 `callId → { agent, set, deadline }`，返回 Promise。
  - `submit(callId, answers)`：校验、判分、写结果、resolve。
  - `cancel(callId, reason)`：resolve 为 `cancelled`。
  - 超时：`timeoutSec` 到点自动 cancel。
- **工具** `english_quiz`：
  - 校验入参 → `setId` → 调 `start()` 阻塞等待 → 返回 4.2 的结果。
  - 同一会话同时只允许一个待答卡；已有则返回错误。
- **判分**：见 §5，纯函数，便于单测。
- **投影**：`englishQuiz` 会话投影（`stateVersion: 1`）从 `tool/call` / `tool/result` 推出 `phase`，`wire.view` 给浏览器；`review` 的关闭由服务内存状态决定。
- **进度记录（P2）**：`tools/.cache/quiz-progress.jsonl`，字段 `ts / sessionId / setId / point / itemId / blankId / given / expected / ok / skipped / ms`。只读 Anki 数据，不写回。

### 9.2 Client 半

- 在 `conversation.composer` chain 槽注册 `select`：有 `answering` / `review` 状态时接管输入区；渲染卡片组件。
- 组件不写 DOM、不碰其他插件；用 `--dsw-alias-*` token，文案走 locale。
- 提交动作把 `{ callId, answers: [{ itemId, blankId, given }] }` 送到 Host。

### 9.3 回传通道（已定）

实现选择 **B：同源 HTTP 路由**。

- 路由：`POST /plugins/english-quiz/submit`
- 请求：`{ callId, answers: [{ itemId, blankId, given }] }`；取消用 `{ callId, cancel: true }`
- 响应：`{ ok: true, result }`，或 `{ ok: false, error }`
- 不写 nonce：路由只在 `pending` 里有该 callId 时接受，且同一会话只允许一张待答卡。本机单用户场景接受这个强度；不要把这个插件暴露到不可信网络。
- 没有聊天记录污染，也不需要生成的 Remote 代理。

### 9.3.1 已验证 / 未验证

已验证（本机 + 浏览器）：

- `apply` 注册了 `english_quiz` 工具。
- 参数校验生效：3 条句子返回 `items must contain 4-6 sentences, got 3`。
- 阻塞与取消生效：abort 后返回 `{ status: "cancelled", reason: "aborted" }`。
- 安装结果 `application: applied`，`list_plugins` 显示 `english-quiz` 为 active，工具列表里出现 `english_quiz`。
- 卡片接管输入区、多空一次提交、判分结果渲染、提交路由返回：2026-11-23 实测通过。
- 段落模式：1 段 7 空，一次提交，判分正常。
- 发音：小喇叭朗读连贯（答题态读当前填写内容），×1 / ×0.8 / ×0.5 语速切换通过。
- 巩固按钮：生成并回到 agent，下一组正常出卡。

尚未验证 / 已知限制：

- 深色/浅色主题、窄屏布局没有逐项验证。
- 刷新页面会丢未提交草稿；结果卡刷新后消失。
- 浏览器没有英文语音时小喇叭不出声。
- 超时自动取消只做了本机 abort 冒烟，未等满 600 秒实测。

### 9.4 超时、取消、断线

- 默认 600 秒；到点 resolve `cancelled/timeout`，卡片关闭。
- “结束”按钮 → `cancelled/user`。
- 浏览器断线：Host 继续等；重连后若仍在等，卡片恢复；若已超时，就没了。
- 用户在别的会话里：不显示本会话的卡片（session 作用域）。

---

## 10. 文件布局（已实现）

```
plugins/english-quiz/
  package.json        # bundle patch + dsh.client
  cordis.patch.yml    # 插入 english-quiz 一行，Host/Client 同包
  index.js            # Host：工具、待答表、判分、投影、提交路由
  client.js           # Client：composer 接管、卡片、pending interaction
  locale/
    zh.json
    en.json
  docs/
    DETAIL.md
  icon.svg
  DESIGN.md           # 本文
  README.md
```

---

## 11. P1 任务清单

### 0. 回传通道 spike

- [x] 选定同源 HTTP 路由 `/plugins/english-quiz/submit`
- [x] 结论写入 §9.3

### 1. Host

- [x] `english_quiz` 工具 + 入参校验
- [x] 待答表、超时、取消
- [x] 判分纯函数（归一化、备选答案、逐空、按点汇总）
- [x] 工具结果结构（§4.2）
- [x] 会话投影 + `wire.view`（`englishQuiz`）

### 2. Client

- [x] composer chain 注册与状态选择
- [x] 答题卡片（句子 + 行内 input + 翻译 + 提交栏）
- [x] 键盘导航、IME、焦点
- [x] 结果态（逐空着色、你的答案/正确答案）
- [x] 三个按钮：巩固 / 换一组 / 结束

### 3. Agent 侧规则

- [x] 工具描述：何时调用、入参约束
- [ ] skill：出题规则（§6）、讲解规则（§7）、巩固规则（§8）——当前压进工具描述，P1.5 再拆

### 4. 插件外壳

- [x] `package.json`、`cordis.patch.yml`、locale、`DETAIL.md`、`icon.svg`、`README.md`
- [x] `plugin_manager` 安装（`application: applied`，active）

### 5. 验收

- [x] 出题 → 填 → 提交 → 判分 → 结果 → 巩固，完整走通（句子 + 段落均实测）
- [ ] 超时、主动结束
- [ ] 深/浅色、窄屏
- [ ] 中文输入法回车不误触
- [ ] 刷新页面后行为符合 §9.4
- [x] 讲解只讲错题；全对时不硬讲

---

## 12. 风险

1. **回传通道**可能没有干净方案；保底 C 会多一条用户消息，可接受但不够优雅。
2. **composer 接管**的 props、焦点和关闭行为必须照现有提问卡实现，自绘会不一致。
3. **判分误杀**：本地判分可能把可接受的写法判错；必须有改判出口，且不能因为改判让用户觉得“系统在讨好人”。
4. **出题质量**依赖 agent 遵守 §6；若漂移，会出歧义空或超纲词。工具校验能挡住格式，挡不住语义。
5. **长会话**里结果卡和讲解可能错位；结果卡只在当前会话、内存中保留，接受。

---

## 12.1 v0.2：发音与段落模式（已实现）

### 发音

- 用浏览器自带的 `window.speechSynthesis`，不生成音频文件，也不走 Host。
- `lang = en-US`，`rate = 0.92`；优先选 Samantha / Alex / Google US English / Aria，找不到就退回任意英文语音。
- 答题态：小喇叭朗读用户当前填写的句子/段落（空白处自然停顿），不泄题；填完即连贯。
- 结果态：小喇叭朗读填入首选正确答案后的完整句子/段落。
- 语速：卡片头部的 `×1 / ×0.8 / ×0.5` 选择器，全局生效，存入 `localStorage`（键 `dsh-english-quiz.rate`）。
- 2026-11-23 用户验证：朗读连贯；语速控制通过。
- 切换卡片或重新提交时取消上一段朗读；按钮点击不抢输入框焦点。
- 限制：浏览器没有英文语音时不出声；不同系统的音色不同。

### 段落模式

- 工具新增 `mode: 'sentences' | 'passage'`，默认 `sentences`。
- 段落模式：恰好 1 个 item（一整段），3–10 个单词空，一段完整中文翻译，`segments` 里用 `\n` 分行。
- 卡片隐藏题号，用段落排版（`white-space: pre-wrap`），一个“段落 / N 空”的表头；小喇叭在表头朗读整段。
- 校验：段落模式 1 段、3–10 空、正文 ≤ 900 字符、翻译 ≤ 600 字符；句子模式仍是 4–6 句、每句 1–2 空、总空 ≤ 8。

### 自由表达（v0.3）

- 工具新增 `mode: 'prompt'`；不需要 `items`，改传：
  - `prompt`：中文主题/指令（≤ 600 字符），例如“用英语介绍你自己，并说明你平常工作用什么技术栈”。
  - `requirements`：可选，最多 6 条短要求。
  - `minWords`：可选，建议最低词数（10–300）。
- 卡片：标题、主题、要求列表、大 `textarea`、实时词数；`Cmd/Ctrl+Enter` 提交。
- 提交走同一路由的 `{ callId, text }` 分支；Host 返回 `{ text, wordCount, durationMs }`，不做本地判分。
- 结果卡：显示用户原文、词数、朗读按钮（读用户自己的答案）、语速控制；按钮“换一个主题 / 结束”。
- agent 反馈规则：先看内容是否覆盖主题，再给 2–3 条具体修改（引用原句），最后给一个用用户已学词汇写成的简短示范；不逐字挑错。
- 限制：语义点评依赖 agent；没有本地分数；字数只是建议。

### 翻译（v0.4）

- 工具新增 `mode: 'translate'`；传 `prompt`（中文原句，≤ 300 字符）、`answers`（1–4 个可接受译法，第一个是首选）、可选 `hint` / `note`。
- 卡片：中文原句 + 可选提示 + 单行输入；`Enter` 提交；`Cmd/Ctrl+Enter` 同样提交。
- 提交走同一路由的 `{ callId, text }` 分支：整句归一化比对（大小写、空白、全半角、句末标点、缩写），命中任一 `answers` 即正确。
- 返回：`{ prompt, given, expected, ok, note }`；结果卡显示正确/错误、你的答案、参考答案、朗读正确句、语速；按钮“换一句 / 结束”。
- agent 反馈：错句讲具体差异（时态 / 语序 / 介词 / 冠词 / 拼写）；正确则一句肯定，必要时给更自然的说法。
- 限制：只接受登记过的译法；同义改写不会自动判对，靠 agent 在聊天里改判。

### 混排（v0.5）

- `sentences` 模式的 item 增加 `kind: 'blank' | 'translate'`（默认 blank）；一张卡 4–6 项，建议至少 1 个填空 + 1 个翻译。
- 翻译项字段：`prompt`（中文）、`answers`（1–4 个可接受译法）、可选 `hint` / `note`；不参与总空数。
- 填空项仍是 1–2 空/项，总空 ≤ 8。
- 卡片：模式标“混合”，表头显示“N 项 / X 空 + Y 译”；填空题和翻译输入框共用一个 Tab/Enter 顺序。
- 提交：`{ answers, translations }`；Host 按 item.kind 分别判分，返回 `score.items / itemsCorrect / blanks / totalBlanks / translations / totalTranslations`。
- 结果卡：填空项逐空着色，翻译项显示“你的答案 / 参考答案”；错点数包含两类；“巩固”清单同时列出空错和译错。
- agent 反馈：同一段里同时讲填空差异和翻译差异，不分开两轮。
- 2026-11-23 用户验证：混排卡 2 填空 + 2 翻译，4/4 一次提交通过。

### 进度与统计（v0.6）

- 每次提交后，Host 把每个空/翻译项追加到 `<workspace>/progress/quiz-log.jsonl`；单条字段：
  `ts / sessionId / setId / mode / kind / point / prompt / given / expected / ok / spelling`。
- 保留最近 2000 条：超过后重写文件保留最后 2000 行；写入用进程内队列串行化。
- `english_progress` 工具：`summary` 返回总次数、正确率、拼写数、按考点统计、最近错题；
  `wrong` 返回最近错题，供“只练错题”生成新语境。
- 系统提示新增一小节：开练前先调 `english_progress summary`，按薄弱点出题。
- `GET /plugins/english-quiz/stats` 返回聚合结果；卡片头部的柱状图按钮打开统计面板
  （总次数 / 正确率 / 拼写 / 按考点表 / 最近拼写）。
- 拼写错：`looksLikeSpelling` 对 ≥5 字母、编辑距离 ≤1（或 ≥8 字母时 ≤2）的错答标 `spelling: true`；
  仍然是 `ok: false`，只单独记录、黄色显示，不自动改判。翻译整句和自由表达不标拼写。
- 限制：日志在本地、只读不写回 Anki；没有词典守卫，拼写标记可能有少量误报。

### 英语统计页（v0.7）

- 入口：`conversation.view` 页签「英语统计」，与「对话」「轨迹」「统计」并列；移除卡片头部的统计按钮和输入框下方的胶囊。
- 设计：Hallmark 2.0.0 app screen，使用 DSH host tokens（不导入 Hallmark 主题，避免与宿主表面冲突）；静态 `sloplint --scope app` 结果为 0 FAIL / 0 REFLEX / 0 WARN。
- 内容：大号总正确率（correct / scored）＋ 练习组数、答题次数、连续练习、待巩固；14 天答题柱状图；考点明细表（状态 / 正确率 / 答题 / 拼写 / 最近）；「接下来练」最多 3 个薄弱点，支持复制练习清单；最近错题、拼写记录；加载 / 空 / 错误 / 完整四态。
- 数据：`summarize` 新增 `sets / activeDays / streak / firstPracticed / daily`（14 天，本地日期）；日志字段不变。
- 空状态不伪造数字；所有统计来自 `progress/quiz-log.jsonl`。
- 页签标签「英语统计」，页面标题同；CSS 顶部保留 Hallmark stamp 和 pre-emit critique。

### Anki 复习导入（v0.8）

- `tools/import_anki_stats.py`：复制 Anki collection（含 WAL）到临时目录再读，不锁 Anki、不修改原库；可用 `--db` / `--out`。
- 统计口径：`Again`（ease 1）算未通过；`Hard / Good / Easy` 算通过；`last14` / `last30` 按 14 / 30 个自然日；`daily` 为 14 天；`decks` 取近 30 天前 5。
- JSON 字段：`version / generatedAt / source / definition / total / last14 / last30 / daily / decks`；`total` 含累计复习、学习库卡片/笔记数、首次/最近复习时间。
- Host 统计路由读取 `progress/anki-stats.json`，返回 `stats.anki`；`english_progress summary` 附带紧凑的 anki 块。
- 页面新增「Anki 复习」面板：14 天复习张数、通过率、Again、学习时长、14 天柱状图、主要 deck；与插件答题统计分开，不混算。
- 刷新页签只重读 JSON；Anki 有新复习要重跑脚本；面板显示导入时间。
- Hallmark `sloplint --scope app` 带 Anki 面板的预览仍为 0 FAIL / 0 REFLEX / 0 WARN。

---

## 13. 后续阶段

- **P1.5**：草稿持久化、断线重连、刷新不丢答案。
- **P2**：`quiz-progress.jsonl`、跨会话错点统计、“只练上轮错题”、单空 TSV 卡导入（只读）。
- **P3**：~~发音~~（v0.2 已用浏览器 TTS 实现）、~~段落模式~~（v0.2 已实现）、提示展开、单空“讲讲为什么”按钮、统计页。
- **可选**：同一错点反复错时，导出成 Anki 新卡（走现有 `cards/*.tsv` → `out/*.apkg` 流程）。

---

## 14. 待定问题

1. 回传通道选 A / B / C（spike 决定）。
2. `timeoutSec` 默认 600 秒是否合适。
3. 卡片结果态刷新后消失，是否可接受。
4. 讲解是否要带音标/发音（P3）。
5. “换一组”是换同考点的新题，还是换考点（默认同考点）。

---

## 15. 变更记录

| 日期 | 变化 |
|---|---|
| 2026-11-23 | 初稿：多空卡片、模型现场出题、只讲错题、按错因巩固 |
| 2026-11-23 | v0.2：小喇叭发音（浏览器 TTS）、段落模式（1 段 3–10 空） |
| 2026-11-23 | v0.2.1：答题态改读当前填写内容；v0.2.2：小喇叭旁加 ×1 / ×0.8 / ×0.5 语速控制；用户验证通过 |
| 2026-11-23 | v0.3.0：新增自由表达（一个主题 + 大输入框，agent 语义点评） |
| 2026-11-23 | v0.4.0：新增翻译（一句中文 + 单行输入，整句归一化判分） |
| 2026-11-23 | v0.5.0：句子模式支持填空 + 翻译混排（同一张卡一次提交） |
| 2026-11-23 | v0.6.0：progress/quiz-log.jsonl、english_progress 汇总、统计面板、拼写单独标记 |
| 2026-11-23 | v0.7.0：英语统计页签 + Hallmark 重做统计页（总账、14 天、考点表、接下来练、错题/拼写） |
| 2026-11-23 | v0.8.0：Anki revlog 导入（progress/anki-stats.json）+ 统计页 Anki 复习面板 |
| 2026-11-23 | v0.8.1：修复题目 id 为空/重复时翻译输入框共用同一状态、所有输入框同步的问题；输入状态改按题目位置键 |
| 2026-11-25 | v1.0.0：公开发布到 npm `dsh-english-quiz`；Anki 导入脚本随包，README 增加安装说明 |
| 2026-11-26 | v1.0.0：结果卡增加答案差异标红（缺词/缺字母红色加粗，多余/错误字符删除线） |

---

## 附录 A · 参考文件

- `PROGRESS.md` —— 语法进度与“已覆盖 / 薄弱 / 空白”清单
- `RECORDED.md` —— 已记录单词与句子
- `cards/*.tsv` —— 现有 Anki 卡片源（P2 才读）
- `AGENT.MD` —— 制卡规范与工具链
- `plugins/english-quiz/DESIGN.md` —— 本文
