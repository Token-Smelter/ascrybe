const SQLITE_REQUIREMENT='SQLite index commands require Node.js 22.5 or newer with built-in node:sqlite enabled';

export async function loadDatabaseSync(){
  try{
    const {DatabaseSync}=await import('node:sqlite');
    if(typeof DatabaseSync!=='function')throw new Error('DatabaseSync is unavailable');
    return DatabaseSync;
  }catch(error){
    throw new Error(`${SQLITE_REQUIREMENT}. JSON graph queries remain available without SQLite support.`,{cause:error});
  }
}
