/**
 * dsh-api-gateway —— 把 DSH 里的伙伴接成一个本地 OpenAI 兼容接口。
 *
 * 为什么这么做：
 *   DSH 本身是个桌面应用，外面（手机上的 Chatbox、别的 AI、脚本、自动化）没法直接跟它说话。
 *   这个插件在 DSH 进程里起一个本地 HTTP 服务，把请求翻译成「往某个会话里投一句话」，
 *   再把这一轮的回复收回来，按 OpenAI 的格式还回去。
 *
 *   好处是：对话 history 留在 DSH 自己的会话里 —— 她记得上一句，不是无状态的一次性接口。
 *
 * 配置写在 ~/.dsh/api-gateway-config.json（第一次启动会自动生成，含随机令牌）。
 * 默认地址：http://127.0.0.1:18910/v1/chat/completions
 */

import http from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { randomUUID, randomBytes } from 'node:crypto'

export const name = 'dsh-api-gateway'
/** 需要宿主提供 agents（投消息 + 取回会话）。 */
export const inject = ['agents']

const 家目录 = process.env.DSH_HOME || join(homedir(), '.dsh')
const 配置路径 = join(家目录, 'api-gateway-config.json')

const 默认配置 = {
  开: true,
  主机: '127.0.0.1',
  端口: 18910,
  令牌: '', // 空 = 首次启动自动生成；填 "off" = 不鉴权（只建议本机自己用）
  默认会话: '', // 空 = 用当前打开着的第一个会话
  超时秒: 180,
  模型名: 'dushihuan',
  允许来源: '*',
}

let 缓存配置 = null

function 读配置() {
  if (缓存配置) return 缓存配置
  let 盘 = {}
  try {
    盘 = JSON.parse(readFileSync(配置路径, 'utf8')) || {}
  } catch (error) {
    /* 第一次跑，没有就算了 */
  }
  const 合 = { ...默认配置, ...盘 }
  if (!合.令牌) {
    合.令牌 = 'dsh-' + randomBytes(18).toString('hex')
    try {
      writeFileSync(配置路径, JSON.stringify(合, null, 2) + '\n', 'utf8')
    } catch (error) {
      /* 写不下去就只在内存里用 */
    }
  }
  缓存配置 = 合
  return 合
}

// ---------- 小工具 ----------

const 去前缀 = (id) => String(id == null ? '' : id).replace(/^session-/, '')

/** 带 / 不带 `session-` 前缀两个方向都试（照 qq-link / speak-up 的写法）。 */
function 找agent(ctx, id) {
  const 原 = String(id == null ? '' : id).trim()
  if (原 === '') return undefined
  const 候选 = [原]
  if (原.startsWith('session-')) 候选.push(原.slice('session-'.length))
  else 候选.push('session-' + 原)
  for (const 一个 of 候选) {
    try {
      const a = ctx.agents.get(一个)
      if (a !== undefined && a !== null) return a
    } catch (error) {}
  }
  return undefined
}

/** 活着的会话清单（给 /health 看，方便配默认会话）。 */
function 列会话(ctx) {
  const 出 = []
  try {
    const 表 = typeof ctx.agents.list === 'function' ? ctx.agents.list() : []
    for (const a of 表 || []) {
      const id = (a && a.session && a.session.id) || (a && a.id) || ''
      if (!id) continue
      let 标题 = ''
      try {
        标题 = String((a.session && a.session.title) || a.title || '')
      } catch (error) {}
      出.push({ id: String(id), 标题 })
    }
  } catch (error) {}
  return 出
}

/** 从一条 assistant 消息里只抽正文（reasoning / 图片都不要）。 */
function 抽正文(message) {
  const c = message && message.content
  if (typeof c === 'string') return c.trim()
  if (!Array.isArray(c)) return ''
  return c
    .filter((x) => x && x.type === 'text' && typeof x.text === 'string')
    .map((x) => x.text)
    .join('\n')
    .trim()
}

/** 从 OpenAI 的 messages 里取最后一条 user 的正文。 */
function 取最后一句(messages) {
  if (!Array.isArray(messages)) return ''
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (!m || (m.role !== 'user' && m.role !== 'system')) continue
    if (m.role === 'system') continue
    const c = m.content
    if (typeof c === 'string') return c.trim()
    if (Array.isArray(c)) {
      return c
        .filter((x) => x && (x.type === 'text' || x.type === 'input_text') && typeof x.text === 'string')
        .map((x) => x.text)
        .join('\n')
        .trim()
    }
  }
  return ''
}

function 读体(req) {
  return new Promise((resolve, reject) => {
    let b = ''
    let 超了 = false
    req.on('data', (d) => {
      if (超了) return
      b += d
      if (b.length > 8 * 1024 * 1024) {
        超了 = true
        reject(new Error('请求体超过 8MB'))
        try {
          req.destroy()
        } catch (error) {}
      }
    })
    req.on('end', () => {
      if (!超了) resolve(b)
    })
    req.on('error', (e) => {
      if (!超了) reject(e)
    })
  })
}

