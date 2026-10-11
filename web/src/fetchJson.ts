class RetryableFetchError extends Error {}

export function isRetryableFetchError(error: unknown): boolean {
  return error instanceof RetryableFetchError;
}

/** Mark transport and temporary HTTP failures separately from invalid JSON. */
export async function fetchJson<T>(url: string): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new RetryableFetchError(`Download failed: ${String(error)}`);
  }
  if (!response.ok) {
    const ErrorType =
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500
        ? RetryableFetchError
        : Error;
    throw new ErrorType(`HTTP ${response.status}`);
  }
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw new RetryableFetchError(`Download interrupted: ${String(error)}`);
  }
  // Parsing errors are terminal: downloading the same broken payload won't help.
  return JSON.parse(text) as T;
}
