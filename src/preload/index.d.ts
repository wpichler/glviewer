// Renderer-side typing of the bridge exposed by the preload script.
declare global {
  interface Window {
    glv: {
      call<T>(channel: string, ...args: unknown[]): Promise<T>
      on(channel: string, cb: (payload: unknown) => void): () => void
      replyPrompt(r: unknown): void
      pathForFile(f: File): string
    }
  }
}
export {}
