# dsh-turn-cost-pill · 上次花费

> DeepSeek Harness (dsh) 插件：在输入框「权限」按钮的右侧，显示**当前会话最新一次交互（自你最后一次发消息起）花了多少钱**。
> A DSH plugin that shows what the current session's latest exchange cost, right beside the composer's permission control.

- 一轮跑完后显示「上次 ¥0.0123」；这一轮还在跑时显示「本轮 ¥0.0041」并带绿色小圆点，金额随每一步请求结算实时增长。
- 悬停可看到明细：未缓存输入 / 缓存命中 / 输出 token 数与实际使用的模型。
- 数据来自会话日志里提供方上报的每一次计费请求用量，按「回合 + 步」归并；重试过的计费尝试同样计入。
- 金额按 DeepSeek 官方峰谷价折算成人民币（空闲价：Flash 缓存命中 0.02、未命中输入 1、输出 4 元/百万 tokens；Pro 0.15 / 4.5 / 13.5；高峰时段 ×2）。非 DeepSeek 官方模型没有内置价目，回退 Flash 价并标注 `≈`。
- Host 侧只注册一个会话投影，不发起任何模型请求，不采集、不上传任何数据。

## 安装

从 GitHub 安装（把 `owner` 换成仓库所有者）：

```sh
dsh plugin --profile web add github:<owner>/dsh-turn-cost-pill
```

装完刷新页面即可在输入框工具行看到金额胶囊（在「权限」按钮右侧）。

卸载：

```sh
dsh plugin --profile web remove dsh-turn-cost-pill
```

## 计价口径

- token 来源：会话日志里每次计费请求的 `assistant/message` / `assistant/attempt` 用量，按「回合 + 步」归并；重试的计费尝试同样计入。
- 价格：DeepSeek 官方价目（元 / 百万 tokens），空闲时段 Flash 为 缓存命中 0.02、未命中输入 1、输出 4；Pro 为 0.15 / 4.5 / 13.5。高峰时段（北京时间工作日 09:00–12:00、14:00–18:00，不含法定节假日）价格 ×2。
- 缓存写入按未命中输入价计；金额四舍五入到 6 位小数后再展示。
- 价目与节假日表在 `index.js` 顶部，官方调价后改这里即可。

## 结构

| 文件 | 作用 |
| --- | --- |
| `index.js` | Host 半边：注册会话投影 `turnSpend`，把每轮用量折算成金额（`wire.view`）。 |
| `client.js` | 浏览器半边：在 `conversation.input.left` 注册金额胶囊（紧跟权限/计划按钮之后）。 |
| `cordis.patch.yml` | 向 profile 插入 `turn-cost-pill` Loader 行。 |
| `locale/*.json` | 插件管理页的标题与描述。 |
| `icon.svg` / `assets/icon-180.png` | 插件图标与市场卡片图标（原创）。 |

## 局限

- 只统计**模型请求**的 token 花费，不含图片附件等按次计费项（DeepSeek 当前无此项）。
- 如果某个提供方没有上报 usage（例如请求在中途被强杀），这一步不会出现在金额里——会话日志里没有可用的计费数据。
- 金额是「按官方价目折算的估算」，不是账单原值；实际扣费以 DeepSeek 账单为准。
