import { Overlay } from "./Overlay";
import { FeedbackForm } from "./Feedback";

// SVG content from maplibre-gl/src/css/svg/maplibregl-ctrl-attrib.svg
const infoIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" fill-rule="evenodd" viewBox="0 0 20 20" style="fill: #333; margin-top: 2px;">
  <path d="M4 10a6 6 0 1 0 12 0 6 6 0 1 0-12 0m5-3a1 1 0 1 0 2 0 1 1 0 1 0-2 0m0 3a1 1 0 1 1 2 0v3a1 1 0 1 1-2 0"/>
</svg>`;

function ExternalLink(props: { href: string; children: React.ReactNode }) {
  return (
    <a
      href={props.href}
      target="_blank"
      rel="noopener noreferrer"
      className="link"
    >
      {props.children}
    </a>
  );
}

export function InfoOverlay({ onClose }: { onClose: () => void }) {
  return (
    <Overlay onClose={onClose}>
      <h3>ZET uživo</h3>
      <p>
        <i>Napomena: Prikazivanje trasa vozila je eksperimentalno!</i>
      </p>
      <p>
        Sadrži informacije tijela javne vlasti u skladu s{" "}
        <ExternalLink href="https://data.gov.hr/otvorena-dozvola">
          Otvorenom dozvolom
        </ExternalLink>
        .<br />
        Podaci o vozilima:{" "}
        <ExternalLink href="https://www.zet.hr/odredbe/datoteke-u-gtfs-formatu/669">
          ZET GTFS
        </ExternalLink>
      </p>
      <p>
        Interaktivna karta:{" "}
        <ExternalLink href="https://maplibre.org/">MapLibre GL JS</ExternalLink>
      </p>
      <p>
        Podaci za kartu:{" "}
        <ExternalLink href="https://openfreemap.org/">OpenFreeMap</ExternalLink>
        {" | "}
        <ExternalLink href="https://openmaptiles.org/">
          OpenMapTiles
        </ExternalLink>
        {" | "}
        <ExternalLink href="https://www.openstreetmap.org/">
          OpenStreetMap
        </ExternalLink>
      </p>
      <p>
        <ExternalLink href="https://github.com/ikicic/zet">GitHub</ExternalLink>
        {" | "}
        <ExternalLink href="/privacy.html">
          Pravila privatnosti
        </ExternalLink>
      </p>
      <hr className="feedback-separator" />
      <FeedbackForm />
    </Overlay>
  );
}

export class InfoControl {
  private onShowInfo: () => void;

  constructor(onShowInfo: () => void) {
    this.onShowInfo = onShowInfo;
  }

  onAdd() {
    const container = document.createElement("div");
    container.className = "maplibregl-ctrl maplibregl-ctrl-group";

    const button = document.createElement("button");
    button.className = "maplibregl-ctrl-icon";
    button.innerHTML = infoIconSvg;
    button.title = "Informacije";
    button.addEventListener("click", this.onShowInfo);

    container.appendChild(button);
    return container;
  }

  onRemove() {}
}
