import { localTime, detailTree } from './details.js'

/** Service SUCCESS is not proof that the guest command passed. */
export function taskOutcome(task) {
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
  const latest = historical ? { ...view.operationDetail, remote: true } : view.latestTask
  const detailKey = historical ? `history:${latest.id}` : `latest:${latest?.callId ?? latest?.id ?? ''}`
  const expanded = view.taskDisclosure?.key === detailKey ? view.taskDisclosure : {}
  if(historical) children.push(Button({key:'task-back-latest',plain:true,label:t('taskView.back'),onPress:actions.backLatest}))
  if (!latest) children.push(text(t('tasks.empty'),{dimColor:true}))
  else {
    const outcome = taskOutcome(latest)
    const value = latest.value ?? {}
    const state = value.metadata?.result?.state ?? value
    const color = ['timeout','platform','terminated','commandFailed','apiFailed'].includes(outcome) ? 'red' : outcome === 'success' ? 'green' : undefined
    children.push(Box({flexDirection:'row',justifyContent:'space-between',alignItems:'center',gap:1,children:[
      text(t(historical?'taskView.selected':'taskView.latest'),{weight:'semibold',size:'body'}),
      text(t(`tasks.${outcome}`),{weight:'semibold',color}),
    ]}))
    children.push(text(localTime(latest.startedAt ?? value.created_at),{dimColor:true}))
    const duration = Number.isFinite(value.duration) ? value.duration : latest.callSeconds
    const number = value => Number.isFinite(value) ? String(value) : '—'
    children.push(Box({key:'task-metrics',flexDirection:'row',flexWrap:'wrap',gap:2,children:[
      text(`Duration: ${number(duration)}`,{mono:true}),text(`CPU: ${number(value.consumed_cpu)}`,{mono:true}),text(`Memory: ${number(value.consumed_memory)}`,{mono:true}),
      ...(Number.isFinite(state.exit_code)?[text(`Exit: ${state.exit_code}`,{mono:true})]:[]),
    ]}))
    const sourceImage = value.image_uuid
    const resultImage = value.result_image_uuid ?? value.result_image ?? value.result?.image
    for (const [label, key, image] of [
      ['Image:', 'task-source-image', sourceImage],
      ['Result Image:', 'task-result-image', resultImage],
    ]) {
      if (typeof image !== 'string' || !image) continue
      children.push(Box({flexDirection:'row',alignItems:'center',gap:1,children:[
        Box({width:13,flexShrink:0,children:[text(label)]}),
        Button({key,plain:true,label:image,children:[text(image,{mono:true,color:'blue',underline:true})],onPress:()=>actions.selectImage(image)}),
      ]}))
    }
    if(latest.id && latest.remote) children.push(Box({flexDirection:'row',gap:1,children:[Box({width:13,flexShrink:0,children:[text('Operation:')]}),text(latest.id,{mono:true,dimColor:true})]}))
    children.push(detailTree(ui,latest,t,{requestOpen:expanded.request,rawOpen:expanded.raw,toggle:part=>actions.toggleTaskDetail(detailKey,part)}))
  }
  children.push(Button({key:'more-tasks',plain:true,label:t(view.showHistory?'tasks.less':'tasks.more'),onPress:()=>actions.togglePanel('showHistory')}))
  if(view.showHistory) {
    children.push(text(t('history.scope'),{dimColor:true}))
    for(const op of view.ops) children.push(Box({flexDirection:'column',gap:0.5,children:[
      Button({key:`operation:${op.id}`,label:`${localTime(op.createdAt)} · ${op.kind} · ${op.state} · ${op.id}`,onPress:()=>actions.inspectOperation(op.id)}),
      ...(['PENDING','ASSIGNED','EXECUTING'].includes(op.state)?[Button({key:`cancel:${op.id}`,label:t('pane.cancel'),onPress:()=>actions.cancel(op.id)})]:[]),
    ]}))
    if(!view.ops.length) children.push(text(t('pane.ops.empty'),{dimColor:true}))
    children.push(Box({justifyContent:'flex-end',width:'100%',children:[Button({key:'clear-history',label:'Clear',children:[text('Clear',{color:'red'})],onPress:actions.clearHistory})]}))
  }
  return Box({flexDirection:'column',gap:1,children})
}
