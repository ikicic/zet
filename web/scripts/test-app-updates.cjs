// Real DOM/URL handling; announcements and HTML fetches are controlled.
module.exports = async function appUpdateTests() {
  const { createAppUpdater } = window.appUpdateModules;
  const passed = [];
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const original = {
    fetch: window.fetch,
    random: Math.random,
    getItem: Storage.prototype.getItem,
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    url: location.href,
  };
  const oldVersion = "a".repeat(20),
    newVersion = "b".repeat(20);
  const meta = document.createElement("meta");
  meta.name = "app-version";
  meta.content = oldVersion;
  document.head.append(meta);
  const timers = new Map();
  let nextTimer = -1,
    updater,
    calls,
    navigations,
    htmlVersion,
    fail,
    pending,
    onHtml;
  let draws = 0,
    randomValue;
  Math.random = () => {
    draws++;
    return randomValue;
  };
  window.setTimeout = (fn) => {
    const id = nextTimer--;
    timers.set(id, fn);
    return id;
  };
  window.clearTimeout = (id) => timers.delete(id);
  window.fetch = async (url, options) => {
    calls.push({ url: String(url), ...options });
    if (fail) throw new TypeError("offline");
    if (pending) await pending;
    if (options.signal.aborted) throw new DOMException("Aborted", "AbortError");
    onHtml?.();
    return {
      ok: true,
      text: async () => `<meta name="app-version" content="${htmlVersion}">`,
    };
  };
  const start = () => {
    updater = createAppUpdater((url) => navigations.push(url));
  };
  const announce = (version = newVersion) =>
    updater.handleVersion({ type: "app-version", version });
  const reset = (bucket = 0.05) => {
    updater?.dispose();
    calls = [];
    navigations = [];
    fail = false;
    pending = null;
    onHtml = null;
    htmlVersion = newVersion;
    meta.content = oldVersion;
    history.replaceState(null, "", original.url);
    randomValue = bucket;
    start();
  };
  try {
    reset(0.25);
    check(
      calls.length === 0 && timers.size === 0 && draws === 0,
      "Starting the updater fetched a file, scheduled polling or drew before an announcement",
    );
    await announce();
    randomValue = 0.05;
    await announce();
    check(
      draws === 1 && calls.length === 0,
      "A WebSocket reconnect rerolled the decision for this visit",
    );
    updater.dispose();
    start();
    await announce();
    check(
      draws === 2 && calls.length === 1 && navigations.length === 1,
      "A new page visit did not get a fresh 10% chance",
    );
    reset(0.1);
    await announce();
    check(calls.length === 0, "The 10% boundary was included in the rollout");
    reset();
    history.replaceState({ test: true }, "", "?perf=1#map");
    await announce();
    check(
      calls.length === 1 && navigations.length === 1,
      "Eligible announcement did not fetch HTML and navigate",
    );
    check(
      calls[0].cache === "reload" && !calls[0].url.includes("version.json"),
      "Update fetched the manifest or reused cached HTML",
    );
    const target = navigations[0];
    check(
      target.searchParams.get("__release") === newVersion &&
        target.searchParams.get("perf") === "1" &&
        target.hash === "#map",
      "Navigation lost URL state or version",
    );
    await announce();
    check(
      navigations.length === 1,
      "Repeated announcement scheduled another navigation",
    );
    passed.push(
      "Only the first startup announcement gets a 10% chance; new visits get a fresh draw",
    );

    reset();
    const previousDraws = draws;
    await announce(oldVersion);
    await announce();
    check(
      calls.length === 0 && navigations.length === 0 && draws === previousDraws,
      "An unchanged startup version or a later deployment triggered an update",
    );
    reset();
    meta.remove();
    updater.dispose();
    start();
    await announce();
    check(
      calls.length === 0,
      "Document without a production version attempted an update",
    );
    document.head.append(meta);
    passed.push(
      "Unchanged versions and documents without a production version do not fetch anything",
    );

    for (const mode of ["network error", "stale HTML"]) {
      reset();
      fail = mode === "network error";
      htmlVersion = oldVersion;
      await announce();
      fail = false;
      htmlVersion = newVersion;
      await announce();
      await announce("c".repeat(20));
      check(
        calls.length === 1 && navigations.length === 0,
        "Reconnect or another release retried a failed startup update",
      );
      updater.dispose();
      start();
      await announce();
      check(
        navigations.length === 1,
        "New page visit did not retry the completed deployment",
      );
    }
    reset();
    updater.dispose();
    history.replaceState(null, "", `?__release=${newVersion}`);
    start();
    await announce();
    check(calls.length === 0, "Stale HTML caused a refresh loop");
    reset();
    updater.dispose();
    meta.content = newVersion;
    history.replaceState(
      { test: true },
      "",
      `?perf=1&__release=${newVersion}#map`,
    );
    start();
    check(
      location.search === "?perf=1" &&
        location.hash === "#map" &&
        history.state.test,
      "Successful navigation did not clean URL and preserve history state",
    );
    passed.push(
      "Failed deployments do not retry on reconnect or loop on stale HTML",
    );

    reset();
    updater.dispose();
    Storage.prototype.getItem = () => {
      throw new Error("Storage blocked");
    };
    start();
    await announce();
    check(
      calls.length === 1 && navigations.length === 1,
      "Unavailable storage blocked an automatic refresh",
    );
    Storage.prototype.getItem = original.getItem;
    passed.push("Automatic refreshes work without browser storage");

    const overlay = document.createElement("div");
    overlay.className = "overlay";
    const draft = document.createElement("textarea");
    draft.value = "Unsent message";
    for (const busy of [overlay, "hidden"]) {
      reset();
      if (busy === "hidden")
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "hidden",
        });
      else document.body.append(busy);
      await announce();
      if (busy === "hidden") delete document.visibilityState;
      else busy.remove();
      await announce();
      check(
        calls.length === 0,
        "A busy startup was reconsidered later in the visit",
      );
    }
    reset();
    document.body.append(draft);
    await announce();
    check(
      navigations.length === 1,
      "Untouched prefilled diagnostics blocked an update",
    );
    draft.remove();
    reset();
    document.body.append(draft);
    draft.value = "Edited report";
    draft.dispatchEvent(new Event("input", { bubbles: true }));
    draft.value = "Unsent message";
    draft.blur();
    await announce();
    check(
      calls.length === 0,
      "An edited then restored/unfocused report did not cancel the update",
    );
    draft.remove();
    reset();
    onHtml = () => document.body.append(overlay);
    await announce();
    overlay.remove();
    onHtml = null;
    await announce();
    check(
      navigations.length === 0 && calls.length === 1,
      "A dialog opened during fetch did not cancel the startup update for this visit",
    );
    passed.push(
      "Hidden or busy startup skips the update for the visit, including dialogs opened during fetch",
    );

    for (const event of [
      "pointerdown",
      "touchstart",
      "wheel",
      "keydown",
      "click",
      "input",
      "change",
    ]) {
      reset();
      document.dispatchEvent(new Event(event));
      await announce();
      check(
        calls.length === 0,
        `${event} before announcement did not cancel the update`,
      );
    }
    for (const event of [
      "pointerdown",
      "touchstart",
      "wheel",
      "keydown",
      "click",
      "input",
      "change",
      "hidden",
    ]) {
      reset();
      let resolve;
      pending = new Promise((done) => {
        resolve = done;
      });
      const running = announce();
      if (event === "hidden") {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "hidden",
        });
        document.dispatchEvent(new Event("visibilitychange"));
        delete document.visibilityState;
        document.dispatchEvent(new Event("visibilitychange"));
      } else {
        document.dispatchEvent(new Event(event));
      }
      check(
        calls[0].signal.aborted,
        `${event} did not abort the pending fetch`,
      );
      resolve();
      await running;
      await announce();
      check(
        navigations.length === 0 && calls.length === 1,
        `${event} allowed a refresh after user activity`,
      );
    }
    passed.push(
      "Interaction and temporary backgrounding cancel pending updates without losing map state",
    );

    for (const cancel of ["timeout", "dispose"]) {
      reset();
      let resolve;
      pending = new Promise((done) => {
        resolve = done;
      });
      const running = announce();
      await announce();
      check(calls.length === 1, "Announcements overlapped requests");
      if (cancel === "timeout") for (const fn of timers.values()) fn();
      else updater.dispose();
      resolve();
      await running;
      check(
        calls[0].signal.aborted &&
          navigations.length === 0 &&
          timers.size === 0,
        "Cancellation left a request, timer or navigation active",
      );
    }
    passed.push(
      "Refresh checks serialize requests, time out and dispose safely",
    );
    return passed;
  } finally {
    updater?.dispose();
    meta.remove();
    delete document.visibilityState;
    history.replaceState(null, "", original.url);
    window.fetch = original.fetch;
    Math.random = original.random;
    window.setTimeout = original.setTimeout;
    window.clearTimeout = original.clearTimeout;
    Storage.prototype.getItem = original.getItem;
  }
};
