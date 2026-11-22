// Agent Team（正式前端）—— 侧边栏底部按钮 + 覆盖层抽屉。
//
// 两个标签页：
//   待办   —— 可操作：批准 / 拒绝挂起的派发申请（P3 会加交接申请）
//   消息   —— 只读：组播记录、投递状态、按需加载正文
//
// 数据全部来自同源路由 /agent-team/*（loopback only），不碰会话、不改已读游标。
window.__ModuleLoader__.load({
  id: 'dsh-agent-team',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    // 侧边栏按钮与抽屉分属两棵 React 树，用一个模块级订阅同步两件事：
    // "抽屉开着吗" 与 "面板正在看哪个工作区"。
    const WS_KEY = 'dsh.agent-team.workspace'
    const readWorkspace = () => {
      try {
        return localStorage.getItem(WS_KEY) || null
      } catch {
        return null
      }
    }
    // workspace = 正在看哪个工作区（绝对路径）；null = 不带参数，由服务端回落到配置里的默认工作区。
    const bus = { open: false, seen: 0, workspace: readWorkspace(), listeners: new Set() }
    const notify = () => {
      for (const listener of bus.listeners) listener()
    }
    const setOpen = (value) => {
      bus.open = value
      notify()
    }
    /**
     * 切换面板看的工作区（第 3 步）。
     *
     * 只换视图：此后所有请求都带 `?workspace=`，读的是那个工作区自己的 store。
     * 选择记在 localStorage 里 —— 刷新页面还停在同一个团队，不必每次跳回默认工作区。
     */
    const setWorkspace = (value) => {
      bus.workspace = value || null
      try {
        if (bus.workspace === null) localStorage.removeItem(WS_KEY)
        else localStorage.setItem(WS_KEY, bus.workspace)
      } catch { /* 记不住就这一次，不影响切换 */ }
      notify()
    }
    function useBusValue(key) {
      const [value, set] = useState(() => bus[key])
      useEffect(() => {
        const listener = () => set(bus[key])
        bus.listeners.add(listener)
        return () => bus.listeners.delete(listener)
      }, [key])
      return value
    }
    const useOpen = () => useBusValue('open')
    const useWorkspace = () => useBusValue('workspace')

    const ink = 'var(--dsw-alias-label-primary, #16181d)'
    const dim = 'var(--dsw-alias-label-secondary, rgba(22,24,29,.62))'
    const line = '1px solid var(--dsw-alias-border-l, rgba(127,127,127,.28))'
    const surface = 'var(--dsw-alias-bg-base, #ffffff)'
    const hover = 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))'
    const accent = 'var(--dsw-alias-state-business-primary, #2f6feb)'

    const tone = {
      pending: { color: '#9a6700', background: 'rgba(154,103,0,.12)' },
      held: { color: '#9a6700', background: 'rgba(154,103,0,.16)' },
      delivered: { color: '#0969da', background: 'rgba(9,105,218,.12)' },
      read: { color: '#1a7f37', background: 'rgba(26,127,55,.12)' },
      failed: { color: '#cf222e', background: 'rgba(207,34,46,.12)' },
      approved: { color: '#1a7f37', background: 'rgba(26,127,55,.12)' },
      rejected: { color: '#cf222e', background: 'rgba(207,34,46,.12)' },
    }

    function Chip({ children, kind }) {
      const style = tone[kind] ?? { color: dim, background: 'rgba(127,127,127,.12)' }
      return h('span', {
        style: {
          ...style,
          borderRadius: 999,
          padding: '1px 8px',
          fontSize: 11,
          lineHeight: '18px',
          whiteSpace: 'nowrap',
          display: 'inline-block',
        },
      }, children)
    }

    const clock = (value) => {
      try {
        return new Date(value).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' })
      } catch {
        return '--:--'
      }
    }

    const short = (id) => String(id ?? '')
      .replace(/^at-system$/, '系统')
      .replace(/^at-lead-/, 'leader ')
      .replace(/^at-w-/, 'w-')

    // 投递状态的中文名：`held` = 对方上闩中，消息暂扣，解闩后自动补投。
    const stateName = (state) => ({
      pending: '未投递',
      delivered: '已投递',
      injected: '已旁听',
      held: '上闩暂扣',
      failed: '失败',
    })[state] ?? String(state)

    /** 当前选中的工作区拼进查询串（`?` 与 `&` 都照顾到，调用方可能已经带了参数）。 */
    const withWorkspace = (path) => {
      if (bus.workspace === null) return path
      return path + (path.includes('?') ? '&' : '?') + 'workspace=' + encodeURIComponent(bus.workspace)
    }

    // ---- 点击诊断（**默认关**）---------------------------------------------
    //
    // 起因：桌面端点工作区下拉"没有任何反应"，而我看不到用户的屏幕。
    // 打开方式（二选一，要重新加载页面）：
    //   · 地址栏加 `&diag=1`（桌面端的 URL 带 token，直接加参数即可）
    //   · 控制台执行 localStorage.setItem('dsh.agent-team.diag', '1') 后刷新
    // 打开后：页面里每次 pointerdown / click 都会 POST 一条到 `/agent-team/diag`，
    // 落在会话所属工作区的 `.team/client-diag.jsonl`。默认关，免得平时点一下就发一条。
    //
    // 为什么用 capture 阶段的 document 监听：它**不需要事件命中我的按钮**，
    // 只要点击落在页面里就会经过 document —— 于是能分清"点击没到页面"与"点击被别的东西接住"。
    const diagEnabled = (() => {
      try {
        return new URLSearchParams(location.search).get('diag') === '1'
          || localStorage.getItem('dsh.agent-team.diag') === '1'
      } catch {
        return false
      }
    })()
    const diagSend = (payload) => {
      if (!diagEnabled) return
      try {
        void fetch('/agent-team/diag', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        })
      } catch { /* 诊断绝不能影响面板 */ }
    }
    const describeElement = (element) => {
      if (element === null || element === undefined) return null
      const parts = [element.tagName.toLowerCase()]
      const label = element.getAttribute('aria-label')
      if (label !== null) parts.push(`aria-label=${label}`)
      const ws = element.getAttribute('data-workspace')
      if (ws !== null) parts.push('data-workspace')
      const role = element.getAttribute('role')
      if (role !== null) parts.push(`role=${role}`)
      return parts.join(' ')
    }
    if (diagEnabled && window.__agentTeamDiag !== true) {
      window.__agentTeamDiag = true
      document.addEventListener('pointerdown', (event) => {
        const top = document.elementFromPoint(event.clientX, event.clientY)
        const dialog = document.querySelector('[role="dialog"][aria-label="Agent Team"]')
        diagSend({
          type: 'pointerdown',
          x: event.clientX,
          y: event.clientY,
          top: describeElement(top),
          topChain: top === null ? [] : (() => {
            const chain = []
            for (let node = top, depth = 0; node !== null && depth < 4; node = node.parentElement, depth += 1) {
              chain.push(describeElement(node))
            }
            return chain
          })(),
          drawerOpen: dialog !== null,
          hitTrigger: top !== null && top.closest('button[aria-label="工作区"]') !== null,
          hitDrawer: top !== null && top.closest('[role="dialog"]') !== null,
          hasOverlaySlot: !!window.__DSH__,
        })
      }, true)
      document.addEventListener('click', (event) => {
        const top = document.elementFromPoint(event.clientX, event.clientY)
        diagSend({ type: 'click', x: event.clientX, y: event.clientY, top: describeElement(top) })
      }, true)
    }

    async function teamFetch(path, options) {
      const response = await fetch('/agent-team' + withWorkspace(path), { cache: 'no-store', ...options })
      const text = await response.text()
      if (!response.ok) throw new Error(text || 'HTTP ' + response.status)
      return text
    }

    // 数据来源：/state 全量投影 + /events 的"store 变了"推送。
    // SSE 连上就停轮询，连不上就退回轮询（intervalMs 是兜底节奏，不是主路径）。
    function useTeam(intervalMs) {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [live, setLive] = useState(false)
      // 依赖它：切换工作区时 load 换新的、下面的 effect 立刻重拉一次（SSE 也重连到新工作区）。
      const workspace = useWorkspace()
      const load = useCallback(async () => {
        try {
          setState(JSON.parse(await teamFetch('/state')))
          setError('')
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        }
      }, [workspace])
      useEffect(() => {
        void load()
        let timer = setInterval(() => { void load() }, intervalMs)
        let source = null
        const startPolling = () => {
          if (timer !== null) return
          timer = setInterval(() => { void load() }, intervalMs)
        }
        const stopPolling = () => {
          if (timer === null) return
          clearInterval(timer)
          timer = null
        }
        try {
          source = new EventSource(withWorkspace('/agent-team/events'))
          source.addEventListener('ready', () => { setLive(true); stopPolling() })
          source.addEventListener('team', () => { void load() })
          source.onopen = () => { setLive(true); stopPolling() }
          // 断流：退回轮询，浏览器会按 retry 自己重连；重连成功后 onopen 再停轮询。
          source.onerror = () => { setLive(false); startPolling() }
        } catch {
          /* 没有 EventSource 就只轮询 */
        }
        return () => {
          stopPolling()
          if (source !== null) source.close()
        }
      }, [load, intervalMs])
      return { state, error, live, reload: load }
    }

    // ---------------------------------------------------------------- 工作区下拉

    /** 工作区列表 + 各自待办数（`/agent-team/workspaces`，第 3 步）。 */
    function useWorkspaceList(intervalMs) {
      const [list, setList] = useState(null)
      useEffect(() => {
        let alive = true
        const load = async () => {
          try {
            const payload = JSON.parse(await teamFetch('/workspaces'))
            if (alive) setList(payload)
          } catch { /* 下拉是辅助：拿不到就不画，主面板照常 */ }
        }
        void load()
        const timer = setInterval(() => { void load() }, intervalMs)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [intervalMs])
      return list
    }

    const tailOf = (target) => String(target ?? '').split(/[\\/]/).filter(Boolean).pop() ?? ''

    /**
     * 工作区下拉。徽章口径（用户 2026-11-21 定）：**只算当前工作区**；
     * 别的团队的待办不并进侧边栏数字，只在它自己的选项上带一个小圆点（`验收沙箱 B ●3`）。
     *
     * 为什么不用原生 `<select>`：它的下拉是**浏览器/Electron 的原生弹层**，
     * 在桌面端点它没有任何反应（2026-11-21 用户实测："前端操作没有反应"）。
     * 换成普通 DOM 的按钮 + 列表：不依赖任何原生弹层，也能把 `●N` 显示成独立元素。
     */
    function WorkspaceSelect({ list }) {
      const workspace = useWorkspace()
      const [opened, setOpened] = useState(false)
      // 打开时把触发按钮的屏幕矩形记下来：列表用 `position: fixed` 画在这个坐标上，
      // 这样它不会因为抽屉/头部任何祖先的 overflow 或层叠上下文而看不见。
      const [anchor, setAnchor] = useState(null)
      const rootRef = useRef(null)
      const workspaces = list?.workspaces ?? []
      // 点别处关掉（原生弹层以前自己会关；自己做就得自己关）
      useEffect(() => {
        if (!opened) return undefined
        const onDown = (event) => {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpened(false)
        }
        const onKey = (event) => { if (event.key === 'Escape') setOpened(false) }
        window.addEventListener('mousedown', onDown)
        window.addEventListener('keydown', onKey)
        return () => {
          window.removeEventListener('mousedown', onDown)
          window.removeEventListener('keydown', onKey)
        }
      }, [opened])
      if (workspaces.length === 0) return null
      // 记在 localStorage 里的工作区可能已经被删了：落回服务端的默认工作区，别让下拉空着。
      const current = workspaces.find((item) => item.path === workspace)
        ?? workspaces.find((item) => item.default)
        ?? workspaces[0]
      const labelOf = (item) => {
        const tail = tailOf(item.path)
        const title = item.title || tail
        // 标题和目录名对不上就把目录名带上：可能有两个工作区都叫 "AgentWorkTeam"
        // （真的那个 + 沙箱那个），下拉里必须分得清。目录名已经在标题里就不重复。
        return title.toLowerCase().includes(tail.toLowerCase()) ? title : `${title} · ${tail}`
      }
      return h('div', {
        ref: rootRef,
        style: { position: 'relative', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: dim },
      },
        h('span', { style: { whiteSpace: 'nowrap' } }, '工作区'),
        h('button', {
          type: 'button',
          'aria-label': '工作区',
          'data-workspace': current.path,
          'aria-expanded': opened ? 'true' : 'false',
          title: current.path + '（切换只换视图，不影响任何会话）',
          onClick: () => {
            const rect = rootRef.current === null ? null : rootRef.current.getBoundingClientRect()
            setAnchor(rect === null ? null : { left: Math.round(rect.left), top: Math.round(rect.bottom + 4), width: Math.round(rect.width) })
            diagSend({ type: 'workspace-trigger-click', willOpen: !opened, anchorTop: rect === null ? null : Math.round(rect.top) })
            setOpened(!opened)
          },
          style: {
            display: 'flex', alignItems: 'center', gap: 6, maxWidth: 300,
            fontSize: 12, padding: '3px 8px', borderRadius: 6, cursor: 'pointer',
            border: line, background: surface, color: ink,
          },
        },
          h('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, labelOf(current)),
          current.pending > 0 ? h('span', { style: { color: '#9a6700' } }, '●' + current.pending) : null,
          h('span', { style: { fontSize: 10, color: dim } }, '▼'),
        ),
        opened
          ? h('div', {
            role: 'listbox',
            'aria-label': '工作区列表',
            style: {
              position: 'fixed',
              left: anchor === null ? 16 : anchor.left,
              top: anchor === null ? 16 : anchor.top,
              zIndex: 2000,
              minWidth: 260, maxWidth: 420, maxHeight: 320, overflowY: 'auto',
              padding: 4, borderRadius: 8, background: surface,
              border: line, boxShadow: '0 10px 28px rgba(0,0,0,.18)',
              WebkitAppRegion: 'no-drag',
            },
          }, workspaces.map((item) => h('button', {
            key: item.path,
            type: 'button',
            role: 'option',
            'aria-selected': item.path === current.path ? 'true' : 'false',
            'data-workspace': item.path,
            title: item.path,
            onClick: () => {
              setWorkspace(item.path)
              setOpened(false)
            },
            style: {
              display: 'flex', alignItems: 'center', gap: 8, width: '100%',
              padding: '6px 8px', borderRadius: 6, border: 'none', cursor: 'pointer',
              textAlign: 'left', fontSize: 12, color: ink,
              background: item.path === current.path ? hover : 'transparent',
            },
          },
            h('span', { style: { flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, labelOf(item)),
            item.pending > 0 ? h('span', { style: { color: '#9a6700', fontSize: 11 } }, '●' + item.pending) : null,
            item.path === current.path ? h('span', { style: { color: dim, fontSize: 11 } }, '当前') : null,
          )))
          : null,
      )
    }

    // ---------------------------------------------------------------- 侧边栏按钮

    function TeamGlyph({ size = 16 }) {
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block' } },
        h('circle', { cx: 12, cy: 12, r: 3.2, fill: 'currentColor' }),
        h('circle', { cx: 5, cy: 5, r: 2.1, fill: 'currentColor', opacity: .75 }),
        h('circle', { cx: 19, cy: 5, r: 2.1, fill: 'currentColor', opacity: .75 }),
        h('circle', { cx: 5, cy: 19, r: 2.1, fill: 'currentColor', opacity: .75 }),
        h('circle', { cx: 19, cy: 19, r: 2.1, fill: 'currentColor', opacity: .75 }),
        h('path', { d: 'M12 12 5 5m7 7 7-7m-7 7-7 7m7-7 7 7', stroke: 'currentColor', strokeWidth: 1.2, opacity: .45, fill: 'none' }),
      )
    }

    function SidebarButton({ wide }) {
      const open = useOpen()
      const { state } = useTeam(5000)
      const pending = state?.pending?.length ?? 0
      const rows = state?.rows ?? []
      const unseen = Math.max(0, rows.length - bus.seen)
      // 需要人处理、但又不在"待批申请"里的状态：leader 没了 / leader 被归档 / 有投递失败。
      // 这些以前只有点开抽屉才看得到，侧边栏一片安静。
      const leaderGone = state !== null && state.leaderStatus !== undefined && state.leaderStatus.available !== true
      const released = state?.leaderReleased ?? null
      const failed = rows.filter((row) => (row.delivery ?? []).some((slot) => slot.state === 'failed' || slot.state === 'held')).length
      const attention = leaderGone ? (state?.leaderStatus?.reason === 'archived' ? 'leader 已归档' : '还没有 leader') : failed > 0 ? failed + ' 条投递异常' : ''

      useEffect(() => {
        if (open) bus.seen = (state?.rows ?? []).length
      }, [open, state])

      // 徽章只算当前工作区（用户口径），所以提示里要写清是哪个团队 —— 否则数字看着对不上。
      const teamName = state?.workspace ? tailOf(state.workspace) : ''
      const who = teamName ? `Agent Team · ${teamName}` : 'Agent Team'
      const title = pending > 0
        ? `${who}：${pending} 条待办`
        : attention
          ? `${who}：${attention}，点开处理`
          : who

      return h('button', {
        type: 'button',
        onClick: () => setOpen(!open),
        title,
        'aria-label': title,
        style: {
          display: 'flex', alignItems: 'center', gap: 8,
          width: wide ? '100%' : 36, height: 32,
          padding: wide ? '0 10px' : 0, justifyContent: wide ? 'flex-start' : 'center',
          border: 'none', borderRadius: 8, background: open ? hover : 'transparent',
          color: ink, cursor: 'pointer', fontSize: 13, position: 'relative',
        },
      },
        h(TeamGlyph, null),
        wide ? h('span', { style: { flex: 1, textAlign: 'left' } }, 'Agent Team') : null,
        pending > 0
          ? h('span', {
            style: {
              minWidth: 18, height: 18, padding: '0 5px', borderRadius: 9,
              background: '#cf222e', color: '#fff', fontSize: 11, lineHeight: '18px',
              textAlign: 'center', fontWeight: 600,
            },
          }, pending)
          : attention
            ? h('span', {
              // 琥珀色小点：不打断你，但不用点开也知道有事
              title: attention,
              style: { width: 8, height: 8, borderRadius: 4, background: '#9a6700', display: 'block' },
            })
            : unseen > 0 && !open
              ? h('span', { style: { width: 7, height: 7, borderRadius: 4, background: accent, display: 'block' } })
              : null,
      )
    }

    // ---------------------------------------------------------------- 派发权限

    function AuthorityCard({ state, reload }) {
      const current = state?.authority?.authority ?? 'ask'
      const full = current === 'autonomous'
      const [confirming, setConfirming] = useState(false)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const card = { border: line, borderRadius: 10, padding: 12, marginBottom: 10 }

      const apply = async (value) => {
        setBusy(true)
        setError('')
        try {
          await teamFetch('/authority', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ authority: value }),
          })
          setConfirming(false)
          await reload()
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        } finally {
          setBusy(false)
        }
      }

      return h('div', { style: card },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 } },
          h('strong', { style: { fontSize: 13 } }, '派发权限'),
          h(Chip, { kind: full ? 'read' : 'pending' }, full ? '完全权限' : '需要你批准'),
          h('span', { style: { flex: 1 } }),
          confirming
            ? h('div', { style: { display: 'flex', gap: 8 } },
              h('button', { type: 'button', disabled: busy, onClick: () => apply('autonomous'), style: buttonStyle('#cf222e', true) }, busy ? '开启中…' : '确认开启'),
              h('button', { type: 'button', onClick: () => setConfirming(false), style: buttonStyle() }, '取消'),
            )
            : h('button', {
              type: 'button',
              disabled: busy,
              onClick: () => (full ? apply('ask') : setConfirming(true)),
              style: buttonStyle(full ? null : accent, !full),
            }, full ? '改回需要批准' : '开启完全权限'),
        ),
        h('div', { style: { fontSize: 12.5, color: dim, lineHeight: 1.6 } },
          full
            ? 'leader 可以直接创建 worker 并派任务，不必等你批准。每次自主派发都会记入派发日志，leader 应在下一次风控汇报里向你说明。'
            : 'leader 每次派活都会先写成一条待批申请，你在这里点批准后才真的建会话。',
        ),
        error ? h('div', { style: { fontSize: 12, color: '#cf222e', marginTop: 6 } }, error) : null,
      )
    }

    // ---------------------------------------------------------------- leader

    // leader 宕机（归档）后团队会挂在旧会话上：交接还能由用户代批，但派发没人管。
    // 这张卡负责把这件事说出来，并给用户一个「换人」的按钮（唯一的人工接管入口）。
    function LeaderCard({ state, reload }) {
      const status = state?.leaderStatus ?? { id: state?.leader ?? null, available: false, reason: 'no-leader' }
      const members = state?.sessions ?? {}
      const card = { border: line, borderRadius: 10, padding: 12, marginBottom: 10 }
      const down = status.available !== true
      const [open, setOpen] = useState(false)
      const [target, setTarget] = useState('')
      const [reason, setReason] = useState('')
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')
      const [done, setDone] = useState('')

      const candidates = Object.entries(members)
        .filter(([id, info]) => id !== status.id && info.status !== 'archived' && info.status !== 'replaced')
        .map(([id, info]) => ({ id, label: short(id) + ' · ' + (info.title ?? info.job ?? info.role) }))

      const transfer = async () => {
        const sessionId = target.trim()
        if (!sessionId) {
          setError('先填要接任的会话 id')
          return
        }
        setBusy(true)
        setError('')
        setDone('')
        try {
          const result = JSON.parse(await teamFetch('/admin/promote-leader', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ confirm: 'PROMOTE', sessionId, reason }),
          }))
          setDone(result.changed ? '已移交：' + short(result.previous) + ' → ' + short(result.leader) : '这个会话本来就是 leader')
          if (result.warning) setError(result.warning)
          setTarget('')
          setReason('')
          setOpen(false)
          await reload()
        } catch (failure) {
          setError(String(failure && failure.message ? failure.message : failure))
        } finally {
          setBusy(false)
        }
      }

      return h('div', { style: { ...card, ...(down ? { borderColor: 'rgba(154,103,0,.55)' } : {}) } },
        h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 } },
          h('strong', { style: { fontSize: 13 } }, 'leader'),
          status.id === null
            ? h('span', { style: { fontSize: 12.5, color: dim } }, '（还没有）')
            : h('code', { style: { fontSize: 12.5 } }, short(status.id)),
          h(Chip, { kind: down ? (status.reason === 'archived' ? 'failed' : 'pending') : 'read' },
            down ? (status.reason === 'archived' ? '已归档' : '还没有 leader') : '在线'),
          h('span', { style: { flex: 1 } }),
          h('button', {
            type: 'button',
            onClick: () => { setOpen(!open); setError(''); setDone('') },
            style: buttonStyle(down ? accent : null, down),
          }, open ? '收起' : '移交…'),
        ),
        down
          ? h('div', { style: { fontSize: 12.5, color: dim, lineHeight: 1.6 } },
            status.reason === 'archived'
              ? 'leader 会话已归档：交接申请现在由你代批，但没人能派发、也没人接 worker 的交接申请。指定一个会话接任就能恢复。'
              : state.leaderReleased
                ? `原 leader ${short(state.leaderReleased.from)} 在 ${clock(state.leaderReleased.at)} 被归档，席位已空出。` +
                  '新开一个「Agent Team · Leader」会话、它第一次调团队工具时会自动接任（不需要手动移交）；在那之前交接审批由你代批。'
                : '还没有 leader：在「Agent Team · Leader」会话里开始工作，或在这里指定一个会话顶上去。')
          : h('div', { style: { fontSize: 12.5, color: dim, lineHeight: 1.6 } }, 'leader 在线：派发与交接审批都归它，你不需要代批。'),
        open
          ? h('div', { style: { marginTop: 10, paddingTop: 10, borderTop: line } },
            h('div', { style: { fontSize: 12, color: dim, marginBottom: 6 } }, '接任的会话 id'),
            h('input', {
              value: target,
              onChange: (event) => setTarget(event.target.value),
              placeholder: 'at-w-02-backend',
              style: { width: '100%', boxSizing: 'border-box', padding: '4px 8px', borderRadius: 6, border: line, background: 'transparent', color: ink, fontSize: 12.5 },
            }),
            candidates.length === 0
              ? null
              : h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 } },
                candidates.slice(0, 8).map((candidate) =>
                  h('button', {
                    key: candidate.id,
                    type: 'button',
                    onClick: () => setTarget(candidate.id),
                    style: { ...buttonStyle(), padding: '1px 8px', fontSize: 11.5 },
                  }, candidate.label),
                ),
              ),
            h('input', {
              value: reason,
              onChange: (event) => setReason(event.target.value),
              placeholder: '移交原因（可选，写进 store.leaderHistory）',
              style: { width: '100%', boxSizing: 'border-box', marginTop: 8, padding: '4px 8px', borderRadius: 6, border: line, background: 'transparent', color: ink, fontSize: 12.5 },
            }),
            h('div', { style: { display: 'flex', gap: 8, marginTop: 10 } },
              h('button', { type: 'button', disabled: busy, onClick: transfer, style: buttonStyle(accent, true) }, busy ? '移交中…' : '确认移交'),
              h('button', { type: 'button', onClick: () => { setOpen(false); setTarget(''); setReason('') }, style: buttonStyle() }, '取消'),
            ),
            h('div', { style: { fontSize: 11.5, color: dim, marginTop: 8, lineHeight: 1.55 } },
              '一个团队只允许一个 leader：确认后旧 leader 立刻卸任（记入 leaderHistory，不删）。' +
              '派发工具只装配在 Agent Team · Leader 会话里——换个普通会话就只有审批权。'),
          )
          : null,
        done ? h('div', { style: { fontSize: 12, color: '#1a7f37', marginTop: 6 } }, done) : null,
        error ? h('div', { style: { fontSize: 12, color: '#cf222e', marginTop: 6, whiteSpace: 'pre-wrap' } }, error) : null,
      )
    }

    // ---------------------------------------------------------------- 下拉

    // 原生 <select> 的**弹出列表**是系统画的：`color-scheme` 管不到它的白底，
    // 深色模式下面板里会突兀地出现一块白。所以自己画一个：按钮 + 绝对定位的列表，
    // 颜色全部走 DSH token，两种主题都跟着变。
    function Select({ value, options, onChange, title }) {
      const [open, setOpen] = useState(false)
      const [hovered, setHovered] = useState(null)
      const box = useRef(null)

      useEffect(() => {
        if (!open) return undefined
        const onPointer = (event) => {
          if (box.current !== null && !box.current.contains(event.target)) setOpen(false)
        }
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onPointer)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onPointer)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      const current = options.find((option) => option.value === value) ?? options[0]

      return h('div', { ref: box, style: { position: 'relative', flex: '0 0 auto' } },
        h('button', {
          type: 'button',
          title,
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          onClick: () => {
            setHovered(null)
            setOpen(!open)
          },
          style: {
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '4px 8px', borderRadius: 6, cursor: 'pointer',
            border: line, background: 'transparent', color: ink, fontSize: 12.5,
            whiteSpace: 'nowrap',
          },
        },
          h('span', null, current?.label ?? ''),
          h('span', { style: { fontSize: 8, opacity: .5, lineHeight: 1 } }, '▼'),
        ),
        open
          ? h('div', {
            role: 'listbox',
            style: {
              position: 'absolute', top: 'calc(100% + 4px)', left: 0, zIndex: 30,
              minWidth: 'max(100%, 120px)', maxHeight: 280, overflowY: 'auto',
              padding: 4, borderRadius: 8,
              border: '1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))',
              // 抬起来的观感：往 label 色偏 8%（深色主题变亮、浅色主题变暗），两种都成立。
              background: 'color-mix(in srgb, var(--dsw-alias-bg-base, #ffffff) 92%, var(--dsw-alias-label-primary, #16181d) 8%)',
              boxShadow: '0 10px 28px rgba(0,0,0,.32)',
            },
          },
            options.map((option) => {
              const selected = option.value === value
              return h('button', {
                key: option.value,
                type: 'button',
                role: 'option',
                'aria-selected': selected,
                onClick: () => {
                  onChange(option.value)
                  setOpen(false)
                },
                onMouseEnter: () => setHovered(option.value),
                onMouseLeave: () => setHovered(null),
                style: {
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '5px 8px', borderRadius: 6, border: 'none', cursor: 'pointer',
                  fontSize: 12.5, whiteSpace: 'nowrap',
                  background: selected
                    ? 'var(--dsw-alias-interactive-bg-active, rgba(127,127,127,.18))'
                    : hovered === option.value
                      ? 'var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.12))'
                      : 'transparent',
                  color: selected ? ink : dim,
                  fontWeight: selected ? 600 : 400,
                },
              }, option.label)
            }),
          )
          : null,
      )
    }

    // ---------------------------------------------------------------- 待办

    function PendingTab({ state, reload }) {
      const pending = state?.pending ?? []
      const [busy, setBusy] = useState('')
      const [rejecting, setRejecting] = useState('')
      const [reason, setReason] = useState('')
      const [infoFor, setInfoFor] = useState('')
      const [infoNote, setInfoNote] = useState('')
      const [error, setError] = useState('')

      // 要求补充：申请保持挂起，只把"缺什么"回给申请方（服务端会解除它的上闩）。
      const moreInfo = async (id) => {
        setBusy(id)
        setError('')
        try {
          await teamFetch('/more-info', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestId: id, note: infoNote }),
          })
          setInfoFor('')
          setInfoNote('')
          await reload()
        } catch (failure) {
          setError(readableError(String(failure && failure.message ? failure.message : failure), '发送失败'))
        } finally {
          setBusy('')
        }
      }

      /**
       * 服务端的 HTTP 错误体是 JSON（`{"error":"…"}`），直接 `'操作失败：' + text` 会显示成一串转义。
       * 1.9.1：抽出 `error` 字段；再兜一层——建会话失败时，申请已经退回 pending，
       * 提示上告诉用户可以重试（以前的版本会永久卡在 approved）。
       */
      const readableError = (text, fallback) => {
        try {
          const payload = JSON.parse(text)
          if (typeof payload?.error === 'string' && payload.error !== '') return payload.error
        } catch { /* 不是 JSON 就原样显示 */ }
        return text || fallback
      }

      const approve = async (id) => {
        setBusy(id)
        setError('')
        try {
          await teamFetch('/approve', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestId: id }),
          })
          await reload()
        } catch (failure) {
          const text = readableError(String(failure && failure.message ? failure.message : failure), '批准失败')
          setError(text + '（申请已退回待批，可以直接再点一次批准）')
          await reload()
        } finally {
          setBusy('')
        }
      }

      const reject = async (id) => {
        setBusy(id)
        setError('')
        try {
          await teamFetch('/reject', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestId: id, reason }),
          })
          setRejecting('')
          setReason('')
          await reload()
        } catch (failure) {
          setError(readableError(String(failure && failure.message ? failure.message : failure), '拒绝失败'))
        } finally {
          setBusy('')
        }
      }

      const members = state?.sessions ?? {}
      const card = { border: line, borderRadius: 10, padding: 12, marginBottom: 10 }

      return h('div', { style: { padding: 16, overflowY: 'auto', flex: 1 } },
        error ? h('div', { style: { ...card, borderColor: '#cf222e', color: '#cf222e' } }, '操作失败：' + error) : null,

        h(LeaderCard, { state, reload }),

        h(AuthorityCard, { state, reload }),

        h('div', { style: { ...card, padding: '10px 12px' } },
          h('div', { style: { fontSize: 12, color: dim, marginBottom: 6 } }, '团队'),
        (() => {
          const all = Object.entries(members)
          const active = all.filter(([, info]) => info.status !== 'archived' && info.status !== 'replaced')
          const gone = all.length - active.length
          if (all.length === 0) {
            return h('div', { style: { fontSize: 13, color: dim } }, '还没有团队会话。选 Agent Team · Leader 建一个会话就会出现在这里。')
          }
          return h('div', null,
            active.length === 0
              ? h('div', { style: { fontSize: 13, color: dim } },
                `团队里没有活跃会话（${gone} 个已归档）。新开一个「Agent Team · Leader」会话就会重新组队。`)
              : h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap' } },
                active.map(([id, info]) =>
                  h('span', { key: id, style: { border: line, borderRadius: 6, padding: '2px 8px', fontSize: 12 } },
                    h('code', null, short(id)),
                    h('span', { style: { color: dim } }, ' · ' + (info.title ?? info.job ?? info.role))),
                ),
              ),
            gone > 0
              ? h('div', { style: { fontSize: 11.5, color: dim, marginTop: 6 } }, `另有 ${gone} 个已归档/已替换的会话（消息页仍可查历史）`)
              : null,
          )
        })(),
      ),

        pending.length === 0
          ? h('div', { style: { ...card, color: dim } }, '暂无待批申请', h('div', { style: { fontSize: 12, marginTop: 4 } }, 'leader 在线时通常不需要你代批。'))
          : h('div', null,
            h('div', { style: { fontSize: 12, color: dim, margin: '4px 0 8px' } }, '待批（' + pending.length + '）'),
            pending.map((item) =>
              h('div', { key: item.id, style: card },
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 } },
                  h('strong', { style: { fontSize: 13 } }, (item.type === 'spawn' ? '派发申请' : '交接申请') + ' · ' + (item.title ?? item.job)),
                  h(Chip, { kind: 'pending' }, '待批'),
                  item.awaiting === 'user'
                    ? h(Chip, { kind: 'pending' }, '需要你批准')
                    : h(Chip, { kind: 'delivered' }, '等 leader'),
                  h('span', { style: { flex: 1 } }),
                  h('span', { style: { fontSize: 12, color: dim } }, clock(item.at)),
                ),
                h('div', { style: { fontSize: 12.5, color: dim, marginBottom: 6 } },
                  short(item.from) + ' 申请 · 新会话将使用 ' + (item.type === 'spawn' ? 'Agent Team · Worker' : '同岗位 worker'),
                ),
                item.awaitingReason ? h('div', { style: { fontSize: 12, color: dim, marginBottom: 6 } }, item.awaitingReason) : null,
                item.infoRequested
                  ? h('div', { style: { fontSize: 12, color: '#9a6700', marginBottom: 6 } },
                    '已要求补充（' + clock(item.infoRequested.at) + '）：' + item.infoRequested.note + ' —— 等它补回来，单子还是这一张。')
                  : null,
                h('div', { style: { fontSize: 13, whiteSpace: 'pre-wrap', marginBottom: 10, maxHeight: 120, overflow: 'auto' } }, item.summary ?? ''),
                item.awaiting !== 'user'
                  ? h('div', { style: { fontSize: 12, color: dim } }, 'leader 在线，这条由 leader 批准；你不需要处理。')
                  : rejecting === item.id
                    ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                      h('input', {
                        value: reason,
                        onChange: (event) => setReason(event.target.value),
                        placeholder: '拒绝原因（可选）',
                        style: { flex: 1, padding: '4px 8px', borderRadius: 6, border: line, background: 'transparent', color: ink, fontSize: 12.5 },
                      }),
                      h('button', { type: 'button', disabled: busy === item.id, onClick: () => reject(item.id), style: buttonStyle('#cf222e') }, '确认拒绝'),
                      h('button', { type: 'button', onClick: () => { setRejecting(''); setReason('') }, style: buttonStyle() }, '取消'),
                    )
                    : infoFor === item.id
                      ? h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                        h('input', {
                          value: infoNote,
                          onChange: (event) => setInfoNote(event.target.value),
                          placeholder: '要它补什么（必填，会发回给申请方）',
                          style: { flex: 1, padding: '4px 8px', borderRadius: 6, border: line, background: 'transparent', color: ink, fontSize: 12.5 },
                        }),
                        h('button', { type: 'button', disabled: busy === item.id || infoNote.trim() === '', onClick: () => moreInfo(item.id), style: buttonStyle() }, '发送'),
                        h('button', { type: 'button', onClick: () => { setInfoFor(''); setInfoNote('') }, style: buttonStyle() }, '取消'),
                      )
                      : h('div', { style: { display: 'flex', gap: 8 } },
                        h('button', { type: 'button', disabled: busy === item.id, onClick: () => approve(item.id), style: buttonStyle(accent, true) }, busy === item.id ? '处理中…' : '批准'),
                        item.type === 'handoff'
                          ? h('button', { type: 'button', disabled: busy === item.id, onClick: () => setInfoFor(item.id), style: buttonStyle() }, '要求补充')
                          : null,
                        h('button', { type: 'button', disabled: busy === item.id, onClick: () => setRejecting(item.id), style: buttonStyle() }, '拒绝'),
                      ),
              ),
            ),
          ),
      )
    }

    function buttonStyle(color, primary) {
      return {
        padding: '4px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 12.5,
        border: primary ? '1px solid ' + (color ?? ink) : line,
        background: primary ? (color ?? ink) : 'transparent',
        color: primary ? '#fff' : ink,
        opacity: 1,
      }
    }

    // ---------------------------------------------------------------- 消息

    function MessagesTab({ state }) {
      const rows = state?.rows ?? []
      const total = state?.totalMessages ?? rows.length
      const [older, setOlder] = useState([])
      const [loading, setLoading] = useState(false)
      const [kind, setKind] = useState('all')
      const [recipient, setRecipient] = useState('all')
      const [range, setRange] = useState('all')
      const [status, setStatus] = useState('all')
      const [query, setQuery] = useState('')
      const [selected, setSelected] = useState(null)
      const [body, setBody] = useState('')
      const [bodyError, setBodyError] = useState('')
      const scroller = useRef(null)

      // /state 只带最新 100 条；更早的按 id 游标往前翻，页与页之间不重叠。
      const allRows = useMemo(() => [...older, ...rows], [older, rows])
      const olderCount = Math.max(0, total - allRows.length)
      const loadOlder = useCallback(async () => {
        const oldest = allRows[0]?.id
        if (oldest === undefined || loading) return
        setLoading(true)
        try {
          const page = JSON.parse(await teamFetch('/messages?limit=100&before=' + encodeURIComponent(oldest)))
          setOlder((previous) => {
            const seen = new Set([...previous, ...rows].map((row) => row.id))
            return [...page.filter((row) => !seen.has(row.id)), ...previous]
          })
        } catch (failure) {
          setBodyError(String(failure && failure.message ? failure.message : failure))
        } finally {
          setLoading(false)
        }
      }, [allRows, loading, rows])

      const kinds = useMemo(() => [...new Set(allRows.map((row) => row.kind))].sort(), [allRows])
      const recipients = useMemo(() => {
        const seen = new Map()
        for (const row of allRows) for (const id of row.to ?? []) if (!seen.has(id)) seen.set(id, short(id))
        return [...seen.entries()].sort((a, b) => a[1].localeCompare(b[1]))
      }, [allRows])

      // 时间窗：只按消息时间戳算，不看"读没读过"。
      const floorOf = (value) => {
        if (value === 'all') return 0
        const hour = 3600 * 1000
        if (value === '1h') return Date.now() - hour
        if (value === '24h') return Date.now() - 24 * hour
        if (value === 'today') {
          const start = new Date()
          start.setHours(0, 0, 0, 0)
          return start.getTime()
        }
        return 0
      }

      // 状态：投递状态是逐收件人的，一条消息只要有一个收件人命中就算命中。
      const statusHits = (row, want) => (row.delivery ?? []).some((slot) => slot.state === want)

      const filtered = useMemo(() => {
        const needle = query.trim().toLowerCase()
        const floor = floorOf(range)
        return allRows
          .filter((row) => kind === 'all' || row.kind === kind)
          .filter((row) => recipient === 'all' || (row.to ?? []).includes(recipient))
          .filter((row) => floor === 0 || new Date(row.ts).getTime() >= floor)
          .filter((row) => status === 'all'
            || statusHits(row, status)
            || (status === 'failed' && statusHits(row, 'failed')))
          .filter((row) => !needle || (row.summary ?? '').toLowerCase().includes(needle) || row.id.includes(needle) || row.from.includes(needle))
          .slice()
          .reverse()
      }, [allRows, kind, recipient, range, status, query])

      const dirty = kind !== 'all' || recipient !== 'all' || range !== 'all' || status !== 'all' || query.trim() !== ''
      const reset = () => {
        setKind('all')
        setRecipient('all')
        setRange('all')
        setStatus('all')
        setQuery('')
      }

      const open = async (message) => {
        setSelected(message)
        setBody('加载中…')
        setBodyError('')
        try {
          setBody(await teamFetch('/body?id=' + encodeURIComponent(message.id)))
        } catch (failure) {
          setBody('')
          setBodyError(String(failure && failure.message ? failure.message : failure))
        }
      }

      const card = { border: line, borderRadius: 10, padding: 12, marginBottom: 10 }

      return h('div', { style: { display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 } },
        h('div', { style: { display: 'flex', gap: 8, padding: '10px 16px', borderBottom: line, alignItems: 'center', flexWrap: 'wrap', position: 'relative', zIndex: 5 } },
          h(Select, {
            value: kind,
            onChange: setKind,
            title: '按类型筛选',
            options: [{ value: 'all', label: '全部类型' }, ...kinds.map((value) => ({ value, label: value }))],
          }),
          h(Select, {
            value: recipient,
            onChange: setRecipient,
            title: '按收件人筛选',
            options: [{ value: 'all', label: '全部收件人' }, ...recipients.map(([id, label]) => ({ value: id, label }))],
          }),
          h(Select, {
            value: range,
            onChange: setRange,
            title: '按时间筛选',
            options: [
              { value: 'all', label: '全部时间' },
              { value: '1h', label: '最近 1 小时' },
              { value: '24h', label: '最近 24 小时' },
              { value: 'today', label: '今天' },
            ],
          }),
          h(Select, {
            value: status,
            onChange: setStatus,
            title: '按投递状态筛选',
            options: [
              { value: 'all', label: '全部状态' },
              { value: 'failed', label: '有投递失败' },
              { value: 'pending', label: '未投递' },
              { value: 'delivered', label: '已投递' },
              { value: 'injected', label: '已旁听' },
            ],
          }),
          h('input', {
            value: query,
            onChange: (event) => setQuery(event.target.value),
            placeholder: '搜索摘要 / id / 会话',
            style: { flex: 1, minWidth: 140, padding: '4px 8px', borderRadius: 6, border: line, background: 'transparent', color: ink, fontSize: 12.5 },
          }),
          dirty ? h('button', { type: 'button', onClick: reset, style: { ...buttonStyle(), padding: '2px 10px' } }, '清空') : null,
          h('span', { style: { fontSize: 12, color: dim } }, filtered.length + ' / ' + allRows.length + (total > allRows.length ? '（共 ' + total + '）' : '')),
        ),

        h('div', { style: { display: 'flex', flex: 1, minHeight: 0 } },
          h('div', { ref: scroller, style: { flex: 1, overflowY: 'auto', borderRight: line } },
            filtered.length === 0
              ? h('div', { style: { padding: 16, color: dim, fontSize: 13 } }, allRows.length === 0 ? '团队还没有消息。' : '没有匹配的消息。')
              : filtered.map((row) =>
                h('div', {
                  key: row.id,
                  onClick: () => { void open(row) },
                  style: {
                    padding: '10px 16px', borderBottom: line, cursor: 'pointer',
                    background: selected?.id === row.id ? hover : 'transparent',
                  },
                },
                  h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: dim } },
                    h('span', null, clock(row.ts)),
                    h('code', null, row.id),
                    h('span', null, short(row.from) + ' → ' + (Array.isArray(row.toExpr) ? row.toExpr.length + ' 个会话' : row.toExpr)),
                    h(Chip, { kind: 'pending' }, row.kind),
                    row.delivery?.some((slot) => slot.state === 'failed') ? h(Chip, { kind: 'failed' }, '投递失败') : null,
                    row.delivery?.some((slot) => slot.state === 'held') ? h(Chip, { kind: 'held' }, '上闩暂扣') : null,
                  ),
                  h('div', { style: { fontSize: 13, marginTop: 4 } }, row.summary),
                ),
              ),
            olderCount > 0
              ? h('div', { style: { padding: '10px 16px', borderBottom: line, textAlign: 'center' } },
                h('button', {
                  type: 'button',
                  disabled: loading,
                  onClick: () => { void loadOlder() },
                  style: { ...buttonStyle(), padding: '4px 12px' },
                }, loading ? '加载中…' : '加载更早（还有 ' + olderCount + ' 条）'))
              : null,
          ),
          h('div', { style: { width: '46%', minWidth: 240, overflowY: 'auto' } },
            selected === null
              ? h('div', { style: { padding: 16, color: dim, fontSize: 13 } }, '选择一条消息查看详情。')
              : h('div', { style: { padding: 16 } },
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 } },
                  h('strong', { style: { fontSize: 13 } }, selected.id),
                  h(Chip, { kind: 'pending' }, selected.kind),
                  h('span', { style: { flex: 1 } }),
                  h('button', { type: 'button', onClick: () => setSelected(null), style: buttonStyle() }, '关闭'),
                ),
                h('div', { style: { fontSize: 12.5, color: dim, lineHeight: '1.7', marginBottom: 8 } },
                  h('div', null, '发送方：' + short(selected.from)),
                  h('div', null, '收件人：' + (selected.to ?? []).map(short).join('、')),
                  h('div', null, '投递：' + (selected.delivery ?? []).map((slot) => short(slot.session) + '/' + stateName(slot.state)).join('、')),
                ),
                bodyError ? h('div', { style: { ...card, borderColor: '#cf222e', color: '#cf222e', fontSize: 12.5 } }, '正文读取失败：' + bodyError) : null,
                h('pre', {
                  style: { margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 12.5, lineHeight: 1.6 },
                }, body),
              ),
          ),
        ),
      )
    }

    // ---------------------------------------------------------------- 抽屉

    function Drawer() {
      const open = useOpen()
      const { state, error, live, reload } = useTeam(open ? 3000 : 15000)
      const list = useWorkspaceList(open ? 10000 : 60000)
      const [tab, setTabState] = useState('pending')
      // 打开时恢复上次看的标签页（记住的是"上次用过的"，不是"每次重置"）。
      useEffect(() => {
        if (!open) return
        try {
          setTabState(localStorage.getItem('dsh.agent-team.tab') === 'messages' ? 'messages' : 'pending')
        } catch { /* 读不到就用默认 */ }
      }, [open])
      const setTab = (value) => {
        setTabState(value)
        try {
          localStorage.setItem('dsh.agent-team.tab', value)
        } catch { /* 记住标签页是锦上添花，失败不影响面板 */ }
      }
      const pending = state?.pending?.length ?? 0

      useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => { if (event.key === 'Escape') setOpen(false) }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      useEffect(() => {
        if (open) bus.seen = (state?.rows ?? []).length
      }, [open, state])

      if (!open) return null

      const tabStyle = (active) => ({
        padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontSize: 13,
        border: 'none', background: active ? hover : 'transparent',
        color: active ? ink : dim, fontWeight: active ? 600 : 400,
      })

      return h('div', { style: { position: 'fixed', inset: 0, zIndex: 60 } },
        h('div', {
          onClick: () => setOpen(false),
          style: { position: 'absolute', inset: 0, background: 'var(--dsw-alias-bg-mask, rgba(0,0,0,.28))' },
        }),
        h('div', {
          role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Agent Team',
          style: {
            position: 'absolute', top: 0, right: 0, bottom: 0, width: 'min(640px, 94vw)',
            display: 'flex', flexDirection: 'column',
            // Electron 里 `-webkit-app-region: drag` 的区域会**吃掉点击**（窗口拖动优先）。
            // 抽屉铺满整个窗口、包含标题栏那一条，所以这里必须显式声明可交互。
            WebkitAppRegion: 'no-drag',
            background: surface, color: ink, borderLeft: line,
            boxShadow: '-16px 0 40px rgba(0,0,0,.18)',
          },
        },
          h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, padding: '12px 16px', borderBottom: line } },
            h(TeamGlyph, { size: 18 }),
            h('strong', { style: { fontSize: 14, whiteSpace: 'nowrap' } }, 'Agent Team'),
            h(WorkspaceSelect, { list }),
            h('span', { style: { flex: 1 } }),
            h('button', {
              type: 'button', onClick: () => setOpen(false), 'aria-label': '关闭',
              style: { ...buttonStyle(), padding: '2px 10px' },
            }, '关闭'),
          ),
          h('div', { style: { display: 'flex', gap: 6, padding: '8px 16px', borderBottom: line, alignItems: 'center' } },
            h('button', { type: 'button', onClick: () => setTab('pending'), style: tabStyle(tab === 'pending') },
              '待办' + (pending > 0 ? ' ' + pending : '')),
            h('button', { type: 'button', onClick: () => setTab('messages'), style: tabStyle(tab === 'messages') }, '消息'),
            h('span', { style: { flex: 1 } }),
            h('span', {
              style: { fontSize: 11, color: dim, display: 'flex', alignItems: 'center', gap: 4 },
              title: live ? 'SSE 实时推送（store 一变就刷新）' : 'SSE 未连上，退回轮询',
            },
              h('span', {
                style: { width: 6, height: 6, borderRadius: 999, display: 'inline-block', background: live ? '#1a7f37' : '#9a6700' },
              }),
              live ? '实时' : '轮询'),
            h('span', { style: { fontSize: 11.5, color: dim } },
              state === null
                ? '连接中…'
                : state.leaderStatus === undefined
                  ? (state.leader ? short(state.leader) : '还没有 leader')
                  : state.leaderStatus.available
                    ? 'leader ' + short(state.leaderStatus.id)
                    : (state.leaderStatus.reason === 'archived' ? 'leader 已归档' : '还没有 leader')),
          ),
          error ? h('div', { style: { padding: '8px 16px', color: '#cf222e', fontSize: 12.5 } }, '读取失败：' + error + '（已加载内容保留）') : null,
          tab === 'pending' ? h(PendingTab, { state, reload }) : h(MessagesTab, { state }),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'agent-team-entry',
          order: 80,
        }, SidebarButton))

        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'agent-team-drawer',
          order: 80,
        }, Drawer))
      },
    }
  },
})
