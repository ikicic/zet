export function getUrl(
  schema: string,
  secureSchema: string,
  path: string
) {
  return window.location.protocol === "https:"
    ? `${secureSchema}://${window.location.host}/${path}`
    : `${schema}://${window.location.hostname}:5000/${path}`;
}

export function getHttpUrl(path: string) {
  return getUrl("http", "https", path);
}
