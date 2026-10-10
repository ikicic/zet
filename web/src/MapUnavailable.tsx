import { FeedbackForm } from "./Feedback";
import type { MapFailure } from "./GraphicsDiagnostics";
import { formatMapFailureMessage } from "./MapFailureMessage";

export function MapUnavailable({ failure }: { failure: MapFailure }) {
  const message = formatMapFailureMessage(failure);

  const webgl2 = failure.diagnostics?.webgl2;
  const webgl1 = failure.diagnostics?.webgl1;
  const webglUnavailable =
    webgl2?.map.contextCreated === false &&
    webgl2.relaxed?.contextCreated === false &&
    webgl1?.map.contextCreated === false &&
    webgl1.relaxed?.contextCreated === false;

  return (
    <main className="map-unavailable">
      <div>
        <h1>zet.skoljka.org - položaji ZET tramvaja i autobusa uživo</h1>
        <p>
          Dobrodošli na zet.skoljka.org!
        </p>
        <p>
          {webglUnavailable
            ? "Ova aplikacija zahtijeva WebGL, koji nije dostupan na Vašem uređaju ili u Vašem pregledniku."
            : "Došlo je do greške pri prikazu karte."}
        </p>
        <p>
          Pokušajte ponovno učitati stranicu ili je otvoriti u drugom pregledniku.
        </p>
        <p>
          Problem možete prijaviti putem obrasca ispod. Poruka uključuje
          tehničke podatke o Vašem uređaju koji nam pomažu pronaći uzrok i
          poboljšati aplikaciju. Po potrebi, poruku možete izmijeniti prije
          slanja. E-mail navedite ako želite da Vas kontaktiramo, npr. ako
          dodamo podršku za Vaš uređaj.
        </p>
        <FeedbackForm
          initialMessage={message}
          title="Zahtjev za podršku"
          kind="map-error"
        />
      </div>
    </main>
  );
}
