"use client";

import { useState } from "react";

const cities = ["Barcelona", "Berlin"];

export default function CitySearch({
  onCitySelect,
}: {
  onCitySelect: (city: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [selectedCity, setSelectedCity] = useState("");
    const [showSuggestions, setShowSuggestions] = useState(true);
  const filteredCities = cities.filter((city) =>
    city.toLowerCase().includes(query.toLowerCase()),
  );

  return (
    <div className="relative mt-10 w-full max-w-2xl">
      <div className="flex w-full flex-col gap-3 sm:flex-row">
        <input
          type="text"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedCity("");
            setShowSuggestions(true);
          }}
          placeholder="Where are you going? e.g. Barcelona"
          className="h-14 flex-1 rounded-xl border border-white/10 bg-white/5 px-5 text-white outline-none placeholder:text-slate-500 focus:border-amber-400"
        />

        <button
          type="button"
          onClick={() => {
            if (query.trim()) {
                setSelectedCity(query.trim());
                setShowSuggestions(false);
                onCitySelect(query.trim());
            }
            }}
          className="h-14 rounded-xl bg-amber-400 px-7 font-semibold text-slate-950 hover:bg-amber-300"
        >
          Explore
        </button>
      </div>

      {query && showSuggestions && filteredCities.length > 0 && (
        <div className="absolute left-0 right-0 top-[68px] z-50 overflow-hidden rounded-xl border border-white/10 bg-slate-900 text-left shadow-xl">
          {filteredCities.map((city) => (
            <button
              key={city}
              type="button"
                onClick={() => {
                    setQuery(city);
                    setSelectedCity(city);
                    setShowSuggestions(false);
                    onCitySelect(city);
                }}
              className="block w-full px-5 py-3 text-left text-slate-200 hover:bg-white/10"
            >
              {city}
            </button>
          ))}
        </div>
      )}

      {selectedCity && (
        <p className="mt-3 text-sm text-amber-300">
          Exploring {selectedCity}
        </p>
      )}
    </div>
  );
}