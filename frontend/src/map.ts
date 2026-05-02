import maplibregl, { Map as MLMap, MapGeoJSONFeature } from "maplibre-gl";
import type { Station } from "./supabase";

const STYLE_URL = "https://tiles.openfreemap.org/styles/positron";
const GERMANY_CENTER: [number, number] = [10.4515, 51.1657];

const SOURCE_ID = "stations";
const LAYER_ID = "stations-circle";
const SELECTED_SOURCE_ID = "stations-selected";
const SELECTED_LAYER_ID = "stations-selected-halo";
const MIN_ZOOM = 8;

const EMPTY_FC: GeoJSON.FeatureCollection<GeoJSON.Point> = {
  type: "FeatureCollection",
  features: [],
};

export function createMap(container: HTMLElement): MLMap {
  const map = new maplibregl.Map({
    container,
    style: STYLE_URL,
    center: GERMANY_CENTER,
    zoom: 5.4,
    attributionControl: { compact: true },
  });

  map.addControl(
    new maplibregl.NavigationControl({ visualizePitch: false, showCompass: false }),
    "top-right",
  );
  map.addControl(
    new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
    }),
    "top-right",
  );

  return map;
}

export function setSelectedStation(map: MLMap, station: Station | null): void {
  const src = map.getSource(SELECTED_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (!src) return;
  if (!station) {
    src.setData(EMPTY_FC);
    return;
  }
  src.setData({
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        geometry: { type: "Point", coordinates: [station.lng, station.lat] },
        properties: { id: station.id },
      },
    ],
  });
}

export function flyToStation(map: MLMap, s: Station): void {
  const h = map.getContainer().clientHeight;
  // On mobile the bottom sheet covers ~60vh; offset the camera so the station
  // sits in the upper third of the visible map area instead of behind the sheet.
  const isMobile = window.matchMedia("(max-width: 767px)").matches;
  const offsetY = isMobile ? -h / 6 : 0;
  map.flyTo({ center: [s.lng, s.lat], zoom: 13, speed: 1.4, offset: [0, offsetY] });
}

// Module-level so re-rendering for a different day swaps the lookup AND the click target.
let currentById = new Map<string, Station>();
let currentOnSelect: ((s: Station) => void) | null = null;

export function renderStations(
  map: MLMap,
  stations: Station[],
  onSelect: (s: Station) => void,
): void {
  currentById = new Map(stations.map((s) => [s.id, s]));
  currentOnSelect = onSelect;

  const data: GeoJSON.FeatureCollection<GeoJSON.Point> = {
    type: "FeatureCollection",
    features: stations.map((s) => ({
      type: "Feature",
      geometry: { type: "Point", coordinates: [s.lng, s.lat] },
      properties: { id: s.id, is_compliant: s.is_compliant },
    })),
  };

  const existing = map.getSource(SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (existing) {
    existing.setData(data);
    return;
  }

  map.addSource(SOURCE_ID, { type: "geojson", data });
  map.addSource(SELECTED_SOURCE_ID, { type: "geojson", data: EMPTY_FC });

  map.addLayer({
    id: SELECTED_LAYER_ID,
    type: "circle",
    source: SELECTED_SOURCE_ID,
    minzoom: MIN_ZOOM,
    paint: {
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        MIN_ZOOM,
        14,
        14,
        24,
      ],
      "circle-color": "#000000",
      "circle-opacity": 0.1,
      "circle-blur": 0.6,
      "circle-stroke-width": 2,
      "circle-stroke-color": "#000000",
      "circle-stroke-opacity": 0.5,
    },
  });

  map.addLayer({
    id: LAYER_ID,
    type: "circle",
    source: SOURCE_ID,
    minzoom: MIN_ZOOM,
    paint: {
      "circle-radius": [
        "interpolate",
        ["linear"],
        ["zoom"],
        MIN_ZOOM,
        4,
        14,
        7,
      ],
      "circle-color": [
        "case",
        ["get", "is_compliant"],
        "#4ade80",
        "#ef4444",
      ],
      "circle-stroke-width": 1.5,
      "circle-stroke-color": "#0b0d10",
    },
  });

  map.on("click", LAYER_ID, (e) => {
    e.originalEvent.stopPropagation();
    const f = e.features?.[0] as MapGeoJSONFeature | undefined;
    const id = (f?.properties as { id?: string } | undefined)?.id;
    if (!id) return;
    const station = currentById.get(id);
    if (station && currentOnSelect) currentOnSelect(station);
  });

  map.on("mouseenter", LAYER_ID, () => {
    map.getCanvas().style.cursor = "pointer";
  });
  map.on("mouseleave", LAYER_ID, () => {
    map.getCanvas().style.cursor = "";
  });
}
