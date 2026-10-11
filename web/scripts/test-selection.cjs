// Exercise lazy route loading with real React effects and automatic batching.
module.exports = async function selectionTests() {
  const { React, createRoot, useAsyncData } = window.selectionModules;
  const { act, createElement, useEffect, StrictMode } = React;
  window.IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const pending = new Map(),
    calls = [],
    changes = [];
  let displayed = null;
  let status;
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const fetchData = (key) => {
    calls.push(key);
    return new Promise((resolve, reject) =>
      pending.set(key, { resolve, reject }),
    );
  };
  const shape = (id) => ({
    id,
    lats: [1, 2],
    lons: [3, 4],
    stops: { lats: [1], lons: [3] },
  });
  const a = shape("a"),
    b = shape("b");
  const data = { shapes: { a, b } };
  function Selection({ id, version }) {
    status = useAsyncData(id ? version : null, fetchData);
    const selected = id ? (status.data?.shapes[id] ?? null) : null;
    useEffect(() => {
      displayed = selected;
      changes.push(selected);
    }, [selected]);
    return null;
  }
  const select = (id, version) =>
    act(async () => {
      root.render(
        createElement(
          StrictMode,
          null,
          createElement(Selection, { id, version }),
        ),
      );
    });
  const finish = (key, value = data) =>
    act(async () => {
      pending.get(key).resolve(value);
    });
  try {
    await select(null, "first");
    check(
      calls.length === 0,
      "Static data loaded before a vehicle was selected",
    );
    check(
      !status.loading && status.data === undefined && status.error === null,
      "Disabled resource was not idle",
    );
    await select("a", "first");
    check(displayed === null, "Route displayed before its data loaded");
    check(
      status.loading && status.error === null,
      "Pending resource was not loading",
    );
    await finish("first");
    check(
      displayed === a && displayed.stops.lats.length === 1,
      "First lazy load did not publish the route and stops without another click",
    );
    check(changes.at(-1) === a, "Cache completion cleared the selected route");
    check(
      status.data === data && !status.loading && status.error === null,
      "Resolved resource did not expose its data",
    );
    await select("b", "first");
    check(
      displayed === b && calls.length === 1,
      "Cached selection fetched again or did not redraw",
    );

    await select("a", "second");
    check(
      displayed === null,
      "Old data remained visible after the static key changed",
    );
    await select("b", "second");
    await finish("second");
    check(
      displayed === b && calls.filter((key) => key === "second").length === 1,
      "Switching vehicles during download did not share the request or selected the wrong route",
    );

    await select("a", "third");
    await select(null, "third");
    await finish("third");
    check(displayed === null, "Late response restored a deselected route");
    await select("b", "third");
    check(
      displayed === b && calls.filter((key) => key === "third").length === 1,
      "Completed deselected download was not cached",
    );

    await select("a", "old");
    await select("b", "new");
    await finish("old");
    check(displayed === null, "Old static data replaced the active version");
    const updated = shape("b");
    await finish("new", { shapes: { b: updated } });
    check(
      displayed === updated,
      "New static data did not refresh the selected route",
    );

    await select("a", "retry");
    const failure = new Error("test network failure");
    await act(async () => pending.get("retry").reject(failure));
    check(
      displayed === null && status.error === failure && !status.loading,
      "Failed download retained a route or did not expose its error",
    );
    await select(null, "retry");
    await select("a", "retry");
    check(
      !status.loading &&
        status.error === failure &&
        calls.filter((key) => key === "retry").length === 1,
      "Re-enabling a terminal failure restarted its download",
    );
    await select("a", "recovered");
    await finish("recovered");
    check(
      displayed === a,
      "A new resource could not load after a previous failure",
    );

    await select("missing", "recovered");
    check(displayed === null, "Missing shape retained the previous route");
    await select("a", "unmount");
  } finally {
    await act(async () => root.unmount());
    container.remove();
    window.IS_REACT_ACT_ENVIRONMENT = false;
  }
  const lastChangeCount = changes.length;
  await finish("unmount");
  check(
    changes.length === lastChangeCount,
    "Unmounted selection published a late route",
  );

  // The same hook also handles non-route data and keys, without map dependencies.
  window.IS_REACT_ACT_ENVIRONMENT = true;
  const resourceContainer = document.createElement("div");
  document.body.appendChild(resourceContainer);
  const resourceRoot = createRoot(resourceContainer);
  let resource,
    textLoads = 0,
    oldReject,
    newResolve;
  const textLoader = async (key) => {
    textLoads++;
    return `text:${key}`;
  };
  const replacementLoader = async (key) => `replacement:${key}`;
  const commits = [];
  function Resource({ resourceKey, loader }) {
    resource = useAsyncData(resourceKey, loader);
    useEffect(() => {
      commits.push(resource);
    });
    return null;
  }
  const show = (resourceKey, loader) =>
    act(async () => {
      resourceRoot.render(
        createElement(
          StrictMode,
          null,
          createElement(Resource, { resourceKey, loader }),
        ),
      );
    });
  try {
    await show("", textLoader);
    check(
      resource.data === "text:" && !resource.loading && textLoads === 1,
      "Empty-string keys or StrictMode request reuse failed",
    );
    await show(null, textLoader);
    check(
      resource.data === undefined && !resource.loading,
      "Disabled resource exposed old data",
    );
    commits.length = 0;
    await show("", textLoader);
    check(
      resource.data === "text:" && textLoads === 1,
      "Re-enabling discarded the cached result",
    );
    check(
      commits.every((value) => value.data === "text:" && !value.loading),
      "Re-enabling cached data briefly cleared it or showed loading",
    );
    await show("", replacementLoader);
    check(
      resource.data === "replacement:",
      "Changing the loader reused incompatible cached data",
    );
    const thrown = new Error("synchronous loader failure");
    await show("throw", () => {
      throw thrown;
    });
    check(
      resource.error === thrown && !resource.loading,
      "Synchronous loader failure escaped error handling",
    );

    const slowLoader = (key) =>
      new Promise((resolve, reject) => {
        if (key === "old") oldReject = reject;
        else newResolve = resolve;
      });
    await show("old", slowLoader);
    await show("new", slowLoader);
    await act(async () => oldReject(new Error("stale failure")));
    check(
      resource.loading && resource.error === null,
      "Stale failure replaced the current resource state",
    );
    await act(async () => newResolve(42));
    check(
      resource.data === 42 && !resource.loading,
      "Generic numeric result was not published",
    );
    await show(null, slowLoader);
    await show("new", slowLoader);
    check(
      resource.data === 42 && !resource.loading,
      "Stale failure cleared the newer request cache",
    );
  } finally {
    await act(async () => resourceRoot.unmount());
    resourceContainer.remove();
    window.IS_REACT_ACT_ENVIRONMENT = false;
  }
  return [
    "Lazy route loading redraws after first download, reuses cache and ignores stale selections",
    "useAsyncData supports generic values, loading/errors, loader changes and StrictMode caching",
  ];
};
