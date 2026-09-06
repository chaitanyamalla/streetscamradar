"use client";

import {
  MapContainer,
  TileLayer,
  Marker,
  Popup,
  useMap,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

const markerIcons = {
  pickpocketing: L.divIcon({
    className: "",
    html: `<div style="
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: #dc2626;
      border: 3px solid white;
      box-shadow: 0 2px 6px rgba(0,0,0,0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
    ">👛</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  }),

  touristScam: L.divIcon({
    className: "",
    html: `<div style="
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: #f97316;
      border: 3px solid white;
      box-shadow: 0 2px 6px rgba(0,0,0,0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
    ">⚠️</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  }),

  fakeTaxi: L.divIcon({
    className: "",
    html: `<div style="
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: #2563eb;
      border: 3px solid white;
      box-shadow: 0 2px 6px rgba(0,0,0,0.35);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 16px;
    ">🚕</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  }),
};

const reports = [
  {
    id: 1,
    city: "Barcelona",
    type: "Pickpocketing",
    category: "pickpocketing" as const,
    location: "La Rambla",
    position: [41.3809, 2.1734] as [number, number],
    reported: "2 hours ago",
    risk: "High",
    tactic: "Distraction while taking belongings",
    source: "Community report",
  },
  {
    id: 2,
    city: "Barcelona",
    type: "Tourist scam",
    category: "touristScam" as const,
    location: "Plaça de Catalunya",
    position: [41.387, 2.1701] as [number, number],
    reported: "5 hours ago",
    risk: "Medium",
    tactic: "Unofficial charity or petition request",
    source: "Community report",
  },
  {
    id: 3,
    city: "Barcelona",
    type: "Fake taxi",
    category: "fakeTaxi" as const,
    location: "Sagrada Família",
    position: [41.4036, 2.1744] as [number, number],
    reported: "Yesterday",
    risk: "Medium",
    tactic: "Unlicensed taxi offering inflated fares",
    source: "Community report",
  },
  {
    id: 4,
    city: "Berlin",
    type: "Pickpocketing",
    category: "pickpocketing" as const,
    location: "Alexanderplatz",
    position: [52.5219, 13.4132] as [number, number],
    reported: "1 hour ago",
    risk: "High",
    tactic: "Distraction in crowded areas",
    source: "Community report",
  },
  {
    id: 5,
    city: "Berlin",
    type: "Tourist scam",
    category: "touristScam" as const,
    location: "Brandenburg Gate",
    position: [52.5163, 13.3777] as [number, number],
    reported: "3 hours ago",
    risk: "Medium",
    tactic: "Aggressive solicitation targeting tourists",
    source: "Community report",
  },
];

function MapController({ city }: { city: string }) {
  const map = useMap();

  if (city === "Barcelona") {
    map.setView([41.3874, 2.1686], 13);
  }

  if (city === "Berlin") {
    map.setView([52.52, 13.405], 12);
  }

  return null;
}

export default function Map({ city }: { city: string }) {
  return (
    <div className="relative h-full w-full">
      <MapContainer
        center={[41.3874, 2.1686]}
        zoom={13}
        scrollWheelZoom={true}
        className="h-full w-full"
      >
        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        <MapController city={city} />       
        {reports
            .filter((report) => report.city === city)
            .map((report) => (
          <Marker
            key={report.id}
            position={report.position}
            icon={markerIcons[report.category]}
          >
            <Popup>
                <div className="min-w-[220px]">
                    <div className="mb-2 text-base font-bold text-slate-900">
                    {report.type}
                    </div>

                    <div className="mb-3 text-sm text-slate-600">
                    📍 {report.location}
                    </div>

                    <div className="space-y-2 text-sm">
                    <div>
                        <strong>Risk:</strong> {report.risk}
                    </div>

                    <div>
                        <strong>Reported:</strong> {report.reported}
                    </div>

                    <div>
                        <strong>Common tactic:</strong>
                        <br />
                        {report.tactic}
                    </div>

                    <div className="border-t border-slate-200 pt-2 text-xs text-slate-500">
                        Source: {report.source}
                    </div>
                    </div>
                </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>

      {/* Map legend */}
      <div className="absolute bottom-4 left-4 z-[1000] rounded-lg bg-white p-3 text-sm shadow-lg">
        <div className="mb-2 font-semibold text-slate-800">
          Report types
        </div>

        <div className="flex items-center gap-2 text-slate-700">
          <span>👛</span>
          <span>Pickpocketing</span>
        </div>

        <div className="flex items-center gap-2 text-slate-700">
          <span>⚠️</span>
          <span>Tourist scam</span>
        </div>

        <div className="flex items-center gap-2 text-slate-700">
          <span>🚕</span>
          <span>Fake taxi</span>
        </div>
      </div>
    </div>
  );
}