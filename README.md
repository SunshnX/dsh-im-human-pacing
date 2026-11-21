# dsh-im-human-pacing

让 IM 机器人**像真人一样分多条回复**：由模型决定一条答案拆成几条，插件按「打字 + 看消息」的节奏逐条发出。

默认只作用于**微信**（`weixin`）渠道，与 [`@xmanrui/dsh-im`](https://github.com/xmanrui/dsh-im) 配合使用。

> English summary: a DeepSeek Harness plugin that lets the model split one reply into several chat bubbles and sends them with human-like typing pauses. WeChat is the verified channel.

## 它解决什么

默认情况下，一轮回答只发一条消息，几百字一次性丢过来，读起来像公告，不像聊天。

装上本插件后：

1. 在微信会话里，模型会在回答前调用 `dsh_im_say`，把回答拆成 2–8 条短气泡。
2. 插件立即发出**除最后一条以外**的所有气泡，每条之前等待一段按字数计算的停顿。
3. **最后一条由模型自己作为最终回复发出**，所以不会重复发送，也不会丢内容。

## 节奏怎么算

每一条气泡发送前等待：

```
等待 = 打字时间 + 阅读时间，且不少于距上一条的 minGapMs
打字时间 = 该气泡的「可视单位」× msPerUnit（夹在 typingMinMs..typingMaxMs）
阅读时间 = readingMinMs..readingMaxMs 之间的随机值
```

「可视单位」按内容类型折算：一个汉字（或假名、韩文、emoji）记 1，拉丁字母和数字记 0.55，空格记 0.12。所以同样字数的中文比英文停得久，符合实际打字手感。

另外，每个对话有独立的**滚动一分钟发送上限**（`maxMessagesPerMinute`），接近上限时会自动把间隔拉长，避免被微信限流。

## 安装

在 DSH 的「插件 → 添加插件」里选择本目录，或在终端执行：

```sh
dsh plugin --profile desktop add -w <本目录绝对路径>
```

安装后重启 DSH，然后让微信机器人回一条长一点的消息即可看到效果。

## 自检

想单独确认节奏而不依赖模型，把 `selfTest` 设为 `true` 并重启 Host，然后在任意会话里让模型调用 `dsh_im_pacing_selftest`。它会向该机器人最近的私聊目标发 3 条演示气泡（前两条由工具发出，第三条作为最终回复），并报告每条的等待毫秒数。

## 开发

```sh
node --test test/            # 纯规则 + 插件行为，共 24 个用例
```

`lib/pacing.js` 是不依赖 Node 内置模块的纯函数模块，想调节奏算法直接改这里；`index.js` 是 Host 插件入口，负责把规则变成真实的等待与发送。

## 目录结构

```
index.js             Host 插件入口（工具、提示词、监听）
lib/pacing.js        节奏与分段规则（纯函数）
test/                单元测试
cordis.patch.yml     插件行与默认配置
locale/              插件在设置页里的标题与说明
docs/                详情页文档与配图
icon.svg             插件图标
```

## 配置

在 `cordis.patch.yml` 里改这条插件行的 `config`，保存后重启 Host 生效。

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `channels` | `['weixin']` | 生效的渠道；改成 `['weixin','feishu']` 即可扩到其他渠道（需该渠道支持主动投递） |
| `msPerUnit` | `220` | 每个可视单位的打字毫秒数 |
| `typingMinMs` / `typingMaxMs` | `700` / `6000` | 单条气泡打字时间下限/上限 |
| `readingMinMs` / `readingMaxMs` | `250` / `1400` | 额外的「看消息」随机停顿范围 |
| `minGapMs` | `900` | 同一对话两条之间的硬下限 |
| `maxDelayMs` | `15000` | 单次等待的硬上限，防止长气泡卡住整轮 |
| `maxSegmentsPerTurn` | `8` | 一轮最多发几条 |
| `maxCharsPerSegment` | `500` | 单条气泡字符上限，超了工具会让模型拆得更短 |
| `maxMessagesPerMinute` | `20` | 每个对话滚动一分钟内的发送上限 |
| `selfTest` | `false` | 打开后额外注册 `dsh_im_pacing_selftest` 自检工具 |

> 想更像「慢慢打字」，把 `msPerUnit` 调到 300–400；想更利落，调到 120–150。

## 限制

- 只在**已启用渠道的 IM 会话**里提供工具；Web、CLI、桌面端会话不会看到它，行为完全不变。
- 目前已验证微信私聊（`p2p:<id>`）的发送路径。其他渠道需要在 `channels` 里显式启用，并存放在该渠道的目标推导范围内；未验证的渠道会明确报错而不是乱发。
- 「打字」与「阅读」是**模拟时间**，微信端不会真的显示逐字打字过程。
- 关闭插件即恢复「一轮一条长回复」的默认行为，会话状态不受影响。
