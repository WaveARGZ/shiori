import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

// The chrome renderer is our own code, but it still only gets a narrow, prefix
// checked bridge rather than raw ipcRenderer.
const PREFIX = 'shiori:';

function assertChannel(channel: string): void {
  if (typeof channel !== 'string' || !channel.startsWith(PREFIX)) {
    throw new Error(`Shiori: blocked IPC channel "${channel}"`);
  }
}

contextBridge.exposeInMainWorld('shiori', {
  invoke(channel: string, payload?: unknown) {
    assertChannel(channel);
    return ipcRenderer.invoke(channel, payload);
  },
  send(channel: string, payload?: unknown) {
    assertChannel(channel);
    ipcRenderer.send(channel, payload);
  },
  on(channel: string, listener: (payload: unknown) => void) {
    assertChannel(channel);
    const handler = (_event: IpcRendererEvent, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.off(channel, handler);
    };
  },
});
