import { localTime } from './details.js'
/** Merge API image pages, saved-operation results and lane checkpoints by UUID. */
export function imageRows(images, operations, lanes) {
  const rows = new Map()
  const add = (uuid, fields = {}) => {
    if (typeof uuid !== 'string' || !uuid) return
    rows.set(uuid, { ...rows.get(uuid), uuid, ...fields })
  }
  for (const image of images) add(image.uuid, { tag: image.tag ?? null, createdAt: image.created_at ?? null, operation: image.operation_uuid ?? undefined })
  for (const op of operations) {
    const uuid = op.result_image_uuid ?? op.result_image ?? op.result?.image
    if (uuid) add(uuid, { saved: true, operation: op.uuid ?? op.operation_id, createdAt: rows.get(uuid)?.createdAt ?? op.created_at ?? null })
  }
  for (const lane of lanes) {
    for (const uuid of lane.history ?? []) add(uuid, { checkpoint: true })
    add(lane.head, { heads: [...new Set([...(rows.get(lane.head)?.heads ?? []), lane.name])] })
  }
  return [...rows.values()].sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0) || a.uuid.localeCompare(b.uuid))
}

const isSavedImage = image => !!(image.saved || image.operation || image.heads?.length || image.checkpoint)
const matchesImage = (image, filter, query) =>
  (filter === 'saved' ? isSavedImage(image) : !isSavedImage(image)) &&
  `${image.uuid} ${image.tag ?? ''} ${(image.heads ?? []).join(' ')}`.toLowerCase().includes(query.toLowerCase())

export function createImageCatalog(load, changed) {
  let images = [], operations = [], lanes = [], offset = 0, loading = false, error = null, more = true, loaded = false
  const publish = () => changed({ rows: imageRows(images, operations, lanes), loading, error, more, loaded })
  const inspecting = new Map()
  return {
    async inspect(uuid) {
      if (images.some(image => image.uuid === uuid && image.created_at)) return
      if (inspecting.has(uuid)) return inspecting.get(uuid)
      const work = (async () => {
        try {
          const image = await load('get_image', { image: uuid })
          if (image?.uuid) images = [...images.filter(row => row.uuid !== uuid), image]
        } catch { /* Keep the snapshot accessible even when metadata cannot be read. */ }
        await publish()
      })()
      inspecting.set(uuid, work)
      return work
    },
    async updateLanes(next) { lanes = next; await publish() },
    async observe(op) {
      if (!(op?.result_image_uuid ?? op?.result_image ?? op?.result?.image)) return
      operations = [op, ...operations.filter(row => row.uuid !== op.uuid)].slice(0, 200)
      await publish()
    },
    async fetch(reset = false, { filter, query = '' } = {}) {
      if (loading) return
      loading = true
      error = null
      await publish()
      try {
        const matchingIds = () => new Set(imageRows(images, operations, lanes).filter(row => matchesImage(row, filter, query)).map(row => row.uuid))
        const before = !reset && filter ? matchingIds() : null
        let added = 0
        let pages = 0
        do {
          const pageOffset = reset && pages === 0 ? 0 : offset
          const limit = before ? 10 - added : 50
          const page = await load('list_images', { limit, offset: pageOffset, tagged: false })
          if (!Array.isArray(page?.images)) throw new Error('list_images returned no images array')
          images = reset && pages === 0 ? page.images : [...images, ...page.images]
          offset = pageOffset + page.images.length
          more = page.images.length === limit
          loaded = true
          pages++
          if (before) added = [...matchingIds()].filter(id => !before.has(id)).length
          if (before && more && added < 10 && pages >= 100) {
            throw new Error('Stopped after 100 image pages; fewer than 10 matching images found. Load more to continue.')
          }
        } while (before && more && added < 10)
        if (reset) {
          const recent = await load('list_operations', { limit: 100 })
          if (!Array.isArray(recent?.operations)) throw new Error('list_operations returned no operations array')
          const merged = new Map(operations.map(op => [op.uuid, op]))
          for (const op of recent.operations) merged.set(op.uuid, op)
          operations = [...merged.values()].slice(-200)
        }
      } catch (e) {
        error = String(e?.message ?? e)
      } finally {
        loading = false
        await publish()
      }
    },
  }
}

export function imagesTree(ui, view, t, actions) {
  const { Box, Text, Button, Input } = ui
  const catalog = view.images ?? { rows: [] }
  const savedCount = catalog.rows.filter(isSavedImage).length
  const filter = view.imageFilter ?? 'saved'
  const children = [
    Box({flexDirection:'row',alignItems:'center',justifyContent:'space-between',gap:1,children:[
      Input({ key: 'image-search', value: view.imageQuery ?? '', placeholder: t('browse.search'), onInput: actions.searchImages, onSubmit: actions.searchImages }),
      Button({ key: 'images-refresh', label: t('browse.refreshList'), plain: true, onPress: actions.refreshImages }),
    ]}),
    Box({gap:1,flexWrap:'wrap',children:[
      Button({key:'images-saved',label:t('browse.savedCount',{n:savedCount}),variant:filter==='saved'?'primary':'secondary',onPress:()=>actions.imageFilter('saved')}),
      Button({key:'images-catalog',label:t('browse.catalogCount',{n:catalog.rows.length-savedCount}),variant:filter==='catalog'?'primary':'secondary',onPress:()=>actions.imageFilter('catalog')}),
    ]}),
  ]
  if (catalog.loading) children.push(Text({ dimColor: true, children: [t('images.loading')] }))
  if (catalog.error) children.push(Text({ color: 'red', wrap: 'wrap', children: [catalog.error] }))
  if (!catalog.loading && !catalog.rows.length) children.push(Text({ dimColor: true, children: [t('images.empty')] }))
  const query = (view.imageQuery ?? '').toLowerCase()
  const matches = catalog.rows.filter(image => matchesImage(image, filter, query))
  if (query && !matches.length) children.push(Text({ dimColor: true, children: [t('compact.noMatches')] }))
  for (const image of matches) {
    const label = `${localTime(image.createdAt)} ${image.uuid}`
    const badges = [image.heads?.length ? image.heads.join(', ') : '', image.tag ?? ''].filter(Boolean)
    children.push(Box({flexDirection:'row',alignItems:'center',flexWrap:'wrap',gap:1,children:[
      Button({ key: `image:${image.uuid}`, label, plain:true, children:[Text({mono:true,wrap:'wrap',children:[label]})], onPress: () => actions.selectImage(image.uuid) }),
      ...(badges.length ? [Text({dimColor:true,size:'caption',wrap:'wrap',children:[badges.join(' · ')]})] : []),
    ]}))
  }
  if (catalog.more && !catalog.loading) children.push(Button({ key: 'images-more', label: t('images.more'), onPress: actions.moreImages }))
  children.push(Text({ dimColor: true, size: 'caption', wrap: 'wrap', children: [t('images.hint')] }))
  return Box({ flexDirection: 'column', gap: 1, children })
}
