/** Compact file-first Sandbox pane. Only supported desktop Mod primitives. */
import { isActive, statusOf } from './replies.js'
import { imagesTree } from './images.js'
import { tasksTree } from './tasks.js'
import { localTime } from './details.js'
import { fileTree } from './files.js'
import { checkTextKey } from '../setup.js'
export { isActive }
export function normalizeOperations(reply, tracked, limit = 12) {
  const rows = Array.isArray(reply?.operations) ? reply.operations : Array.isArray(reply) ? reply : []
  return rows.map(row => ({ id: String(row.uuid ?? row.operation_id ?? row.id ?? ''), kind: String(row.kind ?? row.operation_kind ?? ''), state: statusOf(row), createdAt: Date.parse(row.created_at ?? '') || null }))
    .filter(op => op.id !== '').map(op => tracked?.has(op.id) ? { ...op, lane: tracked.get(op.id).lane } : op)
    .sort((a,b) => (b.createdAt ?? 0)-(a.createdAt ?? 0)).slice(0,limit)
}
export function shortId(id) { return typeof id === 'string' && id.length > 12 ? `${id.slice(0,8)}…` : String(id ?? '') }
export function age(ms,t) {
  const seconds=Math.max(0,Math.round(ms/1000))
  if(seconds<60) return t('age.seconds',{n:seconds})
  if(seconds<3600) return t('age.minutes',{n:Math.floor(seconds/60)})
  if(seconds<86400) return t('age.hours',{n:Math.floor(seconds/3600)})
  return t('age.days',{n:Math.floor(seconds/86400)})
}
const shortTool = tool => String(tool ?? '').split('__').at(-1)
export function paneTree(ui,view,t,actions,now) {
  const {Box,Text,Button,Select}=ui
  const text=(value,props={})=>Text({size:'caption',...props,children:[value]})
  const row=children=>Box({flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:1,children})
  const connected=!!view.mcp?.isConnected && !view.mcp.authError && !view.mcp.missing
  const children=[Text({weight:'semibold',size:'body',wrap:'wrap',children:[
    'Sandbox · ',
    text(t(connected?'compact.connected':view.mcp?'compact.disconnected':'compact.checking'),{color:connected?'green':view.mcp?'red':undefined}),
    ` · ${view.quota?.running ?? '—'} / ${view.quota?.max ?? '—'}`,
  ]})]
  const expiration = view.quota?.tokenExpiration
  const expiryText = expiration === null ? t('tasks.expiryUnset') : Number.isFinite(expiration) ? localTime(expiration * 1000) : t('tasks.expiryUnknown')
  children.push(text(t('tasks.expiry',{time:expiryText}),{color:Number.isFinite(expiration) && expiration*1000 <= now ? 'red' : Number.isFinite(expiration) && expiration*1000-now < 600000 ? 'yellow' : undefined,dimColor:!Number.isFinite(expiration)}))
  const tab = view.section ?? 'tasks'
  children.push(row([
    Box({gap:1,children:[
      Button({key:'section:tasks',label:`Tasks (${view.ops.length})`,variant:tab==='tasks'?'primary':'secondary',onPress:()=>actions.showSection('tasks')}),
      Button({key:'section:lanes',label:`Lanes (${view.lanes.length})`,variant:tab==='lanes'?'primary':'secondary',onPress:()=>actions.showSection('lanes')}),
      Button({key:'section:images',label:`Images (${view.images?.rows.length ?? 0})`,variant:tab==='images'?'primary':'secondary',onPress:()=>actions.showSection('images')}),
    ]}),
    Button({key:'refresh',label:t('browse.refreshStatus'),plain:true,onPress:actions.refresh}),
  ]))
  if (!connected && view.mcp) {
    const reason=view.mcp.authError ?? view.mcp.reason ?? view.mcp.missing?.join(', ') ?? ''
    children.push(text(reason,{color:'red',wrap:'wrap'}))
    const unmet=(view.setup ?? []).filter(check=>check.state!=='ok')
    if(unmet.length) children.push(Box({key:'setup',flexDirection:'column',children:[
      text(t('setup.title'),{weight:'semibold'}),
      ...unmet.map(check=>text(`✗ ${t(`setup.${check.id}.label`)}: ${t(checkTextKey(check),check.vars)}`,{key:`setup:${check.id}`,wrap:'wrap'})),
    ]}))
    children.push(Button({key:'reconnect',label:t('pane.reconnect'),onPress:actions.reconnect}))
  }
  if(tab === 'tasks') {
    children.push(tasksTree(ui,view,t,actions,now))
  } else if(tab==='images') {
    if(view.selectedImage) {
      children.push(Button({key:'images-back',label:t('compact.backImages'),plain:true,onPress:actions.backImages}))
      children.push(row([text(view.selectedImage,{mono:true,wrap:'wrap'}),Button({key:'copy-image',label:t('compact.copyId'),plain:true,onPress:()=>actions.copyImage(view.selectedImage)})]))
      const meta = view.images?.rows.find(image => image.uuid === view.selectedImage)
      children.push(text(`${localTime(meta?.createdAt)} · ${meta?.tag ?? ''}`,{dimColor:true}),text(t('images.noDelete'),{dimColor:true,wrap:'wrap'}))
      if(view.browser?.image===view.selectedImage) children.push(fileTree(ui,view.browser,t,actions))
    } else children.push(imagesTree(ui,view,t,actions))
  } else if(!view.lanes.length) children.push(text(t('pane.lanes.empty'),{dimColor:true}))
  else {
    const lane=view.lanes.find(lane=>lane.name===view.selectedLane)
    children.push(row([
      Select({key:`lane-picker:${view.selectedLane}`,label:'Lane',value:view.selectedLane,options:view.lanes.map(lane=>({value:lane.name,label:lane.name})),onSelect:actions.selectLane}),
      ...(lane ? [Button({key:'drop-lane',label:t('pane.drop'),children:[text(t('pane.drop'),{color:'red'})],onPress:()=>actions.drop(lane.name)})] : []),
    ]))
    if(lane) {
      const history = [...new Set([...(lane.history ?? []), lane.head])].reverse()
      const pinned = view.laneSnapshots?.[lane.name]
      const selected = pinned && history.includes(pinned) ? pinned : lane.head
      const image = selected
      const options = history.map(id => {
        const meta = view.images?.rows.find(row => row.uuid === id)
        const time = meta?.createdAt ?? lane.snapshotTimes?.[id]
        return { value: id, label: `${localTime(time)} ${id}${id === lane.head ? ` · ${t('snapshots.current')}` : ''}` }
      })
      children.push(Select({key:`snapshot-picker:${lane.name}:${selected}`,label:t('snapshots.title'),value:selected,options,onSelect:actions.selectSnapshot}))
      children.push(row([text(`ID: ${image}`,{mono:true,wrap:'wrap'}),Button({key:'copy-image',label:t('compact.copyId'),plain:true,onPress:()=>actions.copyImage(image)})]))
      if (selected !== lane.head) children.push(text(t('browse.historical'),{dimColor:true,wrap:'wrap'}))
      if(view.browser?.lane === lane.name && view.browser.image === image) children.push(fileTree(ui,view.browser,t,actions))
    }
  }
  if(view.error) children.push(text(t('pane.error',{message:view.error}),{color:'yellow',wrap:'wrap'}))
  return Box({flexDirection:'column',gap:1,paddingX:1,children})
}
