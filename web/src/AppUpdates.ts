const REQUEST_TIMEOUT_MS = 10 * 1000;
const ROLLOUT_FRACTION = 0.1;
const RELEASE_PARAM = "__release";

function documentVersion(doc: Document): string | null {
  return (
    doc.querySelector('meta[name="app-version"]')?.getAttribute("content") ??
    null
  );
}

function canRefresh(): boolean {
  return (
    document.visibilityState === "visible" &&
    navigator.onLine &&
    !document.querySelector(".overlay") &&
    !document.activeElement?.matches("input, textarea, [contenteditable]")
  );
}

/** Consider an update once at startup, before the user interacts with the page. */
export function createAppUpdater(navigate: (url: URL) => void) {
  const currentVersion = documentVersion(document);

  const initialUrl = new URL(window.location.href);
  const attemptedVersion = initialUrl.searchParams.get(RELEASE_PARAM);
  if (currentVersion && attemptedVersion === currentVersion) {
    initialUrl.searchParams.delete(RELEASE_PARAM);
    window.history.replaceState(window.history.state, "", initialUrl);
  }

  let considered = false;
  const controller = new AbortController();
  const interactionEvents = [
    "pointerdown",
    "touchstart",
    "wheel",
    "keydown",
    "click",
    "input",
    "change",
  ];

  const dispose = () => {
    controller.abort();
    for (const event of interactionEvents) {
      document.removeEventListener(event, dispose, true);
    }
    document.removeEventListener("visibilitychange", onVisibilityChange);
  };
  const onVisibilityChange = () => {
    if (document.visibilityState !== "visible") dispose();
  };
  for (const event of interactionEvents) {
    document.addEventListener(event, dispose, { capture: true, passive: true });
  }
  document.addEventListener("visibilitychange", onVisibilityChange);

  const handleVersion = async ({ version }: { version: string }) => {
    if (considered) return;
    considered = true;
    let timeout: number | undefined;
    try {
      if (
        controller.signal.aborted ||
        !currentVersion ||
        !canRefresh() ||
        version === currentVersion ||
        version === attemptedVersion ||
        Math.random() >= ROLLOUT_FRACTION
      )
        return;
      timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      // Refresh the ordinary URL's HTTP cache too, so the next visit does not
      // fall back to its old HTML. Check for a partially uploaded deployment.
      const url = new URL(window.location.href);
      url.searchParams.delete(RELEASE_PARAM);
      const htmlResponse = await fetch(url.href, {
        cache: "reload",
        signal: controller.signal,
      });
      if (!htmlResponse.ok) return;
      const html = new DOMParser().parseFromString(
        await htmlResponse.text(),
        "text/html",
      );
      if (documentVersion(html) !== version) return;
      if (controller.signal.aborted || !canRefresh()) return;

      // A new navigation cache key bypasses the old week-long HTML entry.
      // If the server still returns old HTML, the retained parameter prevents
      // that version from causing a refresh loop.
      url.searchParams.set(RELEASE_PARAM, version);
      navigate(url);
    } catch {
      // Network errors must leave the running map alone.
    } finally {
      if (timeout !== undefined) window.clearTimeout(timeout);
      dispose();
    }
  };

  return {
    handleVersion,
    dispose,
  };
}
