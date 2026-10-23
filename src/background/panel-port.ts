import { PANEL_PORT } from './messages';
import type { PanelRequest, PanelResponse } from './messages';
import { call, onEmit } from './rpc';

// The test panel's methods include raw CDP on any tab and the layer's policy setters, and this module is part of the
// worker bundle, so the port is served only to the test panel page of this extension (as the product's panel port does).
chrome.runtime.onConnect.addListener(port => {
  if (port.name !== PANEL_PORT) return;
  if (
    port.sender?.id !== chrome.runtime.id ||
    !port.sender?.url?.startsWith(chrome.runtime.getURL('/testpanel.html'))
  ) {
    port.disconnect();
    return;
  }
  const unsubscribe = onEmit(event => port.postMessage(event));
  port.onDisconnect.addListener(unsubscribe);
  port.onMessage.addListener(async (message: PanelRequest) => {
    let response: PanelResponse;
    try {
      response = { id: message.id, ok: true, result: await call(message.method, message.params) };
    } catch (error) {
      response = { id: message.id, ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    try {
      port.postMessage(response);
    } catch {
      // The panel closed while the call was running.
    }
  });
});