// ---------- 主体 ----------

export function apply(ctx) {
  const 配置 = 读配置()
  if (配置.开 === false) {
    try {
      ctx.logger?.info('api-gateway: 配置里关着（开=false），不启动')
    } catch (error) {}
    return
  }

  /** 会话键 → 当前正在等回复的那一个 job */
  const 活动 = new Map()
  /** 会话键 → { 忙, 等[] } —— 同一个会话的请求排队，不互相踩 */
  const 队列 = new Map()
  const 日志 = []
  let 请求数 = 0

  const 记账 = (文本) => {
    const d = new Date()
    const 补 = (n) => String(n).padStart(2, '0')
    日志.push({ 时间: `${补(d.getHours())}:${补(d.getMinutes())}:${补(d.getSeconds())}`, 文本 })
    if (日志.length > 50) 日志.shift()
    try {
      ctx.logger?.info(`api-gateway: ${文本}`)
    } catch (error) {}
  }

  /** 把一句话投进会话，等这一轮结束，把回复文本还回去。 */
  function 投递(会话id, 文本, 超时秒) {
    return new Promise((resolve, reject) => {
      const 键 = 去前缀(会话id)
      let q = 队列.get(键)
      if (!q) {
        q = { 忙: false, 等: [] }
        队列.set(键, q)
      }

      const 下一个 = () => {
        const n = q.等.shift()
        if (n) n()
      }

      const 跑 = () => {
        q.忙 = true
        const job = {
          文本们: [],
          计时: null,
          收尾: false,
          完成: null,
          失败: null,
        }

        const 完 = (结果, 错) => {
          if (job.收尾) return
          job.收尾 = true
          try {
            clearTimeout(job.计时)
          } catch (error) {}
          if (活动.get(键) === job) 活动.delete(键)
          q.忙 = false
          if (错) reject(错)
          else resolve(结果)
          下一个()
        }

        job.完成 = (t) => 完(t, null)
        job.失败 = (e) => 完(null, e)

        job.计时 = setTimeout(() => {
          完(null, new Error('等待回复超时（' + 超时秒 + ' 秒）'))
        }, Math.max(5, Number(超时秒) || 180) * 1000)

        活动.set(键, job)

        const agent = 找agent(ctx, 会话id)
        if (!agent) {
          完(null, new Error('这个会话现在没有打开的 agent：' + 会话id + '（先在 DSH 里打开它，或者把「默认会话」配成一个开着的会话）'))
          return
        }

        try {
          const r = agent.followup({
            id: randomUUID(),
            role: 'user',
            content: [{ type: 'text', text: String(文本) }],
            source: { kind: 'api' },
          })
          // followup 是 Promise，不接住会变成未处理的 rejection，直接把整个宿主带下去
          Promise.resolve(r).catch((e) => {
            完(null, new Error('投递失败：' + String((e && e.message) || e)))
          })
        } catch (error) {
          完(null, new Error('投递失败：' + String((error && error.message) || error)))
        }
      }

      if (q.忙) q.等.push(跑)
      else 跑()
    })
  }

  /** 盯会话事件：累积这一轮的正文，turn/end 时交差。 */
  function 收事件(session, event) {
    const 键 = 去前缀(session && session.id)
    const job = 活动.get(键)
    if (!job) return

    if (event && event.type === 'assistant/message') {
      const d = event.data || {}
      if (d.interrupted) return
      const 文 = 抽正文(d.message)
      if (文) job.文本们.push(文)
      return
    }

    if (event && event.type === 'turn/end') {
      const d = event.data || {}
      const 原因 = String((d.reason && d.reason.kind) || 'completed')
      const 全 = job.文本们.join('\n\n').trim()
      if (原因 === 'completed' || 全) {
        job.完成(全)
      } else {
        job.失败(new Error('这一轮没走完：' + 原因))
      }
      return
    }

    if (event && (event.type === 'turn/error' || event.type === 'agent/error')) {
      const d = event.data || {}
      job.失败(new Error('这一轮出错：' + String(d.message || d.error || '未知')))
    }
  }

  // 把 完成/失败 挂到 job 上（收事件里用得到）

  const 找到默认会话 = () => {
    if (配置.默认会话) return String(配置.默认会话)
    const 表 = 列会话(ctx)
    if (表.length) return 表[0].id
    return ''
  }

  const CORS = () => ({
    'Access-Control-Allow-Origin': 配置.允许来源 || '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-DSH-Session',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  })

  const 回 = (res, code, obj) => {
    const 文 = typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)
    try {
      res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...CORS() })
      res.end(文)
    } catch (error) {}
  }

  const 鉴权 = (req) => {
    const 令 = String(配置.令牌 || '')
    if (!令 || 令 === 'off') return true
    const 头 = String(req.headers['authorization'] || '')
    const m = /^Bearer\s+(.+)$/i.exec(头.trim())
    if (!m) return false
    return m[1].trim() === 令
  }

  const 服务 = http.createServer(async (req, res) => {
    const 路径 = String((req.url || '').split('?')[0] || '')
    const 方法 = String(req.method || 'GET').toUpperCase()

    if (方法 === 'OPTIONS') {
      try {
        res.writeHead(204, CORS())
        res.end()
      } catch (error) {}
      return
    }

    if (路径 === '/health' || 路径 === '/dsh-api/health') {
      return 回(res, 200, {
        ok: true,
        服务: 'dsh-api-gateway',
        默认会话: 找到默认会话(),
        会话: 列会话(ctx),
        请求数,
        日志,
      })
    }

    if (!鉴权(req)) {
      return 回(res, 401, { error: { message: '令牌不对。请求头要带 Authorization: Bearer <令牌>', type: 'invalid_request_error' } })
    }

    // GET /v1/models —— 让客户端能选到它
    if (方法 === 'GET' && (路径 === '/v1/models' || 路径 === '/models')) {
      return 回(res, 200, {
        object: 'list',
        data: [
          {
            id: 配置.模型名 || 'dushihuan',
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: 'dsh',
          },
        ],
      })
    }

    // POST /v1/chat/completions
    if (方法 === 'POST' && (路径 === '/v1/chat/completions' || 路径 === '/chat/completions')) {
      请求数++
      let 体 = {}
      try {
        const 原 = await 读体(req)
        体 = JSON.parse(原 || '{}')
      } catch (error) {
        return 回(res, 400, { error: { message: '请求体不是合法 JSON：' + String((error && error.message) || error), type: 'invalid_request_error' } })
      }

      const 文本 = 取最后一句(体.messages)
      if (!文本) {
        return 回(res, 400, { error: { message: 'messages 里没有 user 内容', type: 'invalid_request_error' } })
      }

      const 会话 = String(体.session || req.headers['x-dsh-session'] || 找到默认会话() || '').trim()
      if (!会话) {
        return 回(res, 503, { error: { message: '没有可用会话：先去 DSH 里开一个会话，或在 ~/.dsh/api-gateway-config.json 里配默认会话', type: 'server_error' } })
      }

      const 想流式 = Boolean(体.stream)
      const 超时秒 = Number(配置.超时秒) || 180

      try {
        if (想流式) {
          // 先占住头，等这一轮完了一次性发（客户端都能吃）
          try {
            res.writeHead(200, {
              'Content-Type': 'text/event-stream; charset=utf-8',
              'Cache-Control': 'no-cache',
              Connection: 'keep-alive',
              ...CORS(),
            })
          } catch (error) {}
        }
        const 回复 = await 投递(会话, 文本, 超时秒)
        const id = 'chatcmpl-' + randomUUID().replace(/-/g, '').slice(0, 24)
        const created = Math.floor(Date.now() / 1000)
        const 模型 = 配置.模型名 || 'dushihuan'

        if (想流式) {
          const 块 = {
            id,
            object: 'chat.completion.chunk',
            created,
            model: 模型,
            choices: [{ index: 0, delta: { role: 'assistant', content: 回复 }, finish_reason: null }],
          }
          const 尾 = {
            id,
            object: 'chat.completion.chunk',
            created,
            model: 模型,
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          }
          try {
            res.write(`data: ${JSON.stringify(块)}\n\n`)
            res.write(`data: ${JSON.stringify(尾)}\n\n`)
            res.write('data: [DONE]\n\n')
            res.end()
          } catch (error) {}
          return
        }

        return 回(res, 200, {
          id,
          object: 'chat.completion',
          created,
          model: 模型,
          choices: [
            {
              index: 0,
              message: { role: 'assistant', content: 回复 },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        })
      } catch (error) {
        const 话 = String((error && error.message) || error)
        const 码 = /没有打开的 agent|没有可用会话/.test(话) ? 503 : 504
        if (想流式) {
          try {
            res.write(`data: ${JSON.stringify({ error: { message: 话 } })}\n\n`)
            res.write('data: [DONE]\n\n')
            res.end()
          } catch (e) {}
          return
        }
        return 回(res, 码, { error: { message: 话, type: 'server_error' } })
      }
    }

    return 回(res, 404, { error: { message: '没有这个路由：' + 方法 + ' ' + 路径 + '（可用：/v1/models、/v1/chat/completions、/health）', type: 'invalid_request_error' } })
  })

  服务.on('error', (error) => {
    记账('HTTP 服务出错：' + String((error && error.message) || error))
  })

  服务.listen(Number(配置.端口) || 18910, 配置.主机 || '127.0.0.1', () => {
    记账(`已启动 http://${配置.主机 || '127.0.0.1'}:${配置.端口 || 18910}/v1/chat/completions（默认会话：${找到默认会话() || '还没配'}）`)
  })

  ctx.effect(() => {
    const 摘 = ctx.on('session/event', (session, event) => {
      try {
        收事件(session, event)
      } catch (error) {
        记账('收事件出错：' + String((error && error.message) || error))
      }
    })
    return () => {
      try {
        if (typeof 摘 === 'function') 摘()
      } catch (error) {}
    }
  })

  ctx.effect(() => () => {
    try {
      服务.close()
    } catch (error) {}
  })
}
