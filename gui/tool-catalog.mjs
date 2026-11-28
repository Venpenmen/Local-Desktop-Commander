// SDK tools/list cursor handling shared by real probes and deterministic page tests.
export async function collectToolNames(client) {
  const names = [], seen = new Set(), cursors = new Set();
  let cursor;
  for(let page=0;page<32;page++){
    const r=await client.listTools(cursor ? {cursor} : {}, {timeout:5000});
    if(!Array.isArray(r.tools)) throw Error('TOOLS_LIST_INVALID');
    for(const tool of r.tools){
      if(typeof tool.name!=='string' ||
         !/^[a-zA-Z][a-zA-Z0-9_-]{0,127}$/.test(tool.name) || seen.has(tool.name))
        throw Error('TOOLS_LIST_DUPLICATE_OR_INVALID');
      seen.add(tool.name);names.push(tool.name);
    }
    cursor=r.nextCursor;
    if(!cursor)return names.sort();
    if(typeof cursor!=='string' || cursors.has(cursor))throw Error('TOOLS_CURSOR_INVALID');
    cursors.add(cursor);
  }
  throw Error('TOOLS_PAGINATION_LIMIT');
}
