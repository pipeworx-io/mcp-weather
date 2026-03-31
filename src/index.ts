interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Weather MCP — wraps Open-Meteo API (free, no auth)
 *
 * Tools:
 * - get_weather: current conditions for a lat/lon
 * - get_forecast: multi-day forecast for a lat/lon
 */


const BASE_URL = 'https://api.open-meteo.com/v1';

const WMO_CODES: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Foggy',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  71: 'Slight snow',
  73: 'Moderate snow',
  75: 'Heavy snow',
  77: 'Snow grains',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  85: 'Slight snow showers',
  86: 'Heavy snow showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};

const tools: McpToolExport['tools'] = [
  {
    name: 'get_weather',
    description:
      'Get current weather conditions for a location. Returns temperature, humidity, wind speed, and conditions.',
    inputSchema: {
      type: 'object',
      properties: {
        latitude: { type: 'number', description: 'Latitude of the location' },
        longitude: { type: 'number', description: 'Longitude of the location' },
      },
      required: ['latitude', 'longitude'],
    },
  },
  {
    name: 'get_forecast',
    description:
      'Get a multi-day weather forecast for a location. Returns daily high/low temperatures, precipitation, and conditions.',
    inputSchema: {
      type: 'object',
      properties: {
        latitude: { type: 'number', description: 'Latitude of the location' },
        longitude: { type: 'number', description: 'Longitude of the location' },
        days: {
          type: 'number',
          description: 'Number of forecast days (1-16, default 7)',
        },
      },
      required: ['latitude', 'longitude'],
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'get_weather':
      return getWeather(args.latitude as number, args.longitude as number);
    case 'get_forecast':
      return getForecast(
        args.latitude as number,
        args.longitude as number,
        (args.days as number) ?? 7,
      );
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function getWeather(lat: number, lon: number) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m,wind_direction_10m',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
  });

  const res = await fetch(`${BASE_URL}/forecast?${params}`);
  if (!res.ok) throw new Error(`Open-Meteo error: ${res.status}`);

  const data = (await res.json()) as {
    current: {
      temperature_2m: number;
      relative_humidity_2m: number;
      apparent_temperature: number;
      weather_code: number;
      wind_speed_10m: number;
      wind_direction_10m: number;
    };
  };

  const c = data.current;
  return {
    temperature_f: c.temperature_2m,
    feels_like_f: c.apparent_temperature,
    humidity_pct: c.relative_humidity_2m,
    conditions: WMO_CODES[c.weather_code] ?? `Code ${c.weather_code}`,
    wind_mph: c.wind_speed_10m,
    wind_direction_deg: c.wind_direction_10m,
  };
}

async function getForecast(lat: number, lon: number, days: number) {
  const forecastDays = Math.min(16, Math.max(1, days));
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    daily: 'temperature_2m_max,temperature_2m_min,precipitation_sum,weather_code',
    temperature_unit: 'fahrenheit',
    forecast_days: String(forecastDays),
  });

  const res = await fetch(`${BASE_URL}/forecast?${params}`);
  if (!res.ok) throw new Error(`Open-Meteo error: ${res.status}`);

  const data = (await res.json()) as {
    daily: {
      time: string[];
      temperature_2m_max: number[];
      temperature_2m_min: number[];
      precipitation_sum: number[];
      weather_code: number[];
    };
  };

  const d = data.daily;
  return {
    days: d.time.map((date, i) => ({
      date,
      high_f: d.temperature_2m_max[i],
      low_f: d.temperature_2m_min[i],
      precipitation_mm: d.precipitation_sum[i],
      conditions: WMO_CODES[d.weather_code[i]] ?? `Code ${d.weather_code[i]}`,
    })),
  };
}

export default { tools, callTool } satisfies McpToolExport;
