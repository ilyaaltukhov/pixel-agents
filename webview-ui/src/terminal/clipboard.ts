/**
 * The one way terminal code writes and reads the system clipboard, on secure
 * AND plain-http origins. A phone opening a tokened LAN `http://` URL is not
 * a secure context: `navigator.clipboard` is undefined there, so touching it
 * unguarded throws.
 */

/**
 * Put `text` on the clipboard. Resolves true once it is there.
 *
 * Secure contexts use the async Clipboard API. Elsewhere (or when it
 * refuses) a `copy` event is raised by hand and filled in — this only works
 * while the triggering click / key press still counts as a user gesture, so
 * call it synchronously from the handler.
 */
export async function writeClipboardText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (err: unknown) {
      console.warn('[Webview] Clipboard write refused, trying a copy event:', err);
    }
  }
  return copyViaEvent(text);
}

function copyViaEvent(text: string): boolean {
  let written = false;
  // Capture on window: runs before any other copy listener (the terminal
  // host's selection re-flow included) and ends the dispatch.
  const onCopy = (ev: ClipboardEvent) => {
    if (!ev.clipboardData) return;
    ev.clipboardData.setData('text/plain', text);
    ev.preventDefault();
    ev.stopImmediatePropagation();
    written = true;
  };
  window.addEventListener('copy', onCopy, true);
  try {
    return document.execCommand('copy') && written;
  } catch {
    return false;
  } finally {
    window.removeEventListener('copy', onCopy, true);
  }
}

/**
 * Text to paste, or null (nothing to paste, or the user declined). Secure
 * contexts read the clipboard (Safari may show its paste-permission callout).
 * Without the Clipboard API there is no way to read it from script, so the
 * user pastes into a native prompt instead — its field takes the OS paste
 * menu — and that text is what gets pasted.
 */
export async function readClipboardText(promptLabel: string): Promise<string | null> {
  if (window.isSecureContext && navigator.clipboard?.readText) {
    try {
      return (await navigator.clipboard.readText()) || null;
    } catch {
      // Dismissed callout or denied permission: nothing to paste.
      return null;
    }
  }
  return window.prompt(promptLabel) || null;
}

/**
 * What to paste from the mobile paste key: an image (a copied photo or
 * screenshot) or text, or null. One Clipboard API read() covers both, so
 * Safari shows its paste callout once; without read() (or when it fails)
 * this is readClipboardText. A desktop paste arrives as a paste event
 * instead (imageInput.ts).
 */
export async function readClipboardContent(promptLabel: string): Promise<Blob | string | null> {
  if (window.isSecureContext && navigator.clipboard?.read) {
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((t) => t.startsWith('image/'));
        if (type) return await item.getType(type);
      }
      for (const item of items) {
        if (item.types.includes('text/plain')) {
          return (await (await item.getType('text/plain')).text()) || null;
        }
      }
      return null;
    } catch {
      // Unsupported type, dismissed callout, or denied: try the text path.
    }
  }
  return readClipboardText(promptLabel);
}
