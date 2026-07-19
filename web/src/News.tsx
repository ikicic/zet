import { memo } from "react";
import { Overlay } from "./Overlay";
import "./News.css";

export type NewsKind = "traffic" | "news";

export interface NewsItem {
  id: string;
  kind: NewsKind;
  publishedAt: number;
  title: string;
  summaryHtml: string;
  url: string;
}

export interface NewsSnapshot {
  version: string;
  fetchedAt: number;
  items: NewsItem[];
}

export interface NewsStatus {
  version: string;
  latestAt: number | null;
}

export const NEWS_SEEN_VERSION_KEY = "zet-news-seen-version-v1";
const LEGACY_NEWS_STORAGE_KEYS = ["zet-news-snapshot-v1", "zet-news-seen-v1"];
const ZAGREB_TIME_ZONE = "Europe/Zagreb";
const MAX_NEWS_ITEMS = 30;
const MAX_NEWS_ID_LENGTH = 512;
const MAX_NEWS_TITLE_LENGTH = 250;
const MAX_NEWS_URL_LENGTH = 2048;
const MAX_NEWS_SUMMARY_HTML_LENGTH = 8192;
const MAX_NEWS_TIMESTAMP = 4102444800; // 2100-01-01
const SAFE_SUMMARY_TAGS = new Set([
  "strong",
  "b",
  "em",
  "i",
  "br",
  "p",
  "ul",
  "ol",
  "li",
]);
const newsIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="14" height="14" rx="1.5"/><path d="M6 7h3v3H6zM11 7h3M11 10h3M6 13h8"/></svg>`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

function isNewsTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_NEWS_TIMESTAMP
  );
}

function isZetUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > MAX_NEWS_URL_LENGTH) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "zet.hr" || url.hostname === "www.zet.hr")
    );
  } catch {
    return false;
  }
}

function isSafeSummaryHtml(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length > MAX_NEWS_SUMMARY_HTML_LENGTH
  ) {
    return false;
  }
  const document = new DOMParser().parseFromString(value, "text/html");
  const hasOnlySafeNodes = (node: Node): boolean => {
    for (const child of node.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType !== Node.ELEMENT_NODE) return false;
      const element = child as Element;
      if (
        !SAFE_SUMMARY_TAGS.has(element.tagName.toLowerCase()) ||
        element.attributes.length !== 0 ||
        !hasOnlySafeNodes(element)
      ) {
        return false;
      }
    }
    return true;
  };
  return hasOnlySafeNodes(document.body);
}

function isNewsItem(value: unknown): value is NewsItem {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    value.id.length > 0 &&
    value.id.length <= MAX_NEWS_ID_LENGTH &&
    (value.kind === "traffic" || value.kind === "news") &&
    isNewsTimestamp(value.publishedAt) &&
    typeof value.title === "string" &&
    value.title.length > 0 &&
    value.title.length <= MAX_NEWS_TITLE_LENGTH &&
    isSafeSummaryHtml(value.summaryHtml) &&
    isZetUrl(value.url)
  );
}

export function isNewsSnapshot(value: unknown): value is NewsSnapshot {
  if (
    !isRecord(value) ||
    typeof value.version !== "string" ||
    !/^[0-9a-f]{16}$/.test(value.version) ||
    !isNewsTimestamp(value.fetchedAt) ||
    !Array.isArray(value.items) ||
    value.items.length > MAX_NEWS_ITEMS ||
    !value.items.every(isNewsItem)
  ) {
    return false;
  }
  return (
    new Set(value.items.map((item) => item.id)).size === value.items.length
  );
}

export function isNewsStatus(value: unknown): value is NewsStatus {
  return (
    isRecord(value) &&
    value.type === "news-status" &&
    typeof value.version === "string" &&
    /^[0-9a-f]{16}$/.test(value.version) &&
    (value.latestAt === null || isNewsTimestamp(value.latestAt))
  );
}

export function deserializeSeenNewsVersion(value: string): string | null {
  const version: unknown = JSON.parse(value);
  if (version === null) return null;
  if (typeof version !== "string" || !/^[0-9a-f]{16}$/.test(version)) {
    throw new Error("Invalid saved seen-news version");
  }
  return version;
}

export function removeLegacyNewsStorage(): void {
  for (const key of LEGACY_NEWS_STORAGE_KEYS) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Storage can be unavailable in private browsing modes.
    }
  }
}

function dayKey(timestamp: number): string {
  const parts = new Intl.DateTimeFormat("en", {
    timeZone: ZAGREB_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(timestamp * 1000));
  const part = (type: string) =>
    parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function previousDayKey(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  const previousDay = new Date(Date.UTC(year, month - 1, day - 1));
  const pad = (part: number) => part.toString().padStart(2, "0");
  return `${previousDay.getUTCFullYear()}-${pad(previousDay.getUTCMonth() + 1)}-${pad(previousDay.getUTCDate())}`;
}

function isTodayOrYesterday(timestamp: number): boolean {
  const today = dayKey(Date.now() / 1000);
  const itemDay = dayKey(timestamp);
  return itemDay === today || itemDay === previousDayKey(today);
}

export function hasUnseenNews(
  status: NewsStatus | null,
  seenVersion: string | null,
): boolean {
  return (
    status != null &&
    status.latestAt != null &&
    seenVersion != null &&
    status.version !== seenVersion &&
    isTodayOrYesterday(status.latestAt)
  );
}

function formatDate(timestamp: number): string {
  return new Intl.DateTimeFormat("hr-HR", {
    timeZone: ZAGREB_TIME_ZONE,
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(timestamp * 1000));
}

export const NewsOverlay = memo(function NewsOverlay({
  snapshot,
  state,
  onClose,
}: {
  snapshot: NewsSnapshot | null;
  state: "error" | "empty" | "ready";
  onClose: () => void;
}) {
  const items = snapshot?.items ?? [];
  return (
    <Overlay
      onClose={onClose}
      className="news-overlay-content"
      showCloseButton={false}
    >
      <div className="news-overlay">
        <div className="news-header">
          <h3>Obavijesti ZET-a</h3>
          <button
            className="news-close-button"
            type="button"
            onClick={onClose}
            aria-label="Zatvori obavijesti"
          >
            ✕
          </button>
        </div>
        {state === "error" ? (
          <p>Došlo je do pogreške pri učitavanju obavijesti.</p>
        ) : state === "empty" ? (
          <p>Nema pronađenih obavijesti.</p>
        ) : items.length === 0 ? (
          <p>Nema pronađenih obavijesti.</p>
        ) : (
          <div className="news-list">
            {items.map((item) => (
              <article
                key={item.id}
                className={`news-item news-item-${item.kind}`}
              >
                <div className="news-item-kind">
                  {item.kind === "traffic" ? "Promet" : "Vijesti"}
                </div>
                <a href={item.url} target="_blank" rel="noopener noreferrer">
                  {item.title}
                </a>
                <time>{formatDate(item.publishedAt)}</time>
                {item.summaryHtml && (
                  <div
                    className="news-item-summary"
                    dangerouslySetInnerHTML={{ __html: item.summaryHtml }}
                  />
                )}
              </article>
            ))}
          </div>
        )}
      </div>
    </Overlay>
  );
});

export class NewsControl {
  private readonly onShow: () => void;
  private dot: HTMLSpanElement | null = null;
  private button: HTMLButtonElement | null = null;

  constructor(onShow: () => void) {
    this.onShow = onShow;
  }

  onAdd() {
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group news-control";

    const button = document.createElement("button");
    button.type = "button";
    button.className = "maplibregl-ctrl-icon";
    button.innerHTML = newsIconSvg;
    button.title = "Obavijesti ZET-a";
    button.setAttribute("aria-label", button.title);
    button.addEventListener("click", this.onShow);
    this.button = button;

    this.dot = document.createElement("span");
    this.dot.className = "news-control-dot";
    this.dot.hidden = true;
    button.appendChild(this.dot);
    container.appendChild(button);
    return container;
  }

  setBadge(hasUnreadNews: boolean) {
    if (!this.dot) return;
    this.dot.hidden = !hasUnreadNews;
  }

  setLoading(loading: boolean) {
    if (!this.button) return;
    this.button.disabled = loading;
    this.button.classList.toggle("news-control-loading", loading);
  }

  onRemove() {
    this.dot = null;
    this.button = null;
  }
}
