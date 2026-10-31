# dsh-api-gateway

给 DSH 开一个**本地 OpenAI 兼容接口**。外面任何会说 OpenAI 协议的东西 —— 手机上的 Chatbox、Cherry Studio、别的 AI、Python 脚本、自动化流程 —— 都能直接跟 DSH 里的伙伴说话。

和普通「套一层模型 API」不一样的地方：请求是**投进 DSH 的真实会话**里跑的。所以她记得上一句，会用自己的记忆、人格、工具，也照常出现在你在 DSH 里看到的那个对话框里。

## 地址

启动 DSH 后：

```
http://127.0.0.1:18910/v1/chat/completions
http://127.0.0.1:18910/v1/models
http://127.0.0.1:18910/health
```

- 模型名：`dushihuan`（随便填也能用，只是给客户端一个可选项）
- 鉴权：`Authorization: Bearer <令牌>`
- 令牌在第一次启动时随机生成，写在 `~/.dsh/api-gateway-config.json`

## 配置

`~/.dsh/api-gateway-config.json`（第一次启动自动生成）：

| 键 | 默认 | 说明 |
|---|---|---|
| `开` | `true` | 关掉就不起服务 |
| `主机` | `127.0.0.1` | 只给本机用就是这个。要手机连就改 `0.0.0.0`（**同时务必留着令牌**） |
| `端口` | `18910` | 换个不冲突的也行 |
| `令牌` | 自动生成 | 填 `"off"` = 不鉴权（只建议本机自己用） |
| `默认会话` | `""` | 空 = 用当前打开的第一个会话。建议单独开一间会话给它，别和主人的聊天混在一起 |
| `超时秒` | `180` | 等一轮回复最多多久 |
| `模型名` | `dushihuan` | `/v1/models` 里露出来的名字 |
| `允许来源` | `*` | CORS |

## 用

curl：

```bash
curl http://127.0.0.1:18910/v1/chat/completions \
  -H "Authorization: Bearer <令牌>" \
  -H "Content-Type: application/json" \
  -d '{"model":"dushihuan","messages":[{"role":"user","content":"在吗"}]}'
```

Python（openai SDK）：

```python
from openai import OpenAI
c = OpenAI(base_url="http://127.0.0.1:18910/v1", api_key="<令牌>")
print(c.chat.completions.create(
    model="dushihuan",
    messages=[{"role": "user", "content": "在吗"}],
).choices[0].message.content)
```

指定会话（多客户端各聊各的）：

```bash
curl http://127.0.0.1:18910/v1/chat/completions \
  -H "Authorization: Bearer <令牌>" \
  -H "X-DSH-Session: session-xxxx" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"你好"}]}'
```

`/health` 会列出当前活着的会话 id，配 `默认会话` 或 `X-DSH-Session` 时照着抄。

## 几个实话

- **会话必须开着**。DSH 只给「在内存里的会话」提供 agent，没打开过的会话投不进去，会返回一句明确的错。先在 DSH 里把目标会话点开。
- **同一会话的请求是排队的**，不会两个请求互相踩。但如果你自己也在那个会话里打字，可能串到同一个回合 —— 所以建议单独开一间 API 会话。
- **流式是「伪流式」**：等这一轮跑完，一次性按 SSE 吐出来。客户端能正常显示，只是不是逐字蹦。
- **`usage` 里的 token 数是 0**：DSH 不在这个位置暴露用量。要算账去看模型通道那边的账本。
- 这个插件只做「本机 → DSH」。要让它从公网可达，自己配反代和 HTTPS，别把 `0.0.0.0` + 无令牌直接摊在网上。

## 装 / 卸

已经装在 `~/.dsh/profiles/desktop/node_modules/dsh-api-gateway`，并在 profile 的 `bundles` 里登记为 `dsh-api-gateway`。

停用：把 `api-gateway-config.json` 里的 `开` 改成 `false`，或者从 `bundles` 里删掉这一行。
