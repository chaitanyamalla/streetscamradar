import DestinationExplorer from "./components/DestinationExplorer";
import CitySearch from "./components/CitySearch";


export default function Home() {
  return (
    <main className="min-h-screen bg-slate-950 text-white">
      {/* Header */}
      <header className="border-b border-white/10">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-5">
          <div>
            <h1 className="text-xl font-bold tracking-tight">
              StreetScamRadar
            </h1>
            <p className="text-xs text-slate-400">
              Know before you go.
            </p>
          </div>

          <button className="rounded-full border border-white/15 px-4 py-2 text-sm text-slate-300 hover:bg-white/10">
            Sign in
          </button>
        </div>
      </header>

      {/* Hero */}
      <section className="mx-auto flex max-w-7xl flex-col items-center px-6 pb-16 pt-20 text-center">
        <div className="mb-5 rounded-full border border-amber-400/30 bg-amber-400/10 px-4 py-2 text-sm text-amber-300">
          Travel safety intelligence
        </div>

        <h2 className="max-w-3xl text-5xl font-bold tracking-tight sm:text-6xl">
          Know the risks
          <br />
          <span className="text-amber-400">Avoid the traps</span>
          <br />
          <span className="text-amber-400">Travel smarter</span>
        </h2>

        <p className="mt-6 max-w-2xl text-lg leading-8 text-slate-400">
          Discover scams, tourist traps, safety reports and official travel
          information before and during your journey.
        </p>


      </section>
      {/* Destination explorer */}
      <section className="mx-auto max-w-7xl px-6 pb-20">
        <DestinationExplorer />
      </section>


      {/* Information cards */}
      <section className="mx-auto grid max-w-7xl gap-5 px-6 pb-24 md:grid-cols-3">
        <InfoCard
          icon="⚠️"
          title="Scam reports"
          text="See recent reports from travelers and local users."
        />

        <InfoCard
          icon="🏛️"
          title="Official information"
          text="Bring together relevant government and public safety information."
        />

        <InfoCard
          icon="🛡️"
          title="Trusted places"
          text="Discover legitimate services and businesses as the network grows."
        />
      </section>

      {/* Footer */}
      <footer className="border-t border-white/10 px-6 py-8 text-center text-sm text-slate-500">
        StreetScamRadar — Travel smarter. Stay safer.
      </footer>
    </main>
  );
}

function InfoCard({
  icon,
  title,
  text,
}: {
  icon: string;
  title: string;
  text: string;
}) {
  return (
    <div className="rounded-2xl border border-white/10 bg-slate-900 p-6">
      <div className="mb-4 text-3xl">{icon}</div>
      <h3 className="text-lg font-semibold">{title}</h3>
      <p className="mt-2 text-sm leading-6 text-slate-400">{text}</p>
    </div>
  );
}