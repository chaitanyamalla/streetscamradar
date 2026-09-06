"use client";

import { MapContainer, TileLayer, Marker, Popup } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

const markerIcon = L.icon({
  iconUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
  shadowUrl:
    "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
  iconSize: [25, 41],
  iconAnchor: [12, 41],
  popupAnchor: [1, -34],
  shadowSize: [41, 41],
});

const reports = [
  {
    id: 1,
    type: "Pickpocketing",
    location: "La Rambla",
    position: [41.3809, 2.1734] as [number, number],
  },
  {
    id: 2,
    type: "Tourist scam",
    location: "Plaça de Catalunya",
    position: [41.387, 2.1701] as [number, number],
  },
  {
    id: 3,
    type: "Fake taxi",
    location: "Sagrada Família",
    position: [41.4036, 2.1744] as [number, number],
  },
];

export default function Map() {
  return (
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

      {reports.map((report) => (
        <Marker key={report.id} position={report.position} icon={markerIcon}>
          <Popup>
            <strong>{report.type}</strong>
            <br />
            {report.location}
            <br />
            <small>Demo report</small>
          </Popup>
        </Marker>
      ))}
    </MapContainer>
  );
}