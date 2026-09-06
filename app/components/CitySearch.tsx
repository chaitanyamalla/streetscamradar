"use client";

import { useState } from "react";

type CitySearchProps = {
  onCitySelect: (city: string, coordinates: [number, number]) => void;
};

const popularCities = [
  "Barcelona",
  "Berlin",
  "Paris",
  "Milan",
  "Rome",
  "Delhi",
];

export default function CitySearch({ onCitySelect }: CitySearchProps) {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleExplore() {
    const search = query.trim();

    if (!search) return;

    setLoading(true);
    setError("");

    try {
      const response = await fetch(
        `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(search)}`,
      );

      if (!response.ok) {
        throw new Error("Geocoding request failed");
      }

      const results = await response.json();

      if (results.length === 0) {
        setError("Location not found. Try another city.");
        return;
      }

      const result = results[0];

      const coordinates: [number, number] = [
        Number(result.lat),
        Number(result.lon),
      ];

      onCitySelect(result.display_name.split(",")[0], coordinates);
    } catch {
      setError("Could not find this location. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="w-full max-w-2xl">
      <div className="flex w-full flex-col gap-3 sm:flex-row">
        <input
          type="text"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setError("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              handleExplore();
            }
          }}
          placeholder="Where are you going? e.g. Barcelona"
          className="h-14 flex-1 rounded-xl border border-white/10 bg-white/5 px-5 text-white outline-none placeholder:text-slate-500 focus:border-amber-400"
        />

        <button
          type="button"
          onClick={handleExplore}
          disabled={loading}
          className="h-14 rounded-xl bg-amber-400 px-7 font-semibold text-slate-950 hover:bg-amber-300 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {loading ? "Searching..." : "Explore"}
        </button>
      </div>

      {/* Popular destinations */}
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        <span className="mr-1 text-sm text-slate-500">
          Popular destinations:
        </span>

        {popularCities.map((city) => (
          <button
            key={city}
            type="button"
            onClick={() => {
              setQuery(city);
              setError("");
            }}
            className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-slate-300 transition hover:border-amber-400/40 hover:bg-amber-400/10 hover:text-amber-300"
          >
            {city}
          </button>
        ))}
      </div>

      {error && (
        <p className="mt-3 text-left text-sm text-red-400">
          {error}
        </p>
      )}
    </div>
  );
}