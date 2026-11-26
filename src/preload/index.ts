import { contextBridge, ipcRenderer, webUtils } from 'electron'

type Result<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

async function call<T>(channel: string, ...args: unknown[]): Promise<T> {
  const r = (await ipcRenderer.invoke(channel, ...args)) as Result<T>
  if (r.ok) return r.value
  throw Object.assign(new Error(r.error.message), { code: r.error.code })
}

function on(channel: string, cb: (payload: unknown) => void): () => void {
  const l = (_e: unknown, p: unknown): void => cb(p)
  ipcRenderer.on(channel, l)
  return () => ipcRenderer.removeListener(channel, l)
}

const api = {
  call,
  on,
  replyPrompt: (r: unknown) => ipcRenderer.send('prompt:reply', r),
  pathForFile: (f: File) => webUtils.getPathForFile(f)
}

contextBridge.exposeInMainWorld('glv', api)

