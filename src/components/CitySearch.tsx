import React, { useEffect, useRef, useState } from 'react';
import { useMapsLibrary } from '@vis.gl/react-google-maps';
import { Loader2, MapPin, Search, X } from 'lucide-react';
import { GeoOrigin } from '../game/types';

interface CitySearchProps {
  onSelectLocation: (origin: GeoOrigin, label: string) => void;
  disabled?: boolean;
}

interface PredictionItem {
  id: string;
  mainText: string;
  secondaryText: string;
  prediction?: google.maps.places.PlacePrediction;
  fallbackOrigin?: GeoOrigin;
}

export const CitySearch: React.FC<CitySearchProps> = ({ onSelectLocation, disabled }) => {
  const placesLib = useMapsLibrary('places');
  const [query, setQuery] = useState('');
  const [predictions, setPredictions] = useState<PredictionItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const sessionTokenRef = useRef<google.maps.places.AutocompleteSessionToken | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) {
      setPredictions([]);
      return;
    }

    let cancelled = false;
    const abortCtrl = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        setLoading(true);
        let items: PredictionItem[] = [];

        if (placesLib?.AutocompleteSuggestion) {
          try {
            if (!sessionTokenRef.current) {
              sessionTokenRef.current = new placesLib.AutocompleteSessionToken();
            }
            const { suggestions } = await placesLib.AutocompleteSuggestion.fetchAutocompleteSuggestions({
              input: trimmed,
              sessionToken: sessionTokenRef.current,
            });
            if (cancelled) return;
            for (const s of suggestions) {
              const pred = s.placePrediction;
              if (!pred) continue;
              items.push({
                id: pred.placeId,
                mainText: pred.mainText?.text || pred.text.text,
                secondaryText: pred.secondaryText?.text || '',
                prediction: pred,
              });
            }
          } catch {
            // Silent fallback to OpenStreetMap Nominatim below
          }
        }

        if (items.length === 0 && !cancelled) {
          const resp = await fetch(
            `https://nominatim.openstreetmap.org/search?format=json&limit=5&addressdetails=1&q=${encodeURIComponent(trimmed)}`,
            {
              signal: abortCtrl.signal,
              headers: { 'Accept-Language': 'tr,en' },
            }
          );
          if (resp.ok && !cancelled) {
            const rows = (await resp.json().catch(() => [])) as Array<{
              place_id?: number | string;
              display_name?: string;
              name?: string;
              lat?: string;
              lon?: string;
            }>;
            for (const row of rows) {
              const lat = Number(row.lat);
              const lng = Number(row.lon);
              if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
              const full = row.display_name || trimmed;
              const parts = full.split(',').map((p) => p.trim()).filter(Boolean);
              const mainText = row.name || parts[0] || full;
              const secondaryText = parts.slice(1, 4).join(', ');
              items.push({
                id: `osm-${row.place_id ?? `${lat},${lng}`}`,
                mainText,
                secondaryText,
                fallbackOrigin: { lat, lng },
              });
            }
          }
        }

        if (!cancelled) {
          setPredictions(items);
          setOpen(items.length > 0);
        }
      } catch {
        if (!cancelled) {
          setPredictions([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 260);

    return () => {
      cancelled = true;
      abortCtrl.abort();
      window.clearTimeout(timer);
    };
  }, [placesLib, query]);

  const handlePick = async (item: PredictionItem) => {
    if (item.fallbackOrigin) {
      const label = item.mainText || query;
      onSelectLocation(item.fallbackOrigin, label);
      setQuery(label);
      setOpen(false);
      return;
    }
    if (!item.prediction) return;
    try {
      setLoading(true);
      const place = item.prediction.toPlace();
      await place.fetchFields({ fields: ['displayName', 'formattedAddress', 'location'] });
      const loc = place.location;
      if (loc) {
        const label = place.displayName || item.mainText || place.formattedAddress || query;
        onSelectLocation({ lat: loc.lat(), lng: loc.lng() }, label);
        setQuery(label);
        setOpen(false);
        sessionTokenRef.current = null;
      }
    } catch {
      // ignore failed field fetch
    } finally {
      setLoading(false);
    }
  };

  return (
    <div ref={containerRef} className="relative">
      <div className="flex items-center bg-[#090d14] border border-slate-700/80 focus-within:border-amber-500/80 rounded-md px-2.5 py-1.5 gap-2 transition-colors">
        <Search className="w-3.5 h-3.5 text-amber-400 shrink-0" />
        <input
          type="text"
          value={query}
          disabled={disabled}
          onFocus={() => {
            if (predictions.length > 0) setOpen(true);
          }}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Dünya haritasında ilçe / semt / sokak ara..."
          className="w-full bg-transparent text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none disabled:opacity-50"
        />
        {loading ? (
          <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin shrink-0" />
        ) : query.length > 0 ? (
          <button
            type="button"
            onClick={() => {
              setQuery('');
              setPredictions([]);
              setOpen(false);
            }}
            aria-label="Aramayı temizle"
            className="text-slate-500 hover:text-slate-200 cursor-pointer shrink-0"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        ) : null}
      </div>

      {open && predictions.length > 0 && (
        <ul className="absolute left-0 right-0 mt-1 max-h-52 overflow-y-auto bg-[#0c121d] border border-slate-700 rounded-md shadow-2xl z-40 divide-y divide-slate-800/80">
          {predictions.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                onClick={() => handlePick(item)}
                className="w-full text-left px-3 py-2 hover:bg-slate-800/80 flex items-start gap-2 cursor-pointer transition-colors"
              >
                <MapPin className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <div className="text-xs font-medium text-slate-100 truncate">{item.mainText}</div>
                  {item.secondaryText && (
                    <div className="text-[10px] text-slate-400 truncate">{item.secondaryText}</div>
                  )}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
