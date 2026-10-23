import { localTime, detailTree } from './details.js'

/** Service SUCCESS is not proof that the guest command passed. */
export function taskOutcome(task) {
  if (task?.interrupted) return 'unknown'
  const value = task?.value ?? {}
  const state = value.metadata?.result?.state ?? value
  const status = String(value.status ?? value.state ?? '').toUpperCase()
  if (state.timed_out === true) return 'timeout'
  if (['CANCELLED', 'CANCELED'].includes(status)) return 'cancelled'
  if (['FAILED', 'ERROR', 'FAILURE'].includes(status)) return 'platform'
  if (state.signal > 0) return 'terminated'
  if (Number.isFinite(state.exit_code) && state.exit_code !== 0) return 'commandFailed'
  if (task?.failed || value.isError === true) return 'apiFailed'
  if (['PENDING', 'ASSIGNED', 'EXECUTING', 'RUNNING'].includes(status)) return 'running'
  if (task?.pending) return 'running'
  if (task?.error && !task.value) return 'apiFailed'
  if (state.exit_code === 0) return 'success'
  if (task?.async) return 'submitted'
  if (task?.remote || status === 'SUCCESS') return 'unknown'
  return 'returned'
}
export function persistenceOf(task) {
  const value = task?.value ?? {}
  if (value.result_image_uuid ?? value.result_image ?? value.result?.image) return 'saved'
  const disposable = task?.disposable ?? value.metadata?.disposable
  if (disposable === true) return 'temporary'
  if (disposable === false) return 'noSnapshot'
  return null
}
export function tasksTree(ui, view, t, actions, now) {
  const { Box, Text, Button } = ui
  const text = (s, props={}) => Text({size:'caption',wrap:'wrap',...props,children:[s]})
  const children = []
  const historical = view.showHistory && view.operationDetail
  const latest = historical ? view.operationDetail : view.latestTask
  const detailKey = historical ? `history:${latest.id}` : `latest:${latest?.callId ?? latest?.id ?? ''}`
  const expanded = view.taskDisclosure?.key === detailKey ? view.taskDisclosure : {}
  if(historical) children.push(Button({key:'task-back-latest',plain:true,label:t('taskView.back'),onPress:actions.backLatest}))
  if (!latest) children.push(text(t('tasks.empty'),{dimColor:true}))
  else {
    const outcome = taskOutcome(latest)
    const value = latest.value ?? {}
    const state = value.metadata?.result?.state ?? value
    const color = ['timeout','platform','terminated','commandFailed','apiFailed'].includes(outcome) ? 'red' : outcome === 'success' ? 'green' : undefined
    children.push(text(t(historical?'taskView.selected':'taskView.latest'),{weight:'semibold',size:'body'}))
    children.push(text(localTime(latest.startedAt ?? value.created_at),{dimColor:true}))
    const resources = value.metadata?.result?.resources ?? {}
    const finite = (...values) => values.find(Number.isFinite)
    const rounded = number => String(Number(number.toFixed(2)))
    const seconds = number => !Number.isFinite(number) ? '—' : number < 1 ? `${Math.round(number * 1000)} ms` : `${rounded(number)} s`
    const bytes = number => {
      if (!Number.isFinite(number)) return '—'
      const unit = number >= 1e9 ? 'GB' : number >= 1e6 ? 'MB' : number >= 1e3 ? 'KB' : 'B'
      const scale = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9 }[unit]
      return `${rounded(number / scale)} ${unit}`
    }
    const row = (key, content) => Box({key:`task-metric-${key}`,flexDirection:'row',justifyContent:'space-between',alignItems:'center',gap:2,children:[
      text(t(`taskMetrics.${key}`),{dimColor:true}),
      typeof content === 'string' ? text(content,{mono:true}) : content,
    ]})
    const imageRow = (label, key, image) => row(label, typeof image === 'string' && image
      ? Button({key,plain:true,label:image,children:[text(image,{mono:true,color:'blue',underline:true})],onPress:()=>actions.selectImage(image)})
      : '—')
    const elapsed = finite(resources.elapsed_time, value.elapsed_time)
    const memory = finite(resources.max_rss, value.consumed_memory)
    const summary = [
      text(t('taskMetrics.summary'),{weight:'semibold'}),
      row('tool',latest.method || '—'),
      row('status',text(t(`tasks.${outcome}`),{weight:'semibold',color})),
      row(Number.isFinite(elapsed) ? 'executionTime' : 'operationDuration',seconds(finite(elapsed,value.duration))),
      ...(Number.isFinite(latest.callSeconds) ? [row('apiTime',seconds(latest.callSeconds))] : []),
      imageRow('sourceImage','task-source-image',value.image_uuid),
      imageRow('resultImage','task-result-image',value.result_image_uuid ?? value.result_image ?? value.result?.image),
    ]
    if(latest.id && latest.remote) summary.push(row('operation',text(latest.id,{mono:true,dimColor:true})))
    children.push(Box({key:'task-metrics',flexDirection:'column',gap:1,children:[
      Box({key:'task-summary',flexDirection:'column',gap:0.5,borderStyle:'round',borderDimColor:true,padding:1,children:summary}),
      Box({key:'task-resources',flexDirection:'column',gap:0.5,borderStyle:'round',borderDimColor:true,padding:1,children:[
        text(t('taskMetrics.resources'),{weight:'semibold'}),
        row('systemCpu',seconds(finite(resources.system_cpu_time,value.system_cpu_time))),
        row('consumedCpu',seconds(value.consumed_cpu)),
        row('userCpu',seconds(finite(resources.user_cpu_time,value.user_cpu_time))),
        row('peakRam',bytes(Number.isFinite(memory) ? memory * 1024 : undefined)),
        row('imageSize',bytes(value.image_size)),
        row('exitCode',Number.isFinite(state.exit_code) ? String(state.exit_code) : '—'),
        row('timedOut',typeof state.timed_out === 'boolean' ? t(`taskMetrics.${state.timed_out}`) : '—'),
      ]}),
    ]}))
    children.push(detailTree(ui,latest,t,{requestOpen:expanded.request,rawOpen:expanded.raw,toggle:part=>actions.toggleTaskDetail(detailKey,part)}))
  }
  children.push(Button({key:'more-tasks',plain:true,label:t(view.showHistory?'tasks.less':'tasks.more'),onPress:()=>actions.togglePanel('showHistory')}))
  if(view.showHistory) {
    children.push(text(t('history.scope'),{dimColor:true}))
    for(const op of view.ops) children.push(Box({flexDirection:'column',gap:0.5,children:[
      Button({key:`operation:${op.id}`,label:`${localTime(op.createdAt)} · ${op.kind} · ${op.state} · ${op.id}`,onPress:()=>actions.inspectOperation(op.id)}),
      ...(op.id && (op.remote === true || !op.local && op.remote !== false) && ['PENDING','ASSIGNED','EXECUTING'].includes(op.state)?[Button({key:`cancel:${op.id}`,label:t('pane.cancel'),onPress:()=>actions.cancel(op.id)})]:[]),
    ]}))
    if(!view.ops.length) children.push(text(t('pane.ops.empty'),{dimColor:true}))
    children.push(Box({justifyContent:'flex-end',width:'100%',children:[Button({key:'clear-history',label:t('history.clear'),children:[text(t('history.clear'),{color:'red'})],onPress:actions.clearHistory})]}))
  }
  return Box({flexDirection:'column',gap:1,children})
}
