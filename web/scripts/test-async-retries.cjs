// Real React commits with a controlled clock: no wall-clock waits for retry delays.
module.exports = async function retryTests() {
  const {
    React,
    createRoot,
    useAsyncData,
    fetchJson,
    isRetryableFetchError,
    decompressBigStaticData,
  } = window.selectionModules;
  const { act, createElement, useEffect, StrictMode } = React;
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const original = {
    setTimeout: window.setTimeout,
    clearTimeout: window.clearTimeout,
    now: Date.now,
    fetch: window.fetch,
  };
  let now = original.now(),
    timerId = -1,
    resource,
    calls = 0,
    behavior;
  const timers = new Map(),
    commits = [];
  window.setTimeout = (fn, delay, ...args) => {
    if (!(delay > 0))
      return original.setTimeout.call(window, fn, delay, ...args);
    const id = timerId--;
    timers.set(id, { at: now + delay, fn: () => fn(...args) });
    return id;
  };
  window.clearTimeout = (id) => {
    if (!timers.delete(id)) original.clearTimeout.call(window, id);
  };
  Date.now = () => now;
  window.fetch = async () => {
    calls++;
    return behavior();
  };
  window.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const response = (body, { status = 200 } = {}) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  });
  const loader = (key) => fetchJson(`/test/${key}`);
  function Resource({ resourceKey, vehicle, load }) {
    resource = useAsyncData(resourceKey, load, {
      shouldRetry: isRetryableFetchError,
    });
    useEffect(() => {
      commits.push({ ...resource, vehicle });
    });
    return null;
  }
  const show = (resourceKey, vehicle = "a", load = loader) =>
    act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(Resource, { resourceKey, vehicle, load }),
        ),
      );
    });
  const advance = async (milliseconds) => {
    const end = now + milliseconds;
    while (true) {
      const next = [...timers]
        .filter(([, t]) => t.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      await act(async () => next[1].fn());
    }
    now = end;
  };
  try {
    behavior = () => {
      throw new TypeError("offline");
    };
    await show("network");
    check(
      calls === 1 && resource.loading,
      "StrictMode duplicated the first attempt",
    );
    await show("network", "b");
    await advance(2999);
    check(calls === 1, "Switching vehicles or the timer retried too soon");
    await advance(1);
    check(
      calls === 2 && resource.loading,
      "First retry did not run after 3 seconds",
    );
    await show(null);
    await advance(1000);
    await show("network", "c");
    await advance(4999);
    check(calls === 2, "Re-enabling reset the second retry's delay");
    await advance(1);
    check(
      calls === 3 && !resource.loading && resource.error,
      "Retry budget was not exhausted after three attempts",
    );
    const failure = resource.error;
    await show("network", "d");
    await show(null);
    commits.length = 0;
    await show("network", "e");
    await advance(60000);
    check(
      calls === 3 &&
        resource.error === failure &&
        commits.every((s) => !s.loading && s.error === failure),
      "Clicks or re-enabling restarted an exhausted request",
    );

    calls = 0;
    behavior = () =>
      calls === 1 ? response("busy", { status: 503 }) : response('{"ok":true}');
    await show("recovery");
    await advance(3000);
    check(
      calls === 2 && resource.data.ok && !resource.loading,
      "Temporary HTTP error did not recover",
    );
    await show(null);
    commits.length = 0;
    await show("recovery");
    check(
      calls === 2 && commits.every((s) => s.data?.ok && !s.loading),
      "Cached success became loading again",
    );

    calls = 0;
    behavior = () => response("{" + "x".repeat(500000));
    await show("broken-json");
    const parseError = resource.error;
    check(
      parseError instanceof SyntaxError && !resource.loading,
      "Invalid JSON was not terminal",
    );
    await show("broken-json", "other");
    await show(null);
    await show("broken-json");
    await advance(60000);
    check(
      calls === 1 && resource.error === parseError,
      "Broken JSON was repeatedly downloaded",
    );

    calls = 0;
    behavior = () => response("{}");
    const decode = async (key) => decompressBigStaticData(await loader(key));
    await show("bad-shape-data", "a", decode);
    const decodeError = resource.error;
    check(
      decodeError && !resource.loading,
      "Invalid decoded data was not terminal",
    );
    await show(null, "a", decode);
    await show("bad-shape-data", "b", decode);
    await advance(60000);
    check(
      calls === 1 && resource.error === decodeError,
      "Decompression failure triggered another download",
    );

    calls = 0;
    behavior = () => response("missing", { status: 404 });
    await show("not-found");
    await advance(60000);
    check(
      calls === 1 && !resource.loading && resource.error,
      "Permanent HTTP error was retried",
    );

    calls = 0;
    behavior = () => ({
      ok: true,
      text: async () => {
        throw new TypeError("body interrupted");
      },
    });
    await show("interrupted");
    await advance(3000);
    check(calls === 2, "Interrupted response body was not retried");
    await show(null);
    await advance(60000);
    check(calls === 2, "Disabled resource continued retrying");
    behavior = () => response("42");
    await show("interrupted");
    check(
      calls === 3 && resource.data === 42,
      "Re-enabling did not resume the remaining retry",
    );

    calls = 0;
    behavior = () => {
      throw new TypeError("offline");
    };
    await show("obsolete");
    await show("active");
    behavior = () => response("7");
    await advance(3000);
    check(
      calls === 3 && resource.data === 7,
      "Obsolete resource retried or replaced active data",
    );

    let finish;
    calls = 0;
    behavior = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    await show("finish-disabled");
    await show(null);
    await act(async () => finish(response("123")));
    commits.length = 0;
    await show("finish-disabled");
    check(
      calls === 1 && commits.every((s) => s.data === 123 && !s.loading),
      "A download completed while disabled was not immediately available",
    );

    behavior = () => {
      throw new TypeError("offline");
    };
    await show("unmount");
  } finally {
    await act(async () => root.unmount());
    const before = calls;
    await advance(60000);
    window.setTimeout = original.setTimeout;
    window.clearTimeout = original.clearTimeout;
    Date.now = original.now;
    window.fetch = original.fetch;
    window.IS_REACT_ACT_ENVIRONMENT = false;
    container.remove();
    check(calls === before, "Unmounted resource continued retrying");
  }
  return [
    "Async retries stop after two delays, skip broken JSON, pause when disabled and preserve settled cache states",
  ];
};
