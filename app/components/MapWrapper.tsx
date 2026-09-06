"use client";

import dynamic from "next/dynamic";

const Map = dynamic(() => import("./Map"), {
  ssr: false,
});

export default function MapWrapper({
  city,
  coordinates,
}: {
  city: string;
  coordinates: [number, number];
}) {
  return <Map city={city} coordinates={coordinates} />;
}