import { FeedbackForm } from "./Feedback";

export function MapUnavailable() {
  const message = `Pozdrav,

karta se ne može prikazati na mojem uređaju. Molim vas za podršku za moj uređaj i preglednik.

Automatski podaci preglednika i operacijskog sustava:
${navigator.userAgent}`;

  return (
    <main className="map-unavailable">
      <div>
        <p>Ova stranica prikazuje položaje ZET-ovih tramvaja i autobusa uživo.</p>
        <h1>Kartu nije moguće prikazati</h1>
        <p>
          Za prikaz karte potreban je WebGL2, koji možda nije dostupan na vašem
          uređaju ili u vašem pregledniku.
        </p>
        <p>
          Želite li podršku za svoj uređaj? Kliknite „Pošalji” kako biste nam
          poslali pripremljenu poruku s podacima Vašeg preglednika. Poruku možete
          izmijeniti, a e-mail navesti ako želite odgovor.
        </p>
        <FeedbackForm initialMessage={message} title="Zahtjev za podršku" />
      </div>
    </main>
  );
}
