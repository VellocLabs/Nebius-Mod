/** Dates use the desktop worker's local timezone; no UTC rendering. */
export function localTime(value) {
  if (value === null || value === undefined || value === '') return '—'
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return '—'
  const p = n => String(n).padStart(2, '0')
  return `${p(date.getMonth()+1)}-${p(date.getDate())}-${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`
}
export function safeDetail(value, depth = 0) {
  if (depth > 8) return '[depth limit]'
  if (typeof value === 'string') return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').replace(/(Bearer\s+)[^\s"']+/gi, '$1[redacted]').replace(/((?:password|token|secret|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]').slice(0, 16000)
  if (Array.isArray(value)) return value.slice(0,100).map(v => safeDetail(v, depth+1))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).slice(0,100).map(([k,v]) => [k, /token|password|secret|credential|authorization|cookie|^env$/i.test(k) ? '[redacted]' : safeDetail(v,depth+1)]))
  return value
}
export function detailTree(ui, detail, t, options = {}) {
  const { Box, Text, Code, Button } = ui
  const children = []
  if (!detail) return Box({children})
  const block = (title, data, color) => {
    if (data === undefined || data === null || data === '') return
    const cleaned = safeDetail(data)
    const source = typeof cleaned === 'string' ? cleaned : JSON.stringify(cleaned, null, 2)
    if (!source?.trim()) return
    children.push(Text({weight:'semibold',color,children:[title]}),Code({source:source.slice(0,8000),language:typeof cleaned==='string'?'text':'json',wrap:'wrap'}))
    if(source.length>8000) children.push(Text({dimColor:true,children:[t('detail.truncated')]}))
  }
  if(detail.loading) children.push(Text({children:[t('detail.loading')]}))
  if(detail.error) children.push(Text({color:'red',wrap:'wrap',children:[String(safeDetail(detail.error))]}))
  if(detail.value) {
    const value=detail.value
    const stream = data => data && typeof data === 'object' ? (data.encoding === 'base64' ? t('taskView.encoded') : data.value) : data
    const stdout=stream(value.stdout ?? value.metadata?.result?.stdout)
    const stderr=stream(value.stderr ?? value.metadata?.result?.stderr)
    const hasOut=typeof stdout === 'string' && stdout.trim() !== ''
    const hasErr=typeof stderr === 'string' && stderr.trim() !== ''
    if(hasOut) block(t('taskView.output'),stdout)
    if(hasErr) block('stderr',stderr,'red')
    if(!hasOut && !hasErr && !detail.pending) children.push(Text({dimColor:true,children:[t('taskView.noOutput')]}))
    const method=detail.method ?? value.metadata?.input?.command ?? value.command
    const hasArgs=detail.args && Object.keys(detail.args).length>0
    if(method || hasArgs) {
      children.push(Button({key:'task-request',plain:true,label:`${options.requestOpen?'▾':'▸'} ${t('taskView.request')}`,onPress:()=>options.toggle?.('request')}))
      if(options.requestOpen) { block(t('detail.method'),method); block(t('detail.args'),detail.args) }
    }
    children.push(Button({key:'task-raw',plain:true,label:`${options.rawOpen?'▾':'▸'} ${t('taskView.raw')}`,onPress:()=>options.toggle?.('raw')}))
    if(options.rawOpen) block(t('taskView.raw'),value)
  }
  return Box({flexDirection:'column',gap:0.5,children})
}
