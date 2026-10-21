/** Plugin-global lane records. One key per lane prevents unrelated sessions overwriting each other. */
const PREFIX = 'global-lane/'
const MIGRATED = 'global-lane-migration/'
export async function readGlobalLanes(store) {
  const lanes = {}
  for (const key of await store.keys()) {
    if (!key.startsWith(PREFIX)) continue
    const lane = await store.get(key)
    if (lane?.name && typeof lane.head === 'string') lanes[lane.name] = lane
  }
  return lanes
}
export async function migrateLanes(store) {
  const lanes = await readGlobalLanes(store)
  for (const key of (await store.keys()).filter(key => key.startsWith('lanes/')).sort()) {
    const legacy = await store.get(key)
    for (const lane of Object.values(legacy?.lanes ?? {})) {
      if (!lane?.name || typeof lane.head !== 'string') continue
      const marker = MIGRATED + encodeURIComponent(`${key}:${lane.name}:${lane.head}`)
      if (await store.get(marker)) continue
      let name = lane.name
      let suffix = 1
      while (lanes[name] && lanes[name].head !== lane.head) name = `${lane.name.slice(0, 36)}-import-${suffix++}`
      if (!lanes[name]) {
        const imported = { ...lane, name, owner: null }
        await store.set(PREFIX + name, imported)
        lanes[name] = imported
      }
      await store.set(marker, true)
    }
  }
  return lanes
}
export async function writeLaneChanges(store, before, after) {
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (JSON.stringify(before[name]) === JSON.stringify(after[name])) continue
    if (after[name]) await store.set(PREFIX + name, after[name])
    else await store.delete(PREFIX + name)
  }
}
