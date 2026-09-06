"use client";

import { useState } from "react";
import CitySearch from "./CitySearch";
import MapWrapper from "./MapWrapper";

export default function DestinationExplorer() {
  const [city, setCity] = useState("Barcelona");

  return (
    <>
        <div className="flex justify-center">
         <CitySearch onCitySelect={setCity} />
        </div>

      <div className="mt-8 overflow-hidden rounded-2xl border border-white/10 bg-slate-900">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div>
            <p className="font-semibold">{city}</p>
            <p className="text-sm text-slate-500">
              Safety intelligence preview
            </p>
          </div>

          <span className="rounded-full bg-amber-400/10 px-3 py-1 text-xs text-amber-300">
            DEMO DATA
          </span>
        </div>

        <div className="relative h-[600px] w-full">
            <MapWrapper city={city} />
        </div>
      </div>
    </>
  );
}